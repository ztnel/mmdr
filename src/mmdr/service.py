"""Review lifecycle shared by the CLI and MCP, with explicit workspace grants."""

from __future__ import annotations

import asyncio
import threading
import time
import webbrowser
from pathlib import Path

from platformdirs import user_state_path

from .errors import UsageError
from .server import ReviewServer
from .store import Store


def state_directory() -> Path:
    return user_state_path("mmdr", appauthor=False)


class Reviews:
    def __init__(self, state_dir: Path, workspaces: list[Path]):
        self.store = Store(state_dir / "reviews.sqlite3")
        self.workspaces = tuple(self.workspace(path) for path in workspaces)
        self.servers: dict[str, tuple[ReviewServer, threading.Thread]] = {}
        self.allowed_sessions: set[str] = set()
        self.lock = threading.RLock()

    def require(self, session: str) -> ReviewServer:
        with self.lock:
            if session not in self.allowed_sessions:
                raise UsageError("open this review in the current connection before accessing it")
            return self.servers[session][0]

    @staticmethod
    def workspace(path: Path) -> Path:
        try:
            root = path.expanduser().resolve(strict=True)
        except OSError as exc:
            raise UsageError(f"workspace is unavailable: {path}") from exc
        if not root.is_dir():
            raise UsageError("workspace must be an existing directory")
        return root

    def open(
        self, source: str, block: str | None = None, browser: bool = True,
        workspace: str | None = None,
    ) -> dict:
        roots = self.workspaces
        if workspace is not None:
            granted = self.workspace(Path(workspace))
            if roots and granted not in roots:
                raise UsageError("tool workspace cannot widen configured startup grants")
            roots = (granted,)
        if not roots:
            raise UsageError("provide an explicit workspace authorized by the human")
        path = Path(source).expanduser()
        if not path.is_absolute():
            if len(roots) != 1:
                raise UsageError("use an absolute source path with multiple workspaces")
            path = roots[0] / path
        path = path.resolve()
        root = next((root for root in roots if path.is_relative_to(root)), None)
        if root is None:
            raise UsageError("source is outside the configured workspace grants")
        with self.lock:
            session = self.store.register(root, path, block)
            if session not in self.servers:
                server = ReviewServer(self.store, session)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                self.servers[session] = server, thread
            server = self.servers[session][0]
            self.allowed_sessions.add(session)
        url = server.origin + "/#" + server.token
        opened = webbrowser.open(url) if browser else False
        return {
            "session_id": session, "url": url, "browser_opened": opened,
            "workspace": str(root),
            "browser_error": "browser could not be opened; use the local URL" if browser and not opened else "",
            "transport": "MCP wait; no automatic wake injection",
        }

    def read(self, session: str) -> dict:
        self.require(session)
        return {"review": self.store.state(session), "pending": self.store.pending(session)}

    def reply(self, session: str, message: str, content: str, author: str) -> dict:
        self.require(session)
        state = self.store.state(session)
        if not any(item["id"] == message and item["role"] == "human"
                   for thread in state["threads"] for item in thread["messages"]):
            raise UsageError("reply must reference a human message in this review")
        return self.store.message(session, content, "agent", author, parent=message)

    async def wait(self, session: str, timeout: int = 120) -> dict:
        server = self.require(session)
        if not 1 <= timeout <= 300:
            raise UsageError("timeout must be between 1 and 300 seconds")
        with server.feedback_lock:
            server.feedback_waiters += 1
        try:
            deadline = time.monotonic() + timeout
            while True:
                self.require(session)
                if self.store.record(session)["closed"]:
                    return {"status": "closed", "pending": []}
                pending = self.store.pending(session)
                if pending:
                    return {"status": "feedback", "pending": pending}
                if time.monotonic() >= deadline:
                    return {"status": "timeout", "pending": []}
                await asyncio.sleep(.25)
        finally:
            with server.feedback_lock:
                server.feedback_waiters -= 1

    def close(self, session: str) -> dict:
        self.require(session)
        self.store.close(session)
        return {"closed": True, "approval": False}

    def shutdown(self) -> None:
        with self.lock:
            servers = list(self.servers.values())
            self.allowed_sessions.clear()
        for server, thread in servers:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

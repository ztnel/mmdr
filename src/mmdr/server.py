"""Loopback-only capability-protected HTTP surface."""

from __future__ import annotations

import hmac
import json
import mimetypes
import secrets
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from .errors import UsageError
from .store import Store

ASSETS = Path(__file__).resolve().parent / "assets"
MAX_REQUEST = 2 * 1024 * 1024


class ReviewServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, store: Store, session: str, port: int = 0):
        self.store, self.session = store, session
        self.token = secrets.token_urlsafe(32)
        self.instance = secrets.token_hex(16)
        self.feedback_waiters = 0
        self.feedback_lock = threading.Lock()
        super().__init__(("127.0.0.1", port), Handler)
        self.origin = f"http://127.0.0.1:{self.server_port}"

    def feedback_status(self) -> tuple[bool, str]:
        with self.feedback_lock:
            online = self.feedback_waiters > 0
        return online, "agent waiting via MCP" if online else "no agent waiting"


class Handler(BaseHTTPRequestHandler):
    server: ReviewServer

    def log_message(self, fmt, *args):
        if args and str(args[1] if len(args) > 1 else "").startswith(("4", "5")):
            super().log_message(fmt, *args)

    def send(self, code: int, data: bytes, kind: str = "application/json"):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; font-src 'self'; connect-src 'self'; "
            "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        )
        self.end_headers()
        self.wfile.write(data)

    def json(self, code: int, payload: dict):
        self.send(code, json.dumps(payload).encode())

    def allowed(self, *, auth: bool = True) -> bool:
        if self.headers.get("Host") != urlsplit(self.server.origin).netloc:
            self.json(403, {"error": "invalid Host"})
            return False
        origin = self.headers.get("Origin")
        if origin and origin != self.server.origin:
            self.json(403, {"error": "invalid Origin"})
            return False
        if auth and not hmac.compare_digest(
            self.headers.get("X-Review-Token", ""), self.server.token
        ):
            self.json(403, {"error": "invalid review capability"})
            return False
        return True

    def do_GET(self):
        route = urlsplit(self.path).path
        if not self.allowed(auth=route.startswith("/api/")):
            return
        if route == "/health":
            self.json(200, {"instance": self.server.instance, "session": self.server.session})
        elif route == "/api/state":
            try:
                state = self.server.store.state(self.server.session)
                state["agent_online"], state["agent_status"] = self.server.feedback_status()
                self.json(200, state)
            except (UsageError, OSError, sqlite3.Error) as exc:
                self.json(400, {"error": str(exc)})
        elif route == "/":
            self.send(200, (ASSETS / "index.html").read_bytes(), "text/html; charset=utf-8")
        else:
            allowed = {"/app.js", "/style.css", "/anchors.js", "/vendor/mermaid.js"}
            if route not in allowed:
                self.json(404, {"error": "not found"})
                return
            target = ASSETS / route.lstrip("/")
            self.send(200, target.read_bytes(), mimetypes.guess_type(target.name)[0] or "text/plain")

    def do_POST(self):
        if not self.allowed():
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_REQUEST:
                raise UsageError("invalid request size")
            if self.headers.get("Content-Type") != "application/json":
                raise UsageError("JSON content type required")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise UsageError("request must be an object")
            store, session = self.server.store, self.server.session
            route = urlsplit(self.path).path
            if route == "/api/anchors":
                store.anchors(session, body["revision"], body["anchors"])
                result = {}
            elif route == "/api/message":
                result = store.message(
                    session, body["content"], "human", "Reviewer",
                    anchor=body.get("anchor", "diagram"), revision=body.get("revision", ""),
                    parent=body.get("parent"),
                )
            elif route == "/api/resolve":
                if not isinstance(body["resolved"], bool):
                    raise UsageError("resolved must be boolean")
                store.resolve(session, body["thread"], body["resolved"])
                result = {}
            elif route == "/api/reattach":
                store.reattach(session, body["thread"], body["anchor"])
                result = {}
            elif route == "/api/close":
                store.close(session)
                result = {"closed": True}
            elif route == "/api/stop":
                store.close(session)
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                result = {"stopped": True}
            else:
                self.json(404, {"error": "unknown operation"})
                return
            self.json(200, result)
        except (UsageError, ValueError, TypeError, KeyError, AttributeError, OSError, sqlite3.Error) as exc:
            self.json(400, {"error": str(exc)})

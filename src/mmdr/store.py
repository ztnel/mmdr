"""Transactional local review sessions, anchors, and explicit comment threads."""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from contextlib import closing, contextmanager
from pathlib import Path
from .errors import UsageError
from .sources import diagrams, digest

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions(
 id TEXT PRIMARY KEY, workspace TEXT NOT NULL, source TEXT NOT NULL, block TEXT NOT NULL,
 closed INTEGER NOT NULL DEFAULT 0, revision TEXT NOT NULL DEFAULT '',
 anchors TEXT NOT NULL DEFAULT '[]',
 UNIQUE(workspace, source, block));
CREATE TABLE IF NOT EXISTS threads(
 id TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES sessions(id),
 anchor TEXT NOT NULL, revision TEXT NOT NULL, label TEXT NOT NULL,
 resolved INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS messages(
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
 thread TEXT NOT NULL REFERENCES threads(id), parent TEXT REFERENCES messages(id),
 role TEXT NOT NULL, author TEXT NOT NULL, content TEXT NOT NULL, created REAL NOT NULL);
"""


class Store:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.parent.chmod(0o700)
        with self.db() as db:
            db.executescript(SCHEMA)
        path.chmod(0o600)

    @contextmanager
    def db(self):
        with closing(sqlite3.connect(self.path, timeout=10)) as db:
            with db:
                db.row_factory = sqlite3.Row
                db.execute("PRAGMA foreign_keys=ON")
                yield db

    def register(self, workspace: Path, source: Path, block: str | None) -> str:
        workspace, source = workspace.resolve(), source.resolve()
        if not source.is_relative_to(workspace):
            raise UsageError("diagram source must be inside the workspace")
        options = diagrams(source)
        if block is None and len(options) != 1:
            raise UsageError("choose --block from: " + ", ".join(options))
        block = block or next(iter(options))
        if block not in options:
            raise UsageError("unknown diagram block; choose from: " + ", ".join(options))
        with self.db() as db:
            row = db.execute(
                "SELECT id FROM sessions WHERE workspace=? AND source=? AND block=?",
                (str(workspace), str(source), block),
            ).fetchone()
            if row:
                db.execute("UPDATE sessions SET closed=0 WHERE id=?", (row["id"],))
                return row["id"]
            session = uuid.uuid4().hex
            db.execute(
                "INSERT INTO sessions(id,workspace,source,block) VALUES(?,?,?,?)",
                (session, str(workspace), str(source), block),
            )
            return session

    def record(self, session: str) -> dict:
        with self.db() as db:
            row = db.execute("SELECT * FROM sessions WHERE id=?", (session,)).fetchone()
        if row is None:
            raise UsageError("unknown review session")
        return dict(row)

    def list(self) -> list[dict]:
        with self.db() as db:
            return [dict(row) for row in db.execute("SELECT * FROM sessions ORDER BY rowid DESC")]

    def state(self, session: str) -> dict:
        record = self.record(session)
        source = Path(record["source"])
        if not source.resolve().is_relative_to(Path(record["workspace"])):
            raise UsageError("registered source escaped workspace")
        try:
            options = diagrams(source)
            if record["block"] not in options:
                raise UsageError("diagram block removed or renamed; original threads are retained")
            text = options[record["block"]]
            record.update(content=text, current_revision=digest(text), source_error="")
        except (UsageError, OSError, UnicodeError) as exc:
            record.update(content="", current_revision="", source_error=str(exc))
        record["anchors"] = json.loads(record["anchors"])
        with self.db() as db:
            threads = [dict(row) for row in db.execute("SELECT * FROM threads WHERE session=?", (session,))]
            for thread in threads:
                thread["messages"] = [dict(row) for row in db.execute(
                    "SELECT * FROM messages WHERE thread=? ORDER BY seq", (thread["id"],)
                )]
                thread["orphaned"] = thread["anchor"] != "diagram" and not any(
                    anchor["key"] == thread["anchor"] for anchor in record["anchors"]
                )
        record["threads"] = threads
        return record

    def anchors(self, session: str, revision: str, anchors: list[dict]) -> None:
        if revision != self.state(session)["current_revision"]:
            raise UsageError("source changed during render; render the current revision")
        if not revision:
            raise UsageError("cannot register anchors for an invalid source")
        if not isinstance(anchors, list) or len(anchors) > 10000:
            raise UsageError("invalid or excessive anchors")
        keys = set()
        for anchor in anchors:
            if not isinstance(anchor, dict) or set(anchor) != {"key", "label", "stable"}:
                raise UsageError("invalid anchor shape")
            if not isinstance(anchor["key"], str) or not isinstance(anchor["label"], str):
                raise UsageError("invalid anchor text")
            if len(anchor["key"]) > 500 or len(anchor["label"]) > 500:
                raise UsageError("anchor exceeds text limit")
            if anchor["key"] in keys or not isinstance(anchor["stable"], bool):
                raise UsageError("duplicate or invalid anchor")
            keys.add(anchor["key"])
        with self.db() as db:
            db.execute("UPDATE sessions SET revision=?,anchors=? WHERE id=?",
                       (revision, json.dumps(anchors), session))

    def message(
        self, session: str, content: str, role: str, author: str, *,
        anchor: str = "diagram", revision: str = "", parent: str | None = None,
    ) -> dict:
        if role not in {"human", "agent"} or not author.strip() or len(author) > 100:
            raise UsageError("message requires a human/agent role and author")
        if not content.strip() or len(content) > 1500:
            raise UsageError("comment must contain 1–1500 characters")
        state = self.state(session)
        if state["closed"]:
            raise UsageError("review is closed; reopen before commenting")
        if not parent and (not revision or revision != state["current_revision"]):
            raise UsageError("source changed; refresh before commenting")
        with self.db() as db:
            if parent:
                row = db.execute(
                    "SELECT m.thread,t.session FROM messages m JOIN threads t ON t.id=m.thread WHERE m.id=?",
                    (parent,),
                ).fetchone()
                if row is None or row["session"] != session:
                    raise UsageError("parent message is not in this review")
                thread = row["thread"]
                db.execute("UPDATE threads SET resolved=0 WHERE id=?", (thread,))
            else:
                label = "Whole diagram"
                if anchor != "diagram":
                    found = next((item for item in state["anchors"] if item["key"] == anchor), None)
                    if found is None or state["revision"] != revision:
                        raise UsageError("anchor is not registered for the current rendered revision")
                    label = found["label"]
                thread = uuid.uuid4().hex
                db.execute("INSERT INTO threads(id,session,anchor,revision,label) VALUES(?,?,?,?,?)",
                           (thread, session, anchor, revision, label))
            message = uuid.uuid4().hex
            db.execute("INSERT INTO messages(id,thread,parent,role,author,content,created) VALUES(?,?,?,?,?,?,?)",
                       (message, thread, parent, role, author, content.strip(), time.time()))
        return {"id": message, "thread": thread}

    def resolve(self, session: str, thread: str, resolved: bool) -> None:
        with self.db() as db:
            result = db.execute("UPDATE threads SET resolved=? WHERE id=? AND session=?",
                                (int(resolved), thread, session))
            if not result.rowcount:
                raise UsageError("unknown thread in review")

    def reattach(self, session: str, thread: str, anchor: str) -> None:
        state = self.state(session)
        match = next((item for item in state["anchors"] if item["key"] == anchor), None)
        if match is None or state["revision"] != state["current_revision"]:
            raise UsageError("select a current rendered element")
        with self.db() as db:
            result = db.execute(
                "UPDATE threads SET anchor=?,revision=?,label=? WHERE id=? AND session=?",
                (anchor, state["revision"], match["label"], thread, session),
            )
            if not result.rowcount:
                raise UsageError("unknown thread in review")

    def close(self, session: str) -> None:
        with self.db() as db:
            if not db.execute("UPDATE sessions SET closed=1 WHERE id=?", (session,)).rowcount:
                raise UsageError("unknown review session")

    def pending(self, session: str) -> list[dict]:
        self.record(session)
        with self.db() as db:
            rows = db.execute("""
                SELECT m.* FROM messages m JOIN threads t ON m.thread=t.id
                JOIN sessions s ON s.id=t.session
                WHERE s.id=? AND s.closed=0 AND t.resolved=0 AND m.role='human'
                AND NOT EXISTS(
                  SELECT 1 FROM messages response
                  WHERE response.thread=m.thread AND response.role='agent' AND response.seq>m.seq)
                ORDER BY m.seq
            """, (session,))
            return [dict(row) for row in rows]

#!/usr/bin/env python3
"""HTTP, source identity, and persistence coverage."""

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from mmdr.errors import UsageError
from mmdr.server import ReviewServer
from mmdr.sources import diagrams
from mmdr.store import Store


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "example.mmd"
        self.source.write_text("flowchart TD\nA --> B")
        self.store = Store(self.root / "state" / "store.sqlite3")
        self.session = self.store.register(self.root, self.source, None)

    def tearDown(self):
        self.temp.cleanup()

    def test_reuse_and_restart_preserve_threads(self):
        revision = self.store.state(self.session)["current_revision"]
        root = self.store.message(self.session, "Question", "human", "Reviewer", revision=revision)
        self.assertEqual(self.session, self.store.register(self.root, self.source, None))
        reopened = Store(self.store.path)
        self.assertEqual(reopened.pending(self.session)[0]["id"], root["id"])
        reply = reopened.message(self.session, "Answer", "agent", "test-agent", parent=root["id"])
        self.assertEqual(reopened.pending(self.session), [])
        reopened.message(self.session, "Follow-up", "human", "Reviewer", parent=reply["id"])
        self.assertEqual(len(reopened.pending(self.session)), 1)
        reopened.resolve(self.session, root["thread"], True)
        self.assertEqual(reopened.pending(self.session), [])
        reopened.resolve(self.session, root["thread"], False)
        self.assertEqual(len(reopened.pending(self.session)), 1)

    def test_anchor_registration_stale_requests_and_orphans(self):
        revision = self.store.state(self.session)["current_revision"]
        self.store.anchors(self.session, revision, [{"key": "A", "label": "Alpha", "stable": True}])
        self.store.message(self.session, "Question", "human", "Reviewer", anchor="A", revision=revision)
        self.source.write_text("flowchart TD\nB --> C")
        with self.assertRaises(UsageError):
            self.store.anchors(self.session, revision, [])
        next_revision = self.store.state(self.session)["current_revision"]
        self.store.anchors(self.session, next_revision, [{"key": "B", "label": "Beta", "stable": True}])
        thread = self.store.state(self.session)["threads"][0]
        self.assertTrue(thread["orphaned"])
        self.store.reattach(self.session, thread["id"], "B")
        self.assertFalse(self.store.state(self.session)["threads"][0]["orphaned"])

    def test_removed_source_keeps_threads_readable_and_replyable(self):
        revision = self.store.state(self.session)["current_revision"]
        message = self.store.message(self.session, "Question", "human", "Reviewer", revision=revision)
        self.source.unlink()
        self.assertTrue(self.store.state(self.session)["source_error"])
        self.store.message(self.session, "Still answerable", "agent", "test", parent=message["id"])
        self.assertEqual(len(self.store.state(self.session)["threads"]), 1)

    def test_markdown_identity_survives_block_insertion(self):
        path = self.root / "diagrams.md"
        path.write_text("# First\n```mermaid\nflowchart TD\nA --> B\n```\n")
        session = self.store.register(self.root, path, "First")
        path.write_text("# New\n```mermaid\npie\n\"item\": 1\n```\n" + path.read_text())
        self.assertIn("A --> B", self.store.state(session)["content"])
        with self.assertRaises(UsageError):
            self.store.register(self.root, path, None)
        path.write_text("```mermaid\nflowchart TD\nA --> B\n```\n```mermaid\npie\n\"a\": 1\n```")
        with self.assertRaises(UsageError):
            diagrams(path)

    def test_cross_session_reply_and_path_escape_are_rejected(self):
        revision = self.store.state(self.session)["current_revision"]
        message = self.store.message(self.session, "Question", "human", "Reviewer", revision=revision)
        other = self.root / "other.mmd"
        other.write_text("pie\n\"x\": 1")
        session = self.store.register(self.root, other, None)
        with self.assertRaises(UsageError):
            self.store.message(session, "wrong", "agent", "test", parent=message["id"])
        with self.assertRaises(UsageError):
            self.store.register(self.root / "narrower", self.source, None)

    def test_concurrent_messages_keep_unique_order_and_closed_reviews_reject_edits(self):
        revision = self.store.state(self.session)["current_revision"]
        def post(index):
            return self.store.message(
                self.session, f"Question {index}", "human", "Reviewer", revision=revision,
            )
        with ThreadPoolExecutor(max_workers=8) as pool:
            messages = list(pool.map(post, range(24)))
        pending = self.store.pending(self.session)
        self.assertEqual(len({item["id"] for item in messages}), 24)
        self.assertEqual(len({item["seq"] for item in pending}), 24)
        self.assertEqual([item["seq"] for item in pending], sorted(item["seq"] for item in pending))
        self.store.close(self.session)
        self.assertEqual(self.store.pending(self.session), [])
        with self.assertRaises(UsageError):
            post(25)
        self.store.register(self.root, self.source, None)
        self.assertEqual(len(self.store.pending(self.session)), 24)

    def test_http_capabilities_origins_validation_and_shutdown(self):
        server = ReviewServer(self.store, self.session)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        def request(route, data=None, **headers):
            request = urllib.request.Request(
                server.origin + route, data=json.dumps(data).encode() if data is not None else None,
                headers={"Content-Type": "application/json", **headers},
            )
            return urllib.request.urlopen(request, timeout=3)
        try:
            with self.assertRaises(urllib.error.HTTPError) as failed:
                request("/api/state")
            self.assertEqual(failed.exception.code, 403)
            with self.assertRaises(urllib.error.HTTPError):
                request("/api/state", **{"X-Review-Token": server.token, "Origin": "http://attacker"})
            with self.assertRaises(urllib.error.HTTPError):
                request("/api/state", **{"Host": "attacker", "X-Review-Token": server.token})
            with request("/api/state", **{"X-Review-Token": server.token}) as response:
                self.assertEqual(json.load(response)["id"], self.session)
            with self.assertRaises(urllib.error.HTTPError):
                request("/api/message", {"content": ""}, **{"X-Review-Token": server.token})
            with self.assertRaises(urllib.error.HTTPError):
                request("/../store.py")
            with request("/api/stop", {}, **{"X-Review-Token": server.token}) as response:
                self.assertTrue(json.load(response)["stopped"])
            thread.join(3)
            self.assertFalse(thread.is_alive())
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()

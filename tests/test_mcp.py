import asyncio
import json
import sys
import urllib.request

import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.types import (
    ClientNotification, CancelledNotification, CancelledNotificationParams, JSONRPCRequest,
)

from mmdr.errors import UsageError
from mmdr.service import Reviews
from mmdr.store import Store


class RecordingWriter:
    def __init__(self, stream):
        self.stream = stream
        self.requests = []

    async def send(self, message):
        request = message.message.root
        if isinstance(request, JSONRPCRequest):
            self.requests.append(request)
        await self.stream.send(message)

    async def __aenter__(self):
        await self.stream.__aenter__()
        return self

    async def __aexit__(self, *arguments):
        return await self.stream.__aexit__(*arguments)


def http_state(opened):
    origin, token = opened["url"].split("/#")
    request = urllib.request.Request(
        origin + "/api/state", headers={"X-Review-Token": token},
    )
    with urllib.request.urlopen(request, timeout=3) as response:
        return json.load(response)


async def wait_health(opened, online):
    async with asyncio.timeout(3):
        while http_state(opened)["agent_online"] is not online:
            await asyncio.sleep(.05)


def test_explicit_workspace_and_fixed_allowlist(tmp_path):
    source = tmp_path / "diagram.mmd"
    source.write_text("flowchart LR\nA --> B", encoding="utf-8")
    reviews = Reviews(tmp_path / "state", [])
    try:
        with pytest.raises(UsageError, match="explicit workspace"):
            reviews.open(str(source), browser=False)
        opened = reviews.open("diagram.mmd", browser=False, workspace=str(tmp_path))
        assert opened["workspace"] == str(tmp_path.resolve())
        assert reviews.read(opened["session_id"])["pending"] == []
    finally:
        reviews.shutdown()
    fixed = Reviews(tmp_path / "state", [tmp_path])
    try:
        with pytest.raises(UsageError, match="cannot widen"):
            fixed.open(str(source), browser=False, workspace=str(tmp_path.parent))
        with pytest.raises(UsageError, match="current connection"):
            fixed.read(opened["session_id"])
        restored = fixed.open(str(source), browser=False)
        assert restored["session_id"] == opened["session_id"]
    finally:
        servers = list(fixed.servers.values())
        fixed.shutdown()
    assert all(not thread.is_alive() for _, thread in servers)


def test_grants_session_access_and_waiter_health(tmp_path):
    source = tmp_path / "diagram.mmd"
    source.write_text("flowchart LR\nA --> B", encoding="utf-8")
    reviews = Reviews(tmp_path / "state", [tmp_path])
    try:
        with pytest.raises(UsageError):
            reviews.open(str(tmp_path.parent / "outside.mmd"), browser=False)
        result = reviews.open(str(source), browser=False)
        session = result["session_id"]
        assert reviews.open(str(source), browser=False)["url"] == result["url"]
        assert len(reviews.servers) == 1
        with pytest.raises(UsageError):
            reviews.read("unopened")
        async def cancel():
            task = asyncio.create_task(reviews.wait(session, 20))
            await asyncio.sleep(.1)
            assert reviews.require(session).feedback_status()[0]
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert not reviews.require(session).feedback_status()[0]
            for timeout in (0, 301):
                with pytest.raises(UsageError):
                    await reviews.wait(session, timeout)
        asyncio.run(cancel())
    finally:
        reviews.shutdown()


def test_real_stdio_protocol(tmp_path):
    source = tmp_path / "diagram.mmd"
    source.write_text("flowchart LR\nA --> B", encoding="utf-8")
    state = tmp_path / "state"
    async def run():
        params = StdioServerParameters(command=sys.executable, args=[
            "-c", "from mmdr.mcp_server import main; main()",
            "--workspace", str(tmp_path), "--state-dir", str(state),
        ])
        async with stdio_client(params) as (read, write):
            recording = RecordingWriter(write)
            async with ClientSession(read, recording) as client:
                await client.initialize()
                tools = await client.list_tools()
                assert {tool.name for tool in tools.tools} == {
                    "open_review", "read_comments", "reply", "wait_for_feedback", "close_review",
                }
                async def call(name, **arguments):
                    result = await client.call_tool(name, arguments)
                    assert not result.isError, result
                    return json.loads(result.content[0].text)
                opened = await call("open_review", source=str(source), open_browser=False)
                session = opened["session_id"]
                assert (await call("wait_for_feedback", session_id=session, timeout_seconds=1))["status"] == "timeout"
                task = asyncio.create_task(client.call_tool("wait_for_feedback", {
                    "session_id": session, "timeout_seconds": 30,
                }))
                await wait_health(opened, True)
                request_id = recording.requests[-1].id
                await client.send_notification(ClientNotification(CancelledNotification(
                    params=CancelledNotificationParams(requestId=request_id, reason="test"),
                )))
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
                await wait_health(opened, False)
                context = await call("read_comments", session_id=session)
                store = Store(state / "reviews.sqlite3")
                message = store.message(session, "Question", "human", "Tester",
                                        revision=context["review"]["current_revision"])
                feedback = await call("wait_for_feedback", session_id=session, timeout_seconds=2)
                assert feedback["pending"][0]["id"] == message["id"]
                await call("reply", session_id=session, message_id=message["id"], content="Answer", author="test-agent")
                assert store.pending(session) == []
                assert (await call("close_review", session_id=session))["approval"] is False
                assert (await call("wait_for_feedback", session_id=session))["status"] == "closed"
    asyncio.run(run())

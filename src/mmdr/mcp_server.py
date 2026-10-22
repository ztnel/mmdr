"""Environment-neutral stdio MCP entry point."""

from __future__ import annotations

import argparse
import json
from contextlib import asynccontextmanager
from pathlib import Path

import base64

from mcp.server.fastmcp import FastMCP, Image

from .service import Reviews, state_directory


def create_server(reviews: Reviews) -> FastMCP:
    @asynccontextmanager
    async def lifespan(server):
        try:
            yield reviews
        finally:
            reviews.shutdown()

    server = FastMCP(
        "mmdr", lifespan=lifespan,
        instructions="Open a Mermaid review, read source and threads, reply to human messages, "
        "and optionally wait for feedback. No automatic wake or code approval. "
        "Use bounded waits only during explicit review mode; closure ends that mode.",
    )

    @server.tool()
    def open_review(
        source: str, block: str | None = None, open_browser: bool = True,
        workspace: str | None = None,
    ) -> dict:
        """Open/reuse a local Mermaid file or Markdown block within configured workspace grants.

        Returns a private local URL and session_id. Multiple Markdown diagrams require block.
        The browser server lasts until this MCP connection exits.
        Without startup grants, workspace must name an explicitly human-authorized project.
        With startup grants, calls cannot widen the configured allowlist.
        """
        return reviews.open(source, block, open_browser, workspace)

    @server.tool()
    def read_comments(session_id: str) -> dict:
        """Read source, revision, anchors, all threads, and pending human messages."""
        return reviews.read(session_id)

    @server.tool()
    async def check_diagram(session_id: str, timeout_seconds: int = 15) -> list:
        """Visual readback of the rendered diagram for the current source revision.

        Returns JSON findings (contrast, overlaps, density) plus a PNG. Requires the review
        URL open in a browser. If findings are present, fix the source (lighter text, darker
        fills, or split a busy diagram) and call again.
        """
        quality = await reviews.check(session_id, timeout_seconds)
        content: list = [json.dumps(quality["report"])]
        if quality["image"]:
            content.append(Image(data=base64.b64decode(quality["image"]), format="png"))
        return content

    @server.tool()
    def reply(session_id: str, message_id: str, content: str, author: str) -> dict:
        """Reply to a human message in its original thread. Use a concrete agent author identity."""
        return reviews.reply(session_id, message_id, content, author)

    @server.tool()
    async def wait_for_feedback(session_id: str, timeout_seconds: int = 120) -> dict:
        """Wait 1-300 seconds for feedback, closure, or timeout; cancellation stops the wait.

        Occupies the current tool call, not a universal wake mechanism. On timeout the agent
        decides whether to wait again. Pending feedback remains until replied to.
        """
        return await reviews.wait(session_id, timeout_seconds)

    @server.tool()
    def close_review(session_id: str) -> dict:
        """Close comments/waits without deleting conversations or approving code."""
        return reviews.close(session_id)

    return server


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, action="append")
    parser.add_argument("--state-dir", type=Path, default=state_directory())
    args = parser.parse_args()
    reviews = Reviews(args.state_dir, args.workspace or [])
    create_server(reviews).run(transport="stdio")

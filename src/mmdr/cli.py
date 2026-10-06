"""Open a local Mermaid review without an agent or MCP host."""

import argparse
import json
import sys
import time
from pathlib import Path

from .errors import UsageError
from .service import Reviews, state_directory
from .store import Store


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=state_directory())
    sub = parser.add_subparsers(dest="command", required=True)
    opening = sub.add_parser("open")
    opening.add_argument("source")
    opening.add_argument("--workspace", type=Path, default=Path.cwd())
    opening.add_argument("--block")
    opening.add_argument("--no-browser", action="store_true")
    sub.add_parser("list")
    for command in ("comments", "reply", "close"):
        operation = sub.add_parser(command)
        operation.add_argument("--session", required=True)
        if command == "comments":
            operation.add_argument("--pending", action="store_true")
        if command == "reply":
            operation.add_argument("--to", required=True)
            operation.add_argument("--username", required=True)
            operation.add_argument("content")
    args = parser.parse_args()
    reviews = None
    try:
        if args.command != "open":
            store = Store(args.state_dir / "reviews.sqlite3")
            if args.command == "list":
                result = store.list()
            elif args.command == "comments":
                result = store.pending(args.session) if args.pending else store.state(args.session)
            elif args.command == "reply":
                result = store.message(args.session, args.content, "agent", args.username, parent=args.to)
            else:
                store.close(args.session)
                result = {"closed": True, "approval": False}
            print(json.dumps(result, indent=2))
            return
        reviews = Reviews(args.state_dir, [args.workspace])
        result = reviews.open(args.source, args.block, not args.no_browser)
        print(f"REVIEW_SESSION={result['session_id']}\nREVIEW_URL={result['url']}", flush=True)
        if result["browser_error"]:
            print(result["browser_error"], file=sys.stderr)
        while True:
            time.sleep(.5)
    except KeyboardInterrupt:
        pass
    except (UsageError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
    finally:
        if reviews:
            reviews.shutdown()


if __name__ == "__main__":
    main()

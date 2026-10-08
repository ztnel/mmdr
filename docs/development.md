# Development

Run from the repository root:

```console
uv sync --frozen
uv run --frozen pytest
npm ci
npx playwright install chromium
uv run --frozen python scripts/browser_tests.py
uv build
uv run --frozen python scripts/check_package.py
```

Browser tests cover all 38 registered types in Mermaid 11.17.2, offline
rendering, chat, keyboard navigation, and revisions. Rebuild pinned browser
assets with `uv run python scripts/build_assets.py`; license notices ship
alongside the bundle. CI exercises Python tests on Windows, macOS, and Linux.

[Back to README](../README.md)

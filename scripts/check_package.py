#!/usr/bin/env python3
"""Require the runtime and offline assets in a built wheel."""

import json
from pathlib import Path
from zipfile import ZipFile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "plugin.json").read_text(encoding="utf-8"))["version"]
with ZipFile(root / f"dist/mmdr-{version}-py3-none-any.whl") as wheel:
    required = {
        "mmdr/__init__.py", "mmdr/cli.py", "mmdr/mcp_server.py", "mmdr/service.py",
        "mmdr/assets/index.html", "mmdr/assets/app.js", "mmdr/assets/style.css",
        "mmdr/assets/anchors.js", "mmdr/assets/vendor/mermaid.js",
        "mmdr/assets/vendor/mermaid.js.LEGAL.txt", "mmdr/assets/vendor/THIRD-PARTY.txt",
        f"mmdr-{version}.dist-info/licenses/LICENSE",
    }
    missing = required - set(wheel.namelist())
    if missing:
        raise SystemExit("missing wheel files: " + ", ".join(sorted(missing)))
    for path in required:
        if not wheel.read(path):
            raise SystemExit("empty wheel file: " + path)
print("Wheel runtime, offline assets, and licenses verified.")

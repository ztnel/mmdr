#!/usr/bin/env python3
"""Rebuild the pinned offline Mermaid bundle and third-party notices."""

import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
assets = root / "src/mmdr/assets"
subprocess.run([
    "node", "-e",
    "require('esbuild').buildSync({entryPoints: ['src/mmdr/assets/renderer.js'], "
    "bundle: true, format: 'esm', minify: true, legalComments: 'external', "
    "outfile: 'src/mmdr/assets/vendor/mermaid.js'})",
], cwd=root, check=True)
notices = []
for package in sorted((root / "node_modules").rglob("package.json")):
    if package.parent.name.startswith("."):
        continue
    data = json.loads(package.read_text(encoding="utf-8"))
    licenses = [file for file in package.parent.iterdir()
                if file.is_file() and file.name.lower().startswith(("license", "copying"))]
    if licenses:
        notices.append(
            f"\n{'=' * 72}\n{data.get('name', package.parent.name)} "
            f"{data.get('version', '')} ({data.get('license', 'see below')})\n"
            + "\n".join(file.read_text(encoding="utf-8", errors="replace") for file in licenses)
        )
(assets / "vendor/THIRD-PARTY.txt").write_text("".join(notices), encoding="utf-8")

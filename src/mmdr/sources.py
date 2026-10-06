"""Read only explicitly registered diagram inputs, preserving block identity."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from .errors import UsageError

MAX_SOURCE = 1024 * 1024


def digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def diagrams(path: Path) -> dict[str, str]:
    if not path.is_file() or path.stat().st_size > MAX_SOURCE:
        raise UsageError("diagram source is missing or larger than 1 MiB")
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".mmd":
        return {"diagram": text}
    if path.suffix.lower() not in {".md", ".markdown"}:
        raise UsageError("source must be .mmd or Markdown")
    result: dict[str, str] = {}
    heading = ""
    marker = ""
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        match = re.match(r"\s*<!--\s*mermaid-review:\s*([A-Za-z0-9_-]+)\s*-->", line)
        if match:
            marker = match[1]
        if re.match(r"#{1,6}\s", line):
            heading = line.lstrip("#").strip()
        fence = re.match(r" {0,3}(`{3,}|~{3,})mermaid\s*$", line)
        if not fence:
            index += 1
            continue
        body: list[str] = []
        index += 1
        while index < len(lines) and not re.fullmatch(
            r" {0,3}" + re.escape(fence[1][0]) + r"{" + str(len(fence[1])) + r",}\s*", lines[index]
        ):
            body.append(lines[index])
            index += 1
        if index == len(lines):
            raise UsageError("unclosed Mermaid fence")
        key = marker or heading or "diagram"
        if key in result:
            raise UsageError(
                f"ambiguous Markdown diagram identity {key!r}; use unique headings or "
                "<!-- mermaid-review: unique-id --> before each block"
            )
        result[key] = "\n".join(body)
        marker = ""
        index += 1
    if not result:
        raise UsageError("no Mermaid blocks in source")
    return result

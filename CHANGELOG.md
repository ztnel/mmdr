# Changelog

## v0.1.0

Initial release of mmdr: local, keyboard-first Mermaid reviews with agents.

### Added

- Offline SVG rendering with bundled Mermaid 11.17.2; all 38 registered
  diagram types covered by browser tests.
- Component-anchored conversations with reviewer comments, agent replies,
  message-count badges, and whole-diagram threads.
- GitHub-dark UI with selection glow, zoom, pan, search, and Vim-style
  element and message navigation.
- `.mmd` and Markdown Mermaid inputs, live source reload, and persistent
  SQLite conversations. Flowchart node IDs retain threads across revisions;
  other anchors are revision-bound and support explicit reattachment.
- Standalone Python 3.11+ viewer, Mermaid review skill, and portable stdio
  MCP tools: `open_review`, `read_comments`, `reply`, `wait_for_feedback`,
  and `close_review`. No tmux or agent-specific wake engine required.
- Explicit workspace grants and capability-protected loopback browser access.
- Python and package CI on Windows, macOS, and Linux, plus browser coverage.

### Fixed

- Browser coverage waits for render completion before recording diagram
  types; a delayed-anchor regression guards against the CI timing race.

### Boundaries

MCP waits occupy a tool call; they do not wake an idle agent. Closing a review
preserves conversations and ends commenting, but does not approve code or
close the browser tab.

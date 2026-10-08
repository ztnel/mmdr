# Changelog

## v0.1.1

### Fixed

- Context-aware keyboard navigation: `hjkl` pans in NORMAL, selects elements
  in VISUAL, and scrolls an active discussion. Editable controls no longer
  trigger canvas or discussion shortcuts. ([#4](https://github.com/ztnel/mmdr/pull/4))
- Shortcut help opens with `?` and documents navigation and input modes.
  ([#4](https://github.com/ztnel/mmdr/pull/4))
- Dragging selected components or the diagram background pans without changing
  the selection or discussion; hover feedback previews selectable elements.
  ([#5](https://github.com/ztnel/mmdr/pull/5))
- Pointer cancellation and capture loss stop panning cleanly. Zoom controls
  preserve the canvas center after panning. ([#5](https://github.com/ztnel/mmdr/pull/5))

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

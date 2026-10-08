---
name: mermaid-review
description: "Local interactive Mermaid diagram review through mmdr MCP: SVG rendering, zoom, Vim navigation, element-anchored chat, live reload, and persistent agent replies. AUTO-INVOKE when creating or updating Mermaid diagrams or Markdown Mermaid blocks, or when a human asks to review or discuss a diagram. Use when opening diagrams, reading feedback, replying to comments, or explicitly waiting for review. Diagram closure is not code approval."
---

# Mermaid review

Use the `mmdr` MCP tools. Do not require a particular agent client, tmux,
terminal injection, or another plugin.

## Open

Call `open_review(source, block?, open_browser=true, workspace?)` after creating or updating
Mermaid. Sources are `.mmd`, `.md`, or `.markdown` within the server's configured
workspace grants. Use an absolute source path when possible. Without startup
grants, provide the human-authorized project directory as `workspace`; do not
grant a broad parent directory or infer permission from a requested file.
Configured startup grants cannot be widened by tool calls.

Multiple Markdown diagrams require `block`: a unique heading or an explicit
`<!-- mermaid-review: identity -->` before the fence. Do not silently choose the
first block or modify a document merely to create an identity.

Keep the returned `session_id`. Reopening the same source/block reuses its
conversation; the browser server is owned by the MCP connection. The returned
URL contains a private capability: keep it local.

## Feedback

Call `read_comments(session_id)` for source, revision, anchors, full threads,
and pending human messages. Read the latest source before answering.

Call `reply(session_id, message_id, content, author)` at the original human
message. Use a concrete agent identity. Reply before acting:

- Change request: `agree — <reason>; queued: <work>`, `disagree — <reason>`,
  or `needs clarification — <question>`.
- Question: answer directly; do not manufacture work.
- Remark: acknowledge briefly.

Perform agreed local edits under the invoking workflow's ownership rules.
Report their outcome in the same thread. Keep changes unstaged; this surface
does not authorize commits, pushes, or publication. Avoid duplicate replies.

## Explicit review mode

Only wait when the human wants an interactive review loop. Call
`wait_for_feedback(session_id, timeout_seconds=120)`, read returned feedback,
reply, and wait again while review mode is still wanted.

A timeout is not feedback or success. Decide whether to keep waiting.
Cancellation stops that wait. `closed` ends the loop. A waiting tool occupies
the current agent turn; MCP does not wake an idle or disconnected agent.
Do not simultaneously use an external wake adapter for the same review owner.

`close_review(session_id)` preserves conversations and stops new comments.
It never approves code or closes a browser tab. Reopen to resume.

## Viewer

`?` opens shortcut help outside editable controls; Escape closes it.

Bundled Mermaid renders offline. `/` searches, `n/N` cycles matches, `hjkl`
pans in NORMAL and selects directionally in VISUAL (sequence fallback).
Selection leaves discussions closed; `c` opens/comments, `;c` comments on the whole diagram,
and `m/M` cycles individual messages. Enter posts; Shift+Enter adds a newline.
`c` and `m/M` activate a discussion; `j/k` then scrolls its history.
Escape exits input modes; otherwise it deselects and closes the discussion.
The mode indicator shows `NORMAL` without selection and orange `VISUAL` with
selection. Editable controls do not trigger pan or thread scrolling.
`:e` refreshes; `:q`, `:wq`, and `:x` close the review.

Proven flowchart node identities retain threads across revisions. Other anchors
are revision-bound; missing/ambiguous threads remain readable and can be
explicitly reattached. Do not guess replacements from layout or repeated labels.

If MCP is unavailable, report the configuration error rather than silently
substituting another integration. Setup and standalone CLI: [README.md](README.md).

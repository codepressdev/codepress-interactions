---
name: "gws-core"
description: "Core command conventions and routing rules for Google Workspace CLI."
---

# Google Workspace CLI Core

Use `gws ...` through Bash for this integration. Do not switch to `mcp__gmail__*`,
`mcp__drive__*`, or other integrations just because those tools exist.

## Access limits

This integration holds a deliberately narrow Google grant. Plan around it
instead of discovering it through 403s:

- Drive, Docs, Sheets and Slides run on `drive.file` — per-file access. You can
  see and edit files this integration created, and nothing else. `drive.file`
  can also cover files opened through an app's own Google Picker, but this
  integration ships no picker, so that path does not exist here. A Drive-wide
  listing or search will simply not return the user's other files, and there is
  no action the user can take to grant access to an existing one. That is the
  grant working, not a bug.
- Gmail and Calendar are not authorized at all.

If the user asks for something outside these limits, say so plainly rather than
trying alternate command shapes — no `gws` invocation will widen the grant.

## Rules

- Stay on the `gws` path when the user explicitly asked for Google Workspace CLI.
- Do not use `search_tools` for this integration.
- If the exact subcommand shape is unclear, inspect `gws --help` or the service's `--help`.
- Prefer official resource-style commands and `--params` JSON over guessed shorthand flags.
- If the isolated runner says it is still starting, wait briefly and retry.
- If a command fails because a service is not authorized, explain that the MCP needs
  reconnection with that Google service enabled.

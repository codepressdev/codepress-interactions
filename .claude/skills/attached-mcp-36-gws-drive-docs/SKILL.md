---
name: "gws-drive-docs"
description: "Drive, Docs, Sheets and Slides patterns for Google Workspace CLI under per-file (drive.file) access."
---

# Drive, Docs, Sheets and Slides via GWS

This integration holds `drive.file`, not full Drive. That scope covers files an
app created plus files the user opened with *that same app* through a Google
Picker or "Open with" flow. This CLI has no picker of its own, so in practice
you can reach the files you create here and nothing else. The user's existing
Drive is not visible to you, and no command will make it visible.

## Creating files

Creating is the only reliable path — a file this integration creates stays
reachable for the life of the grant.

- New Doc:
  `gws drive files create --params '{"name":"NAME","mimeType":"application/vnd.google-apps.document"}'`
- New Sheet: same, with `"mimeType":"application/vnd.google-apps.spreadsheet"`.
- New Slides deck: same, with `"mimeType":"application/vnd.google-apps.presentation"`.

Capture the returned `id` — that is how you reach the file again.

## Listing what you can reach

- Files in scope:
  `gws drive files list --params '{"pageSize":10,"orderBy":"modifiedTime desc","fields":"nextPageToken,files(id,name,mimeType,modifiedTime)"}'`

A `q` filter narrows that set; it does not widen it. If the user expects to see
a file they already had in Drive, say plainly that this integration cannot reach
it and offer to create a new one — do not try a different query, and do not tell
them to "select" it, because there is no picker here that would grant access.

## Editing

Docs, Sheets and Slides APIs all accept `drive.file`, so content edits work
normally once you hold the file id, e.g.
`gws sheets spreadsheets values update --params '{"spreadsheetId":"ID",...}'`.

## Notes

- Prefer `gws drive files ...` with `--params` JSON over guessed commands like `gws docs list`.
- Continue pagination with the returned `nextPageToken` rather than `--page-all`
  when you need structured results.
- If the CLI prints extra lines such as keyring notices before JSON, strip the
  non-JSON preamble before parsing.

# React + Vite example: your UI as local JSON

A small pricing page that records its own screens with
[`@codepress/interactions-browser`](../../packages/browser/README.md), runs the
UI checks in the browser, and writes everything to JSON files in `.interactions/`
on your machine. No hosted service, no account, no key. A Playwright test runs
the same checks with
[`@codepress/interactions-playwright`](../../packages/playwright/README.md).

The page has one real layout bug in it. The steps below find it, hand it to a
coding agent, and prove the fix.

## Run it

You need Node.js 20.19+ (or 22.12+) and npm.

```sh
npm install
npm run dev
```

Open http://localhost:5173 in a desktop browser and wait a few seconds: the SDK
takes a snapshot once the page settles and flushes every 2 seconds. Clicking
buttons records more (click follow-through and a snapshot after each click).

## Look at the data

```
.interactions/
  batches/<batch_id>.json    every protocol v2 batch, exactly as the SDK sent it
  snapshots/<sha256>.json    every screen snapshot: element boxes, no text
  findings.json              the ui.finding data from all batches, one per fingerprint
```

`findings.json` is a list of `ui.finding` event data (check, elements, measured
evidence, fingerprint, viewport, route template), each with `last_seen`, the
time it was last reported. In a second terminal:

```sh
npm run findings
```

prints one line per finding, most urgent first. The schemas are in
[`protocol/`](../../protocol); what each check and evidence key means is in the
[UI checks](../../packages/browser/README.md#ui-checks) section.

To start over with an empty list, delete the `.interactions` folder (it is
recreated on the next batch) and reload the page.

## Test it

```sh
npx playwright install chromium
npm test
```

`tests/ui.spec.ts` opens the page at 1280x720 and calls `expectNoFindings(page)`.
It fails, with a message that starts `Error: 1 UI finding on /.` and lists the
finding line and its fingerprint.

Playwright starts the dev server itself, or reuses the one from `npm run dev`
if it is running. The test closes the page before the SDK's first flush, so it
adds nothing to `.interactions/`; load the page in a browser for that.

## Let an agent fix it

Point your coding agent (Claude Code, Codex, Cursor, ...) at the portable skill
in [`skills/fix-ui-findings`](../../skills/fix-ui-findings/SKILL.md), for example:

> Read ../../skills/fix-ui-findings/SKILL.md and follow it to fix the UI findings in this app.

If you copied this example out of the repository, use
https://github.com/quantfive/codepress-interactions/blob/main/skills/fix-ui-findings/SKILL.md
or copy that folder into your agent's skills directory. The agent reads
`.interactions/findings.json`, reproduces the finding, fixes the source and
proves it. Then:

```sh
npm test
```

passes. Delete `.interactions`, reload the page, wait a few seconds and run
`npm run findings` again: the fingerprint is gone.

## How it works

- `src/interactions.ts` is the browser half: an `InteractionSink` whose
  `sendBatch` and `sendSnapshot` POST to `/__interactions/...` on the dev server
  and map the status to the sink result (`2xx` accepted, `4xx` rejected, anything
  else retry). They use `context.fetch`, the page's `fetch` without the SDK's
  wrapper, so the uploads are not recorded as the app's own requests. Capture is
  on only in development (`import.meta.env.DEV`).
- `local-sink.ts` is the dev-server half: a Vite plugin (`apply: "serve"`) that
  writes the files above, checks each snapshot body against its SHA-256 and
  rebuilds `findings.json` after every batch.
- `src/App.tsx` starts capture with `useInteractions` from
  `@codepress/interactions-react`. The page uses `data-testid`s, so findings name
  test IDs such as `plan-free-cta` rather than a tag path.
- `scripts/findings.mjs` prints `findings.json` with `formatFinding` from
  `@codepress/interactions-browser/detect`, the same function the Playwright
  helper uses for its failure message.

Snapshots and events carry element boxes, roles, test IDs and counts. They never
contain page text, input values, URLs or HTML.

## The planted bug

It is deliberately not described here, so that an agent (or you) has to find it
from the data alone: `findings.json`, the snapshot it points at, and the source.

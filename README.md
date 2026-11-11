# CodePress Interactions

See your UI as data, and let your own coding agent fix what's wrong with it.

A small browser SDK records each screen your app shows as element boxes (positions, sizes, roles, flags, never text), what followed each click, and performance signals. It runs UI checks over that data in idle time: overlapping elements, content spilling out of its box, clipped text, controls out of reach, small tap targets, dead clicks, rage clicks, stuck busy states and more. Each finding is a pointer with measured evidence, not a verdict. You send the data wherever you want: to a file on disk, your own backend, or a test assertion. The same checks run in Node and in Playwright, so a fix can be proven with a test.

Nothing here needs a CodePress account or service. Apache-2.0.

| Package | |
| --- | --- |
| [`@codepress/interactions-browser`](packages/browser/README.md) | The SDK: capture, snapshots, checks, sinks. Framework independent, ESM and CommonJS, TypeScript types. |
| [`@codepress/interactions-react`](packages/react/README.md) | An optional `useInteractions` hook that owns the SDK's lifecycle in a component. |
| [`@codepress/interactions-playwright`](packages/playwright/README.md) | `findIssues` and `expectNoFindings` for Playwright tests. |

## Install

```sh
npm install @codepress/interactions-browser
```

```ts
import { initInteractions, createMemorySink } from "@codepress/interactions-browser";

const sink = createMemorySink(); // or your own { sendBatch, sendSnapshot }
initInteractions({ sink });
// sink.batches: protocol v2 batches; sink.snapshots: screen snapshot bodies
```

Call it once, early, in browser code. Under SSR, or with `enabled: false`, it returns a handle that does nothing. A sink is any object with `sendBatch(batch, serialized)` and `sendSnapshot({ sha256, body, serialized })`; [Sinks](packages/browser/README.md#sinks) has the contract.

To see it end to end, run [`examples/react-vite`](examples/react-vite): a small React app with a planted layout bug, a sink that writes JSON to `.interactions/` through the Vite dev server, and a Playwright test that fails until the bug is fixed.

## What is captured

- **Clicks and submits** on semantic controls (buttons, links, fields, ARIA roles, labels), including controls mounted later. No per-control annotations. A control is identified by its `data-interaction-id` or `data-testid` when it has a static one, otherwise by a short tag path. IDs that look built from data (`item-42`, `row-example.com`) are [dropped by default](packages/browser/README.md#test-ids-and-privacy).
- **What followed each click** until the page went quiet: time to first visible feedback, DOM mutation counts, requests and their outcome, route changes, dialogs, focus moves, layout shift, long tasks, errors, and hashes of the screen before and after.
- **Screen snapshots** after a route settles, a click settles, a resize settles or the tab comes back: every rendered element's box, tag, role, safe test ID, z-index, CSS position, flags (visible, interactive, clipped, opaque, overlay, ...), the length of its own text, the boxes its text occupies, and hit tests for controls.
- **Route templates**, never URLs: every path segment becomes `:id` unless you list it as a static word.
- **Requests** to origins you allow: method, a status label, duration, success or error.
- **Performance summaries**: layout shifts, long tasks, event timing, image and script errors.
- **Findings** from the checks below.

## What is never captured

Page text, input values, HTML, attribute values (other than roles and safe test IDs), screenshots, URLs, paths, queries, hashes, request or response bodies, headers, cookies, user identifiers, and anything inside a subtree marked `data-interactions-exclude`. Nothing is written to browser storage. The [schemas](protocol) bound every field, so a receiver can reject anything else. Details are in the [browser package README](packages/browser/README.md).

## How the checks work

The checks are pure functions over a snapshot body and the event timeline: no `document`, no `window`. The browser SDK runs them in idle time after each new snapshot, after each settled click and at each flush, and sends each finding once per fingerprint as a `ui.finding` event. `@codepress/interactions-browser/detect` runs the same functions in Node, and the Playwright helpers run them on a page under test, so a finding seen in the browser can be reproduced and proven fixed in a test.

```ts
import { expectNoFindings } from "@codepress/interactions-playwright";

await page.goto("/checkout/42");
await expectNoFindings(page, { routeSegments: ["checkout"] });
```

A finding has the check (`layout.overlap`, `layout.spill`, `layout.clipped_text`, `click.dead_click`, `click.rage_click`, ...), the elements it is about (their snapshot row, test ID, structural path and box), measured evidence (pixels covered, blocked hit-test points of a control, whether text is covered, time to feedback, ...) and a fingerprint. The fingerprint hashes the check, route template, viewport width band and element identities, never coordinates or text, so the same bug has the same fingerprint at any scroll offset, in any session, on any machine. Findings are sorted most urgent first: blocked controls, then covered or clipped text, then the rest (those involving a control first), then decorative or empty overlaps. Nothing is dropped; you decide what is a bug and accept the rest with `ignoreFingerprints` or `data-layout-ignore`.

[UI checks](packages/browser/README.md#ui-checks) lists every check, its thresholds, its evidence keys and the [measured behaviors worth knowing](packages/browser/README.md#measured-behaviors-worth-knowing).

## Let an agent fix findings

[`skills/fix-ui-findings`](skills/fix-ui-findings/SKILL.md) is a portable skill for coding agents (Claude Code, Codex, Cursor and others that read skill files). Given an app with a sink that writes findings to disk, it has the agent read the findings, reproduce one in a Playwright test, fix the source and prove the fix with `expectNoFindings`. Copy the folder into your agent's skills directory or point the agent at the file.

## Overhead

Measured with `pnpm --filter @codepress/interactions-browser bench` ([script](packages/browser/scripts/overhead.mjs)) in headless Chromium at 1280×720 on an Apple M1 Max, median of 21 runs (5 for clicks and idle), without throttling and with 4× CPU throttling (closer to a mid-range phone). Your numbers will differ; the script prints its machine with them.

- **Bundle:** 32.1 KB gzip (91.3 KB minified) for the main entry, checks included. The checks alone (`/detect`) are 10.6 KB gzip.
- **Idle page:** about 0.6 ms of extra main-thread time per 5 seconds, no long tasks, one flush timer and one structural MutationObserver.
- **Clicks:** the SDK's click listener adds 0.09 ms (0.47 ms at 4×, p95 1.1 ms) before your handler runs.
- **Snapshots:** the walk runs in idle-time slices of about 6–8 ms (`maxSliceMs`) and never caused a long task:

  | Elements | Walk CPU (1× / 4×) | Longest task (1× / 4×) | Checks, one idle task (1× / 4×) | Body (gzip) |
  | --- | --- | --- | --- | --- |
  | ~500 | 7.1 / 37 ms | 7.4 / 12 ms | 4.6 / 17 ms | 32 KB (3.6 KB) |
  | ~2,000 | 19 / 86 ms | 7.4 / 14 ms | 7.9 / 31 ms | 133 KB (11 KB) |
  | ~5,000 | 40 / 183 ms | 7.5 / 18 ms | 14 / 47 ms | 340 KB (26 KB) |

  Two steps are not sliced. Finishing a walk (serializing and hashing the body) is one task, the "longest task" column. The checks run over each new snapshot in one idle callback: on a 5,000-element page at 4× that is up to 50 ms, at the long-task threshold, and on a slower phone it would be a long task. They run only after a new snapshot, and only when the browser reports idle time; `findings: false` turns them off in the browser (the same checks still run in tests and in Node). A snapshot is taken only when a screen changes, and a body already sent in the session is not sent again.

  The walk includes the [accessibility measurements](packages/browser/README.md#what-the-measurements-cost) (text contrast and accessible names), 12–20% of its CPU on this page. `maxContrastElements` lowers that, and leaving `low_contrast` and `unnamed_control` out of `detect.checks` removes it.

## Wire protocol

Batches, snapshot bodies and findings are described by JSON Schemas in [`protocol/`](protocol), with real samples and [a guide to reading them](protocol/README.md). Within protocol version 2, changes are additive.

## Hosted service (optional)

CodePress, which maintains these packages, runs a hosted service that stores this data across sessions and makes it searchable. To use it, pass `endpoint` and `projectKey` instead of `sink`; the [protocol](protocol/README.md#http) documents the HTTP calls, so you can also point `endpoint` at a service of your own. None of the packages, the example or the skill need it.

## Python

The [Python SDK](python/README.md) in `python/` (Django and Celery request and task correlation, protocol v1) is not part of 1.0. It is not published to PyPI and its API may change.

## Development

```sh
pnpm install
pnpm build          # the React and Playwright packages typecheck and test against the browser package's build
pnpm typecheck
pnpm test
pnpm --filter @codepress/interactions-browser exec playwright install chromium
pnpm test:browser   # real-browser tests (Chromium)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes are made and released, and [CHANGELOG.md](CHANGELOG.md) for what changed.

## License

[Apache-2.0](LICENSE).

# Browser interaction SDK

Initialize once at the application client entry point. Importing the package during SSR is safe; disabled/SSR initialization returns an inert handle. 

```ts
import { initInteractions } from "@codepress/interactions-browser";

const interactions = initInteractions({
  projectKey: "public-project-key",
  endpoint: "https://interactions.example.com",
  allowedApiOrigins: [window.location.origin],
});
```

The endpoint is the service base URL; the SDK sends protocol v2 batches to `/v2/batches` and snapshot bodies to `/v2/snapshots/{sha256}` ([schemas](../../protocol)). Use `sink` instead of `endpoint` to send evidence anywhere else (see [Sinks](#sinks)). The public key resolves project/environment on the service. `environment` is a local diagnostic configuration label and never grants authority. Service origin admission and lease configuration must already permit this installation. API origins default to this page's origin. Add a separate API origin explicitly only if it is controlled by your application and permits `X-Interaction-Id` in its CORS configuration.

Initial setup captures clicks on semantic controls (including dynamically mounted controls), form submissions, navigation signals, bounded structural DOM changes, and allowed-origin fetch/XHR observations. It does not require per-control annotations. Control identifiers use safe `data-interaction-id`/`data-testid` values when present, otherwise an at-most-five-tag ancestry hint. This fallback is not unique and never scans sibling collections. These identifiers are structural hints and can change when layouts change. Mark private subtrees `data-interactions-exclude`. Do not put user data or secrets in explicit tracking identifiers.

No DOM text, HTML, input values, request/response bodies, URL paths, queries, cookies or user IDs are recorded. Mutation evidence reports changed-record counts, not a replay or an assertion that a spinner represents business completion. HTTP statuses are bounded `data.phase` labels such as `http_201`; browser request outcomes are `completed`/`error`, never server business outcomes. No durable browser storage is used.

## Correlation

Automatic clicks are separate interaction attempts. Automatic requests and mutation/navigation observations have unknown attribution: the SDK does not attach them to whichever click happened most recently. For known causal work use an optional explicit action:

```ts
await interactions.runAction("transfer.confirm", async (context) => {
  await context.fetch("/api/transfer", { method: "POST" });
  await someOtherWork();
  await context.fetch("/api/verify");
});
```

`runAction` sets context only during the callback's synchronous invocation. Ordinary fetch/XHR calls during that synchronous portion inherit the action. After `await`, a timer or another callback, use the supplied `context.fetch` to preserve the known link. Ordinary unbound fetch after an await and independent polling remain unlinked. This avoids global async context leaking between overlapping actions. Business callback return values, thrown errors, and rejected promises remain unchanged. Existing `X-Trace-Id` is preserved; raw headers are never recorded. Ingestion and unconfigured third-party origins are never instrumented or sent correlation headers.

## Lifecycle and bounds

`flush()` attempts one immutable batch, returning without throwing transport errors. Retryable failures preserve the exact batch/event IDs and payload. Defaults: 1,000 queued events, 100 events/batch, 60,000 bytes/batch, flush every 5s, request timeout 10s, 3 retries with 1s exponential base, 50 mutation-observer work units per callback. Override using `maxQueueEvents`, `maxBatchEvents`, `maxBatchBytes`, `flushIntervalMs`, `requestTimeoutMs`, `maxRetries`, `retryBaseMs`, `maxMutationRecords`. `maxMutationRecords` retains its existing name but is one shared callback budget (maximum 1,000): records, ancestor privacy checks, and every inspected subtree node—including excluded or non-element nodes—consume units. It is never reset for another record or subtree. Excluded descendants are skipped, and exhaustion stops inspection; dropped diagnostics increment once for that truncated callback without claiming an exact count of unseen nodes or events. These are bounded locally. Overflow and exhausted retries increment dropped diagnostics; they never hold up business requests. Retry timers are driven by the flush interval. `getDiagnostics()` exposes local accepted/failed/dropped counts and errors; it does not claim end-to-end installation health.

Page exit attempts one small keepalive batch. Delivery is best effort and can fail, particularly when an upload is already active or the browser terminates. No secret is placed in a URL. HTTP 401/403 stops capture and clears pending evidence; reconnecting requires explicit reinitialization after fixing admission.

Repeated identical initialization shares one recorder through reference-counted leases. Each owner calls `shutdown()` on its handle; the last owner stops timers/observers, aborts SDK uploads, clears queues, and restores only patches still owned by the SDK. Later third-party patches are preserved. Different concurrent project configurations return an inert handle: shut down the old project before switching account/org so pending events are never relabeled. React Strict Mode may start a fresh recorder after a complete cleanup, which is safe.

Not covered: closed shadow roots, frame contents (frames are one opaque box), general Promise/timer propagation, persistent offline replay, input recording, screenshots, sampled completeness inference, or global cross-batch re-batching. Browser telemetry is untrusted evidence. Service v1 requires immutable batch retries; event IDs are never reassigned to another batch.

Structural feedback includes progress/status indicators appearing or disappearing,
`aria-busy` transitions, and disabled controls. Values and status text are omitted;
CSS-only spinners without semantic markup may remain an unknown structural change.
Signed URLs are excluded from request instrumentation. Existing interaction headers
are preserved; a valid UUID is used for correlation, otherwise attribution is unknown.

## Route templates

Events and snapshots carry a route template, never the URL. By default every path segment is replaced by `:id`, so `/u/jane-smith` and `/acme-corp/projects` are both sent as `/:id/:id`: a lowercase slug can be a username, organization or title, so it is never kept unless the app says so. List the static words of your routes in `routeSegments` (`/acme-corp/projects` with `routeSegments: ["projects"]` becomes `/:id/projects`), or pass `routeTemplate` to return your router's own pattern. The query and hash are never used.

## Screen snapshots

Each settled screen is recorded as element boxes in a columnar body ([schema](../../protocol/v2-snapshot.schema.json), [example](../../protocol/v2-snapshot.json)): parent, tag, role, safe test ID, `x`/`y`/`width`/`height` (viewport CSS pixels from `getBoundingClientRect`), z-index, CSS position, flags (visible, interactive, clipped, scrollable, overlay, ignored, pointer-events none, opaque, clips content, in shadow root, open popover, ellipsis or line clamp, broken image) and text length. "In shadow root" means the element's own tree is a shadow root; slotted light-DOM content is not flagged. The viewport records whether the primary pointer is coarse (touch). For elements with direct text it also records the box of the rendered text itself (from a `Range`, geometry only), so an element box can overlap something while its text does not. For visible interactive elements it probes `elementFromPoint` at the center and four inset points and stores how many land on something else and which element is on top. `elementFromPoint` is never called for other elements. No text, values, attribute values (other than role and safe test IDs), URLs or HTML are recorded.

Snapshots are taken when a route settles (including the first screen), after a click settles, after a resize settles and when the tab becomes visible again, never while it is hidden. `handle.snapshot()` takes one on demand. Each body is hashed (SHA-256 of the exact uncompressed bytes); a hash already sent in this page session is not sent again. With `endpoint`, the body is uploaded by `HEAD` then, only on 404, a gzip `PUT` to `/v2/snapshots/{sha256}`. The service must allow `HEAD`/`PUT` and the `Authorization` and `Content-Encoding` headers from your origin.

The walk runs in slices of idle time: the clock is checked every 8 elements and the walk yields once `maxSliceMs` has passed, so a slice overruns by at most one batch of 8. It stops at `maxElements` and marks the body `truncated`; a body larger than `maxSnapshotBytes` drops trailing rows and is also `truncated`. If the DOM, scroll position or viewport changes between slices the body is marked `torn`. Open shadow roots are traversed (slotted content under its slot); closed roots are one box. Canvas, iframes, embeds and video are one box flagged `opaque`. `display: none` subtrees are skipped. Content the browser does not render (the body of a closed `<details>`, `content-visibility: hidden`) is recorded without the visible flag. Subtrees matching `ignoreSelector`, `[data-layout-ignore]` or `[data-interactions-exclude]` are recorded as one box flagged `ignored` and never descended, so checks can skip them. Clip detection follows `overflow` and `contain: paint`; it does not model every case (for example absolutely positioned descendants escaping a non-positioned clipping ancestor).

## Click follow-through

Every click on a control starts a follow-through window. It ends when the page has been quiet (no DOM change, no observed request in flight) for `clickSettleMs`, and is reported as one `ui.click.settled` event: time to first visible feedback (DOM change, route change, dialog or focus move), settle time, counts of mutations, requests, failed requests, uncaught errors and long tasks, layout shift score, whether the route changed, a dialog opened or focus moved, and the screen hashes before and after. Since 0.3.0 it also says whether the click landed on a control (`target_interactive`), changed a field's value (`value_changed`, for example a checkbox), put focus in a text field (`field_focused`) or opened a new tab or window (`new_context`). Focus or feedback caused by a later pointer or key input is not credited to an earlier open click. Its `interaction_id` is the click's `interaction.started` ID and its attribution is always `inferred`; requests observed in the window are counted there and never attached to the click as explicit. A second click before the first settles closes the first as `overlapped` (both are flagged) and nothing is counted for both. A click still open after `clickTimeoutMs`, or when the page is hidden or unloaded, is reported `incomplete`.

## UI checks

`@codepress/interactions-browser/detect` turns snapshots and events into findings. The checks are pure functions over data: no `document`, no `window`, the same results in the browser, in Node and in a test runner ([Playwright helpers](../playwright/README.md)). By default the SDK runs them in idle time after each new snapshot, after each settled click and at each flush, and sends each finding as a `ui.finding` event once per fingerprint per page session (`findings: false` turns this off).

A finding is a pointer, not a verdict: it names the elements and carries `evidence`, measured facts only (numbers, booleans, or `null` for unknown). Whether it is a bug is for whoever reads it; checks do not filter by confidence.

| Check (`check`) | Reports |
| --- | --- |
| `layout.overlap` | Two elements whose visible boxes intersect by more than `overlapMinPx` in both directions, where neither contains the other. Subject is the element underneath. Evidence: overlap size, fraction of each covered, blocked hit-test points of controls underneath, whether the subject's rendered text is covered (`null` for opaque boxes), CSS positions, depth to the shared parent, overlay flags. |
| `layout.spill` | An element crossing its nearest `overflow: hidden/clip` ancestor by more than `tolerancePx`. Only the outermost spilling element is reported. |
| `layout.page_h_scroll` | The document is wider than the viewport; subject is the element reaching furthest right. |
| `layout.offscreen_control` | A control outside the area the page can scroll to (or, if fixed, outside the viewport). |
| `layout.small_tap_target` | A control smaller than `minTapTargetPx` in either direction, only for touch input. |
| `layout.clipped_text` | Rendered text cut off by a clipping box, unless it ends in an ellipsis or line clamp. |
| `click.dead_click` | A settled click on a control with no feedback, request, route change, dialog, focus move, value change, field focus or new tab. |
| `click.rage_click` | `rageClickCount` clicks on one control within `rageClickWindowMs`. |
| `click.slow_feedback` | First feedback after `slowFeedbackMs`, or none while requests ran that long. |
| `click.silent_failure` | A request failed during the click and the screen did not change. |
| `click.error_after_click` | An uncaught error during the click. |
| `stability.stuck_busy` | A busy or progress indicator still showing after `stuckBusyMs`. |
| `stability.layout_shift` | A performance window's layout shift score at or above `layoutShiftScore`. |
| `stability.slow_input` | Slowest event timing at or above `slowInputMs`. |
| `stability.broken_image` | An image that finished loading with no image data. |

What is not reported as an overlap or spill: dialogs, menus, listboxes, tooltips and open popovers against what is beneath them (they are separate layers, as is a fixed full-screen backdrop); content crossing the edge of a scroller (that is scrolling); content scrolled under a sticky or fixed header; subtrees with `data-layout-ignore`; elements of 1×1 px or less. A `torn` snapshot gives no position-based findings; rows missing from a `truncated` one give none. Click checks use only windows that `settled`: a click whose page navigated away, timed out or was overlapped by another click gives no `dead_click`.

Sorting puts blocked controls first (any `*_blocked_points` > 0), then covered or clipped text, then the rest, by check, in order found. It never drops a finding.

The fingerprint is 32 hex characters of SHA-256 over the check, the route template, the viewport width band and the elements' `stable_id`, never coordinates, scroll offsets or text. It is the same for the same bug at another scroll offset, in another session or on another machine. `stable_id` is the test ID or, when there is none, a structural tag path from the nearest ancestor with a test ID (`#cart/div/button`); evidence `subject_structural_id` / `structural_id` says so. Structural paths change when the markup does, and siblings with the same tags share one.

```ts
import { checkEvents, checkSnapshot, formatFinding } from "@codepress/interactions-browser/detect";

const findings = [...checkSnapshot(body, { sha256 }), ...checkEvents(batch.events)];
findings.map(formatFinding);
```

| Detect option | Default | |
| --- | --- | --- |
| `checks` | all | Short names to run, e.g. `["overlap", "spill"]`. |
| `overlapMinPx` | 0.5 | Overlap must be wider and taller than this (sub-pixel rounding does not count). |
| `tolerancePx` | 1 | Spill, offscreen, clipped text and page scroll must cross by more than this. |
| `minTapTargetPx` | 24 | WCAG 2.2 target size minimum. |
| `touch` | snapshot's coarse pointer | Run the tap target check. |
| `viewportBands` | `[480, 768, 1024, 1440]` | Width breakpoints for the fingerprint band. |
| `slowFeedbackMs` | 1000 | |
| `rageClickCount` / `rageClickWindowMs` | 3 / 1000 | |
| `stuckBusyMs` | 10000 | |
| `layoutShiftScore` | 0.1 | |
| `slowInputMs` | 200 | |
| `now` | last event time (SDK: current time) | When `stuckBusyMs` is measured. |

## Performance signals

Layout shifts, event timing (40 ms and slower), long tasks, image load errors and uncaught errors/unhandled rejections are counted and sent as `perf.summary` events. Each API is feature-detected: a signal the browser does not support is `null` and listed in `unavailable`, never reported as zero. Error messages, stacks, file names and image URLs are not read.

## Sinks

`sink: { sendBatch, sendSnapshot }` replaces `endpoint`; `projectKey` is then not needed. Each method may return (or resolve) `"accepted"` (the default), `"retry"`, `"rejected"` or `"denied"` (stops capture and clears pending evidence, like HTTP 401/403). A sink that throws, rejects or never settles cannot affect the page: calls are isolated, timed out after `requestTimeoutMs` and retried within the usual bounds. `createMemorySink()` keeps everything in memory for tests:

```ts
import { createMemorySink, initInteractions } from "@codepress/interactions-browser";

const sink = createMemorySink();
const handle = initInteractions({ sink });
await handle.snapshot();
await handle.flush();
sink.batches; // protocol v2 batches
sink.snapshots; // { sha256, serialized, body }
```

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `endpoint` + `projectKey` | | Hosted service base URL and public key. |
| `sink` | | Alternative to `endpoint`. |
| `release` | none | Bounded release label sent with every batch. |
| `routeSegments` | none | Static lowercase path words the default route template keeps, e.g. `["orders", "items"]`. |
| `routeTemplate(url)` | every path segment `:id` unless in `routeSegments`; no query or hash | Return a bounded route label such as `/orders/[id]`. Values with a query or unsafe characters are dropped. |
| `requestLabel(url, init)` | none | Bounded static label for an observed request (`[A-Za-z0-9_.:/-]`, 64 characters). |
| `propagateHeader` | `X-Interaction-Id` | Correlation header name for allowed origins; `false` sends none. A readable `X-Trace-Id` response header is recorded. |
| `snapshots` | `true` | Turn screen snapshots off. |
| `maxElements` | 5000 (max 50,000) | Elements per snapshot before `truncated`. |
| `maxSliceMs` | 6 (max 50) | Main-thread time per walk slice. |
| `maxSnapshotBytes` | 1,500,000 | Uncompressed body cap. |
| `maxSnapshotsPerSession` | 100 | Walks per page session. |
| `routeSettleMs` | 1000 | Wait after a route change (and the first load) before a snapshot. |
| `clickSettleMs` | 500 | Quiet time that ends a click's follow-through. |
| `clickTimeoutMs` | 10000 | Longest follow-through before `incomplete`. |
| `resizeSettleMs` | 500 | Quiet time after the last resize. |
| `visibleSettleMs` | 300 | Delay after the tab is visible again. |
| `ignoreSelector` | none | Extra subtrees recorded as one `ignored` box. |
| `findings` | `true` | Run the UI checks and send `ui.finding` events. |
| `detect` | defaults above | UI check thresholds. |

The transport options above (`maxQueueEvents`, `flushIntervalMs`, …) keep their v1 defaults.

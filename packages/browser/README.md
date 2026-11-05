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

## Screen snapshots

Each settled screen is recorded as element boxes in a columnar body ([schema](../../protocol/v2-snapshot.schema.json), [example](../../protocol/v2-snapshot.json)): parent, tag, role, safe test ID, `x`/`y`/`width`/`height` (viewport CSS pixels from `getBoundingClientRect`), z-index, CSS position, flags (visible, interactive, clipped, scrollable, overlay, ignored, pointer-events none, opaque, clips content, in shadow root) and text length. For elements with direct text it also records the box of the rendered text itself (from a `Range`, geometry only), so an element box can overlap something while its text does not. For visible interactive elements it probes `elementFromPoint` at the center and four inset points and stores how many land on something else and which element is on top. `elementFromPoint` is never called for other elements. No text, values, attribute values (other than role and safe test IDs), URLs or HTML are recorded.

Snapshots are taken when a route settles (including the first screen), after a click settles, after a resize settles and when the tab becomes visible again, never while it is hidden. `handle.snapshot()` takes one on demand. Each body is hashed (SHA-256 of the exact uncompressed bytes); a hash already sent in this page session is not sent again. With `endpoint`, the body is uploaded by `HEAD` then, only on 404, a gzip `PUT` to `/v2/snapshots/{sha256}`. The service must allow `HEAD`/`PUT` and the `Authorization` and `Content-Encoding` headers from your origin.

The walk runs in slices of idle time: the clock is checked every 8 elements and the walk yields once `maxSliceMs` has passed, so a slice overruns by at most one batch of 8. It stops at `maxElements` and marks the body `truncated`; a body larger than `maxSnapshotBytes` drops trailing rows and is also `truncated`. If the DOM, scroll position or viewport changes between slices the body is marked `torn`. Open shadow roots are traversed (slotted content under its slot); closed roots are one box. Canvas, iframes, embeds and video are one box flagged `opaque`. `display: none` subtrees are skipped. Subtrees matching `ignoreSelector`, `[data-layout-ignore]` or `[data-interactions-exclude]` are recorded as one box flagged `ignored` and never descended, so checks can skip them. Clip detection follows `overflow` and `contain: paint`; it does not model every case (for example absolutely positioned descendants escaping a non-positioned clipping ancestor).

## Click follow-through

Every click on a control starts a follow-through window. It ends when the page has been quiet (no DOM change, no observed request in flight) for `clickSettleMs`, and is reported as one `ui.click.settled` event: time to first visible feedback (DOM change, route change, dialog or focus move), settle time, counts of mutations, requests, failed requests, uncaught errors and long tasks, layout shift score, whether the route changed, a dialog opened or focus moved, and the screen hashes before and after. Its `interaction_id` is the click's `interaction.started` ID and its attribution is always `inferred`; requests observed in the window are counted there and never attached to the click as explicit. A second click before the first settles closes the first as `overlapped` (both are flagged) and nothing is counted for both. A click still open after `clickTimeoutMs`, or when the page is hidden or unloaded, is reported `incomplete`.

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
| `routeTemplate(url)` | lowercase words kept, other path segments `:id`, no query | Return a bounded route label such as `/orders/[id]`. Values with a query or unsafe characters are dropped. |
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

The transport options above (`maxQueueEvents`, `flushIntervalMs`, …) keep their v1 defaults.

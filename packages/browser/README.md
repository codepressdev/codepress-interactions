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

The endpoint is the service base URL; the SDK sends protocol v2 batches to `/v2/batches` and snapshot bodies to `/v2/snapshots/{sha256}` ([schemas](https://github.com/quantfive/codepress-interactions/blob/main/protocol)). Use `sink` instead of `endpoint` to send evidence anywhere else (see [Sinks](#sinks)). The public key resolves project/environment on the service. `environment` is a local diagnostic configuration label and never grants authority. Service origin admission and lease configuration must already permit this installation. API origins default to this page's origin. Add a separate API origin explicitly only if it is controlled by your application and permits `X-Interaction-Id` in its CORS configuration.

Initial setup captures clicks on semantic controls (including dynamically mounted controls), form submissions, navigation signals, bounded structural DOM changes, and allowed-origin fetch/XHR observations. It does not require per-control annotations. Control identifiers use `data-interaction-id`/`data-testid` values that pass the [test ID filter](#test-ids-and-privacy), otherwise an at-most-five-tag ancestry hint. This fallback is not unique and never scans sibling collections. These identifiers are structural hints and can change when layouts change. Mark private subtrees `data-interactions-exclude`. Do not put user data or secrets in explicit tracking identifiers.

No DOM text, HTML, input values, request/response bodies, URL paths, queries, cookies or user IDs are recorded. Mutation evidence reports changed-record counts, not a replay or an assertion that a spinner represents business completion. HTTP statuses are bounded `data.phase` labels such as `http_201`; browser request outcomes are `completed`/`error`, never server business outcomes. No durable browser storage is used.

## Test IDs and privacy

A test ID is often built from data: `row-${record.id}`, `domain-row-${hostname}`. Recorded as is, it would carry that data off the page, and one per-record ID would split one finding into many. So every `data-interaction-id` and `data-testid` goes through a filter before it is used anywhere: the snapshot `test_id` dictionary, a click's `control_id`, `control_id` on UI state events, and a finding's `stable_id` and fingerprint.

The default filter, `defaultTestIdFilter`, keeps an ID only when it looks static. It drops a value that:

- contains a `.`, or
- has a segment (split on `-`, `_`, `.` or `:`) that contains a digit or is longer than 32 characters.

| Value | Default |
| --- | --- |
| `save-button`, `nav:settings`, `plan_pro_cta` | kept |
| `item-42`, `step2` | dropped: a digit |
| `row-3f2a9c1e-7b4d-4e8a-9c21-5d6e7f809a1b` | dropped: a digit |
| `domain-row-example.com`, `checkout.pay` | dropped: a `.` |

A dropped ID is treated as if the element had none. Clicks use the tag path, and findings use a structural path from the nearest ancestor with a kept ID. `data-interaction-id` follows the same rule as `data-testid`. When it is dropped, the element's `data-testid` is tried next.

The filter cannot recognize every value. A slug of short words (`project-acme-launch`), a name (`row-JaneDoe`) or a random ID with no digit looks static and is kept, and a static ID with a digit (`step2`) is dropped. If your IDs can hold slugs or names, or you need IDs the default drops, allow only the IDs you know:

```ts
const STATIC_TEST_IDS = new Set(["save-button", "nav:settings", "step2"]);

initInteractions({
  sink,
  testId: (value) => (STATIC_TEST_IDS.has(value) ? value : null),
});
```

The `testId` option replaces the default. It runs wherever the default would, with the attribute's value and the element. Return the value, or a static replacement, to keep it, and `null` to drop it:

```ts
import { defaultTestIdFilter, initInteractions } from "@codepress/interactions-browser";

initInteractions({
  sink,
  // Collapse per-record rows into one ID, and use the default for the rest.
  testId: (value) => (value.startsWith("order-row-") ? "order-row" : defaultTestIdFilter(value)),
});
```

The hook replaces the default rather than adding to it, so `testId: (value) => value` keeps `item-42`. Call `defaultTestIdFilter(value)` from the hook to keep its protection. The result must still be a plain identifier (`[a-zA-Z][a-zA-Z0-9_.:-]*`, at most 128 characters) or it is dropped. A hook that throws, or returns anything other than a string or `null`, drops the ID; capture continues and nothing is logged. The hook runs for each element with an ID that a snapshot walks, and on clicks and UI state changes, so keep it fast and free of side effects. Pass a stable function: like `routeTemplate`, it is compared by identity when `initInteractions` is called again, and a call with a different hook gets an inactive handle.

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

Each settled screen is recorded as element boxes in a columnar body ([schema](https://github.com/quantfive/codepress-interactions/blob/main/protocol/v2-snapshot.schema.json), [example](https://github.com/quantfive/codepress-interactions/blob/main/protocol/v2-snapshot.json)): parent, tag, role, safe test ID, `x`/`y`/`width`/`height` (viewport CSS pixels from `getBoundingClientRect`), z-index, CSS position, flags (visible, interactive, clipped, scrollable, overlay, ignored, pointer-events none, opaque, clips content, in shadow root, open popover, ellipsis or line clamp, broken image, `aria-hidden` on the element or an ancestor, carries a [`data-layout-allow-overlap`](#allowing-a-designed-overlap) marker) and text length. "In shadow root" means the element's own tree is a shadow root; slotted light-DOM content is not flagged. The viewport records whether the primary pointer is coarse (touch) and the theme on screen (`light`, `dark` or `unknown`): the `theme()` option when given, else `prefers-color-scheme`. The `ui.snapshot` event carries the same `theme`, so screens can be grouped by route, viewport and theme without reading bodies. For elements with direct text it also records the box of the rendered text itself (from a `Range`, geometry only), so an element box can overlap something while its text does not. For visible interactive elements it probes `elementFromPoint` at the center and four inset points and stores how many land on something else and which element is on top. `elementFromPoint` is never called for other elements. Since 1.2.0 it records the WCAG contrast ratio of each element's own text that is below 4.5:1, with its font size and whether it is bold, and lists shown controls that have no accessible name (see [Accessibility measurements](#accessibility-measurements)). No text, values, attribute values (other than role and safe test IDs), colours, URLs or HTML are recorded.

Snapshots are taken when a route settles (including the first screen), after a click settles, after a hover or keyboard focus that opened an overlay settles (triggers `hover` and `focus`, see below), after a resize settles and when the tab becomes visible again, never while it is hidden. `handle.snapshot()` takes one on demand. Each body is hashed (SHA-256 of the exact uncompressed bytes); a hash already sent in this page session is not sent again. With `endpoint`, the body is uploaded by `HEAD` then, only on 404, a gzip `PUT` to `/v2/snapshots/{sha256}`. The service must allow `HEAD`/`PUT` and the `Authorization` and `Content-Encoding` headers from your origin.

The walk runs in slices of idle time: the clock is checked every 8 elements and the walk yields once `maxSliceMs` has passed, so a slice overruns by at most one batch of 8. It stops at `maxElements` and marks the body `truncated`; a body larger than `maxSnapshotBytes` drops trailing rows and is also `truncated`. If the DOM, scroll position or viewport changes between slices the body is marked `torn`. Open shadow roots are traversed (slotted content under its slot); closed roots are one box. Canvas, iframes, embeds and video are one box flagged `opaque`. `display: none` subtrees are skipped. Content the browser does not render (the body of a closed `<details>`, `content-visibility: hidden`) is recorded without the visible flag. Subtrees matching `ignoreSelector`, `[data-layout-ignore]` or `[data-interactions-exclude]` are recorded as one box flagged `ignored` and never descended, so checks can skip them. Clip detection follows `overflow` and `contain: paint`; it does not model every case (for example absolutely positioned descendants escaping a non-positioned clipping ancestor).

## Click follow-through

Every click on a control starts a follow-through window. It ends when the page has been quiet (no DOM change, no observed request in flight) for `clickSettleMs`, and is reported as one `ui.click.settled` event: time to first visible feedback (DOM change, route change, dialog or focus move), settle time, counts of mutations, requests, failed requests, uncaught errors and long tasks, layout shift score, whether the route changed, a dialog opened or focus moved, and the screen hashes before and after. Since 0.3.0 it also says whether the click landed on a control (`target_interactive`), changed a field's value (`value_changed`, for example a checkbox), put focus in a text field (`field_focused`; true again for each click in a field that is already focused, where the caret is the effect) or opened a new tab or window (`new_context`). Since 1.0.0 it says whether the click's own press, or the page while the click was open, changed the text selection or moved the caret (`selection_changed`); positions are compared, the selected text is never read. Focus and selection count only as answers for `rage_click`; they are not feedback for `first_feedback_ms`, `dead_click` or `slow_feedback`. Focus or feedback caused by a later pointer or key input is not credited to an earlier open click. Its `interaction_id` is the click's `interaction.started` ID and its attribution is always `inferred`; requests observed in the window are counted there and never attached to the click as explicit. A second click before the first settles closes the first as `overlapped` (both are flagged) and nothing is counted for both. A click still open after `clickTimeoutMs`, or when the page is hidden or unloaded, is reported `incomplete`. Since 0.3.0 a click's `interaction.started` also carries `target_key`, an opaque per-session number for the element clicked (only equality means anything), and a click on a `<label>` is recorded once, as a click on its field's control (for example a `<button role="checkbox">` with a `<label for>`), not again when the browser forwards it to the field. A field's control is the nearest control above it, or the form it joins through the `form` attribute. Labels for disabled fields and links inside labels are clicks of their own.

## Hover and focus follow-through

Since 1.2.0 hovers and keyboard focus are followed like clicks (`hovers: false` turns this off).

- **Hover:** a mouse or pen pointer (never touch) that rests on a control for `hoverDwellMs` (default 150 ms). Leaving before then cancels it. The control is the nearest element, up to six levels above the pointer, that is interactive, matches a `:hover` rule in a same-origin style sheet (`.card:hover .title` makes `.card` one) or has a React hover handler, else the outermost element setting `cursor: pointer`.
- **Focus:** focus that matches `:focus-visible`, that is keyboard focus. Mouse focus on a button is not followed.

The window starts when the pointer arrives or focus lands, so a CSS transition that starts at once is inside it, and settles once nothing related happened for `hoverSettleMs` (default 600 ms) after the dwell; it is cut off after 5 seconds. A pointer press or key press ends it: what the click or key does is not the hover's. A window in which something happened is reported as one `ui.hover.settled` event (`kind` `pointer` or `focus`, `control_id`, route, `dwell_ms`, `settle_ms`) with booleans for what happened:

| Field | True when |
| --- | --- |
| `transition_started`, `animation_started` | A CSS transition ran (`transitionrun`) or an animation started on the control, an ancestor, or inside what appeared. |
| `nodes_added` | Elements were added anywhere in the root. |
| `overlay_opened` | A dialog, tooltip, menu, listbox or popover was added, shown by an attribute, class or style change, or opened as a popover. |
| `expanded_changed` | An `aria-expanded` attribute changed. |
| `class_changed`, `style_changed` | A `class` or inline `style` changed on the control, an ancestor, or inside what appeared. |

When an overlay opened, a snapshot is taken after settling (trigger `hover` or `focus`), so the layout checks run on what appeared, for example a tooltip that spills out of its card; the event carries its `snapshot_sha256`. `has_hover_handler` says whether the control or one of its three nearest ancestors has a React `onMouseEnter`, `onMouseOver`, `onPointerEnter` or `onPointerOver` handler: `true`, `false` for React elements without one, `null` on pages without React. Only the handler's type is read.

A hover or focus that changed nothing is not sent; it is counted in the next `perf.summary` as `hovers_silent` or `focus_silent`. A purely CSS change with no transition (a `:hover` background colour, a `display` toggled by a `:hover` rule) is not observed, so such a hover counts as silent. At most one event per kind, control and route is sent every `hoverRecordIntervalMs` (default 30 s), and at most `maxHoverRecordsPerMinute` (default 30) per page; hovers over the limit are not followed at all. Attribution is `unknown` and `interaction_id` is `null`. Nothing from the overlay's text, classes or styles is recorded.

## UI checks

`@codepress/interactions-browser/detect` turns snapshots and events into findings. The checks are pure functions over data: no `document`, no `window`, the same results in the browser, in Node and in a test runner ([Playwright helpers](https://github.com/quantfive/codepress-interactions/blob/main/packages/playwright/README.md)). By default the SDK runs them in idle time after each new snapshot, after each settled click and at each flush, and sends each finding as a `ui.finding` event once per fingerprint per page session (`findings: false` turns this off). The SDK remembers up to 2,000 sent fingerprints by recency: one found again counts as recent and is not resent, and past 2,000 the one gone longest without being found is forgotten, so it is sent again only if it comes back after that. A fingerprint found in the current run is never forgotten to make room, so a screen that keeps producing the same findings never resends them; if one run finds more than 2,000 new fingerprints, the rest wait for a later run. A click finding from before the first snapshot has no viewport yet, so it waits for the snapshot that gives it one (and with it the right width band and fingerprint); it is sent as it is only when the page is going away or the session takes no snapshots.

A finding is a pointer, not a verdict: it names the elements and carries `evidence`, measured facts only (numbers, booleans, or `null` for unknown). Whether it is a bug is for whoever reads it; checks do not filter by confidence.

| Check (`check`) | Reports |
| --- | --- |
| `layout.overlap` | Two elements whose visible boxes intersect by more than `overlapMinPx` in both directions, where neither contains the other. Subject is the element underneath. Evidence: overlap size, fraction of each covered, blocked hit-test points of controls underneath, whether the subject's rendered text is covered (`null` for opaque boxes), whether any of the subject's content (text, a control, an image or an opaque box) lies under the overlap (`subject_content_covered`), whether each element is a control (`subject_interactive`, `other_interactive`), CSS positions, depth to the shared parent, overlay flags, and `allow_marker_overridden` (an allow marker covered the pair but the cover sits on the centre of the control underneath, see below). |
| `layout.spill` | An element crossing its nearest `overflow: hidden/clip` ancestor by more than `tolerancePx`. Only the outermost spilling element is reported. |
| `layout.page_h_scroll` | The document is wider than the viewport; subject is the element reaching furthest right. |
| `layout.offscreen_control` | A control outside the area the page can scroll to (or, if fixed, outside the viewport). |
| `layout.small_tap_target` | A control smaller than `minTapTargetPx` in either direction, only for touch input. |
| `layout.clipped_text` | Rendered text cut off by a clipping box, unless it ends in an ellipsis or line clamp. |
| `click.dead_click` | A settled click on a control with no feedback, request, route change, dialog, focus move, value change, field focus or new tab. |
| `click.rage_click` | `rageClickCount` clicks on the same element of one control within `rageClickWindowMs`, while some click went unanswered. Different fields of one form are not one burst, and a label click (which the browser forwards to its field) is one click. A burst where every settled click was answered is not rage: visible feedback (a stepper, a toggle), a caret in a focused text field (`field_focused`), or a changed text selection (`selection_changed`, for example a triple-click selecting a line). One still settling is decided on a later run. Evidence: `click_count`, `span_ms`, `clicks_settled`, `clicks_with_feedback` (answered clicks; `null` with no click follow-through). |
| `click.slow_feedback` | First feedback after `slowFeedbackMs`, or none while requests ran that long. |
| `click.silent_failure` | A request failed during the click and the screen did not change. |
| `click.effect_not_applied` | Since 1.3.0, opt-in. The clicked control declared in its markup what the click must leave behind (see [Declaring a click's effect](#declaring-a-clicks-effect)), and it was not there when the click settled, or not after a reload in the same tab. `subject` is `null`; `control_id` is the clicked control; the fingerprint is check, route, band and `control_id`. Evidence: `effect` (1 removes, 2 adds, 3 sets, 4 saves), `expected_removed`, `expected_added`, `state_held`, `fields_saved`, `fields_reverted`, `present_at_settle`, `vanished_then_returned`, `present_after_reload`, `matches`, `request_count`, `request_failed_count`, `first_feedback_ms`, `settle_ms`, `dialog_opened`. `effectFindings(observation)` builds it from the same measurements in Node. |
| `click.error_after_click` | An uncaught error during the click. |
| `stability.stuck_busy` | A busy or progress indicator still showing after `stuckBusyMs`. |
| `stability.layout_shift` | A performance window's layout shift score at or above `layoutShiftScore`. |
| `stability.slow_input` | Slowest event timing at or above `slowInputMs`. |
| `stability.broken_image` | An image that finished loading with no image data. |
| `a11y.no_focus_indicator` | Keyboard focus reached `control_id` and nothing showed it: the computed outline (style, width, colour), box shadow, border colours and background colour of the element and its two nearest ancestors (a wrapper styled with `:focus-within`) were the same while focused and after focus left, and no transition or animation ran on them. Compared in the page when focus leaves; only the outcome is sent. `subject` is `null`. Evidence: `kind_focus` (always true), `indicator_changed` (false), `wrappers_compared`, `structural_id`. `focusIndicatorFindings(observation)` builds it from the same observation in Node. |
| `a11y.low_contrast` | Text below the WCAG 1.4.3 minimum: 4.5:1, or 3:1 for large text (24px or more, or 18.66px or more and bold). Evidence: `contrast_ratio` (rounded down to 2 places), `required_ratio`, `font_px`, `bold`, `theme_dark` (the snapshot's theme is dark). |
| `a11y.unnamed_control` | A shown control with an empty accessible name. Evidence: `has_title` (a blank `title` attribute), `has_icon_only` (it holds only an `svg`, `img` or `picture`, or is an image input). |
| `a11y.hover_only_content` | Only from a sweep (`sweepInteractions` in [`@codepress/interactions-playwright`](../playwright/README.md#hover-and-focus-sweep)); the SDK never sends it. Resting the mouse on `control_id` opened an overlay tied to it (a dialog, tooltip, menu, listbox, open popover, or a newly shown absolutely or fixed positioned layer with text or a control, inside the control or its parent, referenced by its `aria-describedby`, `aria-controls` or `aria-owns`, or within 16 px of it), again on a second hover, and keyboard focus on the same control did not, or could not reach it, so keyboard users never see that content (WCAG 1.4.13 and 2.1.1). `subject` is `null`; `snapshot_sha256` is the screen while hovered. Evidence: `hover_overlay` (true), `focus_overlay` (false), `focus_reached`, `structural_id`. `hoverOnlyFindings(observation)` builds it. |
| `motion.layout_animation` | A CSS transition or keyframe animation that animates a layout property (`width`, `height`, `top`, `left`, `right`, `bottom`, `margin*`, `padding*`, `inset*`). Evidence: `duration_ms`, `layout_props` (how many), `element_area_px`, `transition`, `infinite`. |
| `motion.stuck_animation` | A finite animation or transition with no end or cancel `stuckAnimationMs` after it started (a paused one does not count). Evidence: `elapsed_ms`, `duration_ms`. |
| `motion.offscreen_loop` | An infinite animation running longer than `offscreenLoopMs` on an element that is not visible: a zero-size box (including under `display: none`), outside the document or detached, `visibility: hidden`, inside an `aria-hidden="true"` subtree, or `opacity: 0` on it or an ancestor. Evidence says which (`zero_box`, `outside_document`, `visibility_hidden`, `aria_hidden`, `transparent`) and `elapsed_ms`. |
| `motion.janky_animation` | Long animation frames blocking the main thread more than 50 ms while an animation ran on a visible element. Evidence: `long_frames`, `max_blocking_ms`. Needs `long-animation-frame` performance entries; where the browser has none, this check does not run. |
| `a11y.reduced_motion_ignored` | The user asked for reduced motion (`prefers-reduced-motion: reduce`) and an animation or transition longer than 200 ms (or infinite) moved or faded (`transform`, `translate`, `rotate`, `scale`, `top`/`left`/`right`/`bottom`/`inset*`, `opacity`) an element covering at least 10% of the viewport. Evidence: `duration_ms`, `motion_props`, `element_area_px`, `viewport_area_ratio`. |

What is not reported as an overlap or spill: dialogs, menus, listboxes, tooltips and open popovers against what is beneath them (they are separate layers, as is a fixed full-screen backdrop); content crossing the edge of a scroller (that is scrolling); content scrolled under a sticky or fixed element (once the page has scrolled; at the page origin a fixed or sticky element covering content is reported); subtrees with `data-layout-ignore`; pairs allowed with [`data-layout-allow-overlap`](#allowing-a-designed-overlap); elements of 1×1 px or less. A `torn` snapshot gives no position-based findings; rows missing from a `truncated` one give none. Click checks use only windows that `settled`: a click whose page navigated away, timed out or was overlapped by another click gives no `dead_click`, and no `effect_not_applied` at settle.

### Motion checks

The `motion.*` checks and `a11y.reduced_motion_ignored` watch CSS animations and transitions as they run, so the SDK runs them in the page rather than over a snapshot. It listens for `animationstart`, `animationend`, `animationcancel`, `transitionrun`, `transitionend` and `transitioncancel` on `document` (capture phase, passive; hover and focus follow-through reads its starts from these same listeners), and observes `long-animation-frame` entries where the browser reports them. A started run is looked at in the next animation frame, in batches: its animation's timing and keyframe property names (from `getAnimations()` and `getKeyframes()`), and one `getBoundingClientRect` per element. Animation names, property names and values are read only to match events to animations: a finding carries numbers and booleans, never them. A timer runs only while something animates: at a run's `stuckAnimationMs` or `offscreenLoopMs` deadline, and while infinite animations run, to look at whether the looping elements are visible (at most 100 elements per sweep; an element seen visible is looked at again after twice as long each time, up to 16 times `offscreenLoopMs`). Looks fall on a grid of half `offscreenLoopMs`, so loops that started at different times share a sweep: on a page with many animations, the first layout read in a task recalculates style for all of them, and the reads after it cost little. Infinite animations no event announced (ones that started before the SDK, or were started with the Web Animations API (`element.animate`), which keeps running under `display: none` where CSS animations stop) are found with `document.getAnimations()`, whose cost grows with every animation on the page, so it runs a loop window after the SDK starts, then again after twice as long each time it finds nothing new; what it finds is sorted in slices of at most 4 ms. Loops inside an `aria-hidden` subtree, which need no layout to suspect, are looked at first. Once 50 offscreen loops have been reported, the looks stop. A page with no animation schedules nothing. Each motion check reports an element at most once per route and at most 50 elements per page session; at most 256 runs are followed at a time (64 infinite ones by event; up to 1,024 more by the looks alone). The subject is the animated element, identified as in a snapshot (test ID or structural path) with `index` -1, since it is not a snapshot row; `snapshot_sha256` is the latest snapshot's. Turn checks off with `detect.checks` like any other.

Sorting puts blocked controls first (any `*_blocked_points` > 0), then covered or clipped text, then the rest, then decorative or empty findings. Inside the rest, findings that involve a control come first: a small tap target, an offscreen control, a click finding, an overlap or spill where an element is a control (`*_interactive`), or an outer pair that blocks a control inside its subject (`subject_blocked_controls` > 0, such as `main × widget`); `involvesControl(finding)` says which. Then by check, in order found. It never drops a finding. A finding is decorative or empty when one of its elements is a decorative layer (`*_decorative`: no text, no control, and `pointer-events: none` or `aria-hidden`), none of its elements holds text or a control (`*_has_content: false`, for example stacked or cropped images), or an overlap covers none of the subject's content (`subject_content_covered: false`). `findingTier(finding)` gives the tier, 0 to 3. The earlier tiers win: a decorative layer that covers text sorts with covered text. Overlap evidence also has `subject_text_covered_ratio`, the share of the subject's rendered text area that is covered.

### Allowing a designed overlap

Some overlaps are the design: a status badge on an avatar's corner, a sticky header over content. Allow one in the component's own markup with `data-layout-allow-overlap` on either element of the pair. Its value is a space-separated list of the other element's test IDs (its `data-interaction-id` or `data-testid` value, matched as written, before the [test ID filter](#test-ids-and-privacy), so an ID the filter keeps out of the body still works), or `*` for any element.

```html
<div data-testid="avatar">…</div>
<span data-testid="status" data-layout-allow-overlap="avatar">●</span>
```

- It applies to the overlap check only, and only to that pair: the elements stay in every other check, unlike `data-layout-ignore`. A pair nested inside the allowed one (the avatar's `<img>` under the badge) is covered with it, because a collision is reported once, as its outermost pair.
- It gives way when the cover makes a control unusable: if the element underneath is a control and the other element covers its centre hit-test point (`center_blocked`), the overlap is reported as before, with `allow_marker_overridden: true`.
- The marker's value never leaves the page. The snapshot walk resolves it there: the element gets the `allow_overlap` flag, and the body's `allow_overlap` table lists the row pairs it allows (`other` is `-1` for `*`), only for pairs whose boxes intersect, at most 10,000. Node-side checks read the table, so they give the same answer as the browser. Bodies from SDKs before 1.2.0 have no table, and nothing is allowed in them.

### Declaring a click's effect

A click can get a response and still not do its job: you press Remove, a spinner shows, the request succeeds, and the item is still there, or it disappears and comes back, or it comes back after a reload. Since 1.3.0 a control can say in its markup what its click must leave behind, and the SDK checks it (`click.effect_not_applied`). Put one of these on the control (a button, link or `role="button"` element, or an element inside one; a field inside a form counts too). Test IDs are matched as written, against `data-interaction-id` or `data-testid`, before the [test ID filter](#test-ids-and-privacy).

| Attribute | The click must |
| --- | --- |
| `data-interaction-removes` | Empty: remove the nearest ancestor `[data-interaction-item]`. Otherwise a space-separated list of test IDs: each must match fewer elements than at the click. |
| `data-interaction-adds="<test id> …"` | Make each test ID match more elements than at the click. |
| `data-interaction-sets="<test id>:<state> …"` | Leave every element with that test ID in `<state>`: `checked`, `pressed`, `expanded` or `selected` (`aria-checked`, `aria-pressed`, `aria-expanded` or `aria-selected` is `"true"`; a native checkbox or radio without `aria-checked` uses its `checked`), or `data-state=<literal>` (its `data-state` equals the literal). |
| `data-interaction-saves="<field test id> …"` | Leave each named field (the element, or the first input, textarea, select or editable region inside it) showing the value it had at the click. Password fields are never read. |
| `data-interaction-item="<key>"` | Marks an item for `removes`. The item is found again by its key, never by its element, so a row re-rendered as a new element (a new React key) is still there. Give every item a key: an item without one is followed by its element, and only until the page unloads. |

```html
<li data-interaction-item="{invite.id}">
  {invite.email}
  <button data-interaction-removes>Remove</button>
</li>
<button role="switch" aria-checked="false" data-testid="notify" data-interaction-sets="notify:checked">Notify me</button>
<button data-interaction-sets="github:data-state=connected">Connect</button>
<button type="submit" data-interaction-saves="display-name bio">Save</button>
```

- **When it is checked.** The contract is read when the click starts, from the first of the four attributes the control carries (in the order above). When the click settles, its targets are looked up again: a target missing from the DOM, or under a `hidden` attribute, counts as removed (a virtualized list may simply not render it). While the click is open, removals are watched, so an item that disappears and comes back (an optimistic remove rolled back) is reported with `vanished_then_returned`. A click that navigated, was overlapped by another click, timed out or opened a dialog is not judged: put the marker on the dialog's confirm button. A marker whose targets were not on the page at the click (a removes target) or at settle (a sets target or saves field) is not judged either.
- **After a reload.** When the effect held at settle, or the click was cut short by the page unloading or being hidden (a form post, a reload, a switch to another tab), the click is checked again on the next load of the same page path in the same tab, within 10 minutes, after that load's first snapshot (with `snapshots: false`, `routeSettleMs` after the SDK starts). An item that is back, an addition that is gone, a state that does not hold, or a saved field that shows another value is reported then, with `present_after_reload` or `state_held: false` or `fields_reverted`, and `interaction_id` `null`. A click that already failed at settle is reported once, then, and not again after a reload. A `sets` marker names a single state: on a switch that turns both ways, render the marker only in the state it turns on from, for example `data-interaction-sets={on ? undefined : "notify:checked"}` (it is read at the click, before the page re-renders).
- **What is recorded.** Only counts and booleans, in the finding's evidence. Test IDs, item keys, state literals and field values never leave the page. What waits for the next load is kept in `sessionStorage` under `codepress-interactions:effects`, at most 16 entries: the page path, the target test IDs and item keys, the state literals and each field's value as salted SHA-256 hashes (the salt is made for each page load and kept beside them), the number of elements each target matched, the control's `control_id` (the value its click events already carry), timing and request counts, and a deadline. None of it is sent. Without `sessionStorage` (blocked or full) there is no reload check and no error.
- Values are compared exactly: a form that reformats a saved value (trimming, a phone number format) shows a different value. Leaving `effect_not_applied` out of `detect.checks`, or `findings: false`, turns the check off, and nothing is read or stored. Pages without the attributes do nothing new.

### Accessibility measurements

Contrast and accessible names are worked out in the page during the snapshot walk; only numbers and booleans are recorded, never colours, labels or text.

**Contrast.** For each visible element with its own text that is not `aria-hidden`, the walk takes the computed `color` (alpha composited) and the background behind it: each ancestor's `background-color`, alpha composited down onto the canvas (white, or black when the root's `color-scheme` or a `color-scheme` meta tag makes it dark). The ratio is WCAG 2.x relative luminance, rounded down to 2 places so a ratio just under a threshold never reads as meeting it. The body's `contrast` table lists only text below 4.5:1, since text at or above it meets the minimum at every size; font size and weight are read only for that text. Contrast is worked out for the first `maxContrastElements` text elements of each snapshot (default 2000). Disabled and `aria-disabled` controls, and text inside them, are exempt and not measured. The contrast is unknown, and the text is left out, when there is a `background-image` or gradient behind it, a `filter`, `mix-blend-mode` or `opacity` below 1 on it or an ancestor, a colour outside sRGB, text outside the ancestors' background boxes, or a positioned element that paints its own layer (a background, image, video, canvas or SVG) overlapping it and not containing it. To keep the walk cheap, filters, blend modes and overlapping positioned layers are looked for only around text that measures below 4.5:1: text at or above 4.5:1 under a filter or an overlapping layer counts as meeting the minimum and is not counted as unknown. A dialog over its scrim is still measured: its own opaque, positioned background is later in the page and at least as high in z-index, so it paints over the scrim. Each `perf.summary` counts the unknowns of the new screens in its window as `contrast_unknown`. Images and video placed behind text by other means (a static sibling pulled under it with negative margins) are not modelled. Hover and focus colours are not measured.

**Accessible names.** For each visible, enabled control with a role (the controls the `interactive` flag covers) that is not `aria-hidden`, the name is empty when none of these give text: `aria-labelledby` targets, `aria-label`, an associated `<label>` (excluding the control itself), `alt` of an image input, `title`, `placeholder`, the control's own content (for roles named from content: buttons, links, checkboxes, radios, switches, tabs, menu items, options and tree items; content counts text, descendants' `aria-label`, `alt` and SVG `<title>`, skipping `aria-hidden` subtrees) or the `value` of a button-type input. A submit or reset input without a `value` has the browser's default name. Text hidden with `display: none` inside a control is still counted as content. This is not a full accessible name computation or a replacement for an accessibility audit.

#### What the measurements cost

Both measurements run inside the snapshot walk. Contrast reads three computed styles that the walk otherwise does not (`background-color` and `background-image` up the ancestors, `color` on text), and that is most of its cost. Walk CPU on the [overhead bench](https://github.com/quantfive/codepress-interactions/blob/main/packages/browser/scripts/overhead.mjs) page (Apple M1 Max, headless Chromium, one cold walk per fresh page, median / p95 of 21 runs), before these measurements and with them at the defaults:

| Elements | 1×, before | 1×, with | 4×, before | 4×, with |
| --- | --- | --- | --- | --- |
| ~500 | 6.1 / 6.4 ms | 7.1 / 7.7 ms (+16%) | 31 / 36 ms | 37 / 42 ms (+20%) |
| ~2,000 | 16.4 / 17.2 ms | 19.1 / 19.8 ms (+16%) | 76 / 83 ms | 86 / 96 ms (+14%) |
| ~5,000 | 34.9 / 35.8 ms | 39.5 / 42.2 ms (+13%) | 164 / 170 ms | 183 / 188 ms (+12%) |

The walk stays sliced (`maxSliceMs`), so this is more slices, not longer tasks. To spend less:

- `maxContrastElements` (default 2000) caps the text elements whose contrast is worked out per snapshot, in page order; text past the cap is not measured. A lower cap makes long pages cheaper; `0` turns contrast off.
- Leaving `low_contrast` out of `detect.checks` turns contrast off in the walk too (no colour reads, and the body has no `contrast` table); leaving `unnamed_control` out skips the name lookups (no `unnamed_controls` table). With both left out the walk is back to its cost before them: 16.5 / 17.6 ms at 1× and 77 / 87 ms at 4× for ~2,000 elements.

### Measured behaviors worth knowing

These are reported as measured. Each finding carries the evidence that says what it is, so a reader can decide without guessing.

- **A fixed widget next to `<main>` is reported against `<main>`.** A chat button that is `position: fixed` and a sibling of `<main>`, sitting over a button inside it, is reported as `main × chat`, not `save × chat`. A collision repeated by nested elements collapses to its outermost pair, and that pair's evidence covers everything inside it. The covered button still shows up: `subject_blocked_points` and `subject_blocked_controls` count its blocked hit-test points, so the finding sorts first, and the subject's `index` points at `<main>`'s row, inside which the snapshot holds the button.
- **A fixed header over a padded `<main>` is reported, as empty.** At the page origin, a `position: fixed` header over `<main style="padding-top: 64px">` intersects `<main>`'s box, so it is reported as `main × header`. Its evidence says nothing is under it: `subject_blocked_points: 0`, `subject_text_covered: false` and `subject_content_covered: false`. It sorts with decorative and empty findings. If it is how your layout is meant to be, put `data-layout-allow-overlap="*"` on the header (it stays in every other check), accept it with `ignoreFingerprints` in tests, or put `data-layout-ignore` on the header. Once the page has scrolled, content under a fixed header is scrolling and is not reported.
- **A label click that the browser does not forward, and that changes nothing, is a dead click.** A click on label content the browser does not forward to the field (a nested button, a link, the body of a `<details>`, an `<img usemap>` with an empty map), or on a label for a hidden or disabled field, is a click of its own. When nothing happens it gives `dead_click` on the label's control (for example the form), with `target_interactive: true` because a label counts as a control. A label for a disabled field gives the same.
- **A field joined to another form belongs to that form.** A field with the `form` attribute, and any label for it, is recorded on the form it joins, wherever it sits in the DOM: one label click is one `interaction.started` on that form.

The fingerprint is 32 hex characters of SHA-256 over the check, the route template, the viewport width band and the elements' `stable_id`, never coordinates, scroll offsets or text. It is the same for the same bug at another scroll offset, in another session or on another machine. `stable_id` is the test ID or, when there is none or it was [filtered out](#test-ids-and-privacy), a structural tag path from the nearest ancestor with a test ID (`#cart/div/button`); evidence `subject_structural_id` / `structural_id` says so. Structural paths change when the markup does, and siblings with the same tags share one.

```ts
import { checkEvents, checkSnapshot, formatFinding } from "@codepress/interactions-browser/detect";

const findings = [...checkSnapshot(body, { sha256 }), ...checkEvents(batch.events)];
// Motion checks are pure too: checkMotion(runs) takes observed runs (`MotionRun`), which the SDK builds in the page.
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
| `stuckAnimationMs` | 10000 | A finite animation or transition with no end this long after it started. |
| `offscreenLoopMs` | 5000 | An infinite animation running this long on an element that is not visible. |
| `now` | last event time (SDK: current time) | When `stuckBusyMs` is measured. |

## Performance signals

Layout shifts, event timing (40 ms and slower), long tasks, image load errors and uncaught errors/unhandled rejections are counted and sent as `perf.summary` events, with the hovers and keyboard focuses that changed nothing (`hovers_silent`, `focus_silent`, since 1.2.0, absent when zero, so always absent with `hovers: false`). Since 1.2.0 a summary also carries `contrast_unknown`, absent when zero: how many text elements on the new screens snapshotted in its window had a contrast that could not be measured. Each API is feature-detected: a signal the browser does not support is `null` and listed in `unavailable`, never reported as zero. Error messages, stacks, file names and image URLs are not read.

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

A sink that sends over the network gets `context` as its last argument: `keepalive` (the page is unloading; keep it small and use `fetch`'s `keepalive`), `signal` (aborted at the timeout or when capture stops) and `fetch`, the page's `fetch` without the SDK's wrapper. Use `context.fetch` so the sink's own uploads are not recorded as the app's requests, which would also make every flush cause another. Requests a sink starts before its first `await` are skipped whichever `fetch` or `XMLHttpRequest` they use; later ones are recorded unless they use `context.fetch`. [`examples/react-vite`](https://github.com/quantfive/codepress-interactions/blob/main/examples/react-vite) has a sink that writes files through the Vite dev server.

```ts
const sink: InteractionSink = {
  async sendBatch(_batch, serialized, { keepalive, signal, fetch }) {
    const response = await fetch("/my-collector/batches", { method: "POST", body: serialized, keepalive, signal });
    return response.ok ? "accepted" : response.status >= 500 ? "retry" : "rejected";
  },
  async sendSnapshot({ sha256, serialized }, { signal, fetch }) {
    await fetch(`/my-collector/snapshots/${sha256}`, { method: "PUT", body: serialized, signal });
  },
};
```

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `endpoint` + `projectKey` | | Hosted service base URL and public key. |
| `sink` | | Alternative to `endpoint`. |
| `release` | none | Bounded release label sent with every batch. |
| `routeSegments` | none | Static lowercase path words the default route template keeps, e.g. `["orders", "items"]`. |
| `routeTemplate(url)` | every path segment `:id` unless in `routeSegments`; no query or hash | Return a bounded route label such as `/orders/[id]`. Values with a query or unsafe characters are dropped. |
| `testId(value, element)` | `defaultTestIdFilter` | Which test IDs are recorded; see [Test IDs and privacy](#test-ids-and-privacy). |
| `requestLabel(url, init)` | none | Bounded static label for an observed request (`[A-Za-z0-9_.:/-]`, 64 characters). |
| `propagateHeader` | `X-Interaction-Id` | Correlation header name for allowed origins; `false` sends none. A readable `X-Trace-Id` response header is recorded. |
| `snapshots` | `true` | Turn screen snapshots off. |
| `maxElements` | 5000 (max 50,000) | Elements per snapshot before `truncated`. |
| `maxSliceMs` | 6 (max 50) | Main-thread time per walk slice. |
| `maxSnapshotBytes` | 1,500,000 | Uncompressed body cap. |
| `maxContrastElements` | 2000 (max 50,000; 0 turns it off) | Text elements per snapshot whose contrast is worked out, in page order. Later text is not measured and not counted in `contrast_unknown`. The knob for a cheaper walk: see [what the measurements cost](#what-the-measurements-cost). |
| `maxSnapshotsPerSession` | 100 | Walks per page session. |
| `routeSettleMs` | 1000 | Wait after a route change (and the first load) before a snapshot. |
| `clickSettleMs` | 500 | Quiet time that ends a click's follow-through. |
| `clickTimeoutMs` | 10000 | Longest follow-through before `incomplete`. |
| `hovers` | `true` | Follow hovers and keyboard focus, and run the focus indicator check. |
| `hoverDwellMs` | 150 | How long a mouse or pen pointer must rest on a control. |
| `hoverSettleMs` | 600 | Quiet time after the dwell (or focus) that ends a hover's follow-through. |
| `hoverRecordIntervalMs` | 30000 | At most one `ui.hover.settled` per kind, control and route in this time. |
| `maxHoverRecordsPerMinute` | 30 | `ui.hover.settled` events per minute per page. |
| `resizeSettleMs` | 500 | Quiet time after the last resize. |
| `visibleSettleMs` | 300 | Delay after the tab is visible again. |
| `ignoreSelector` | none | Extra subtrees recorded as one `ignored` box. |
| `findings` | `true` | Run the UI checks and send `ui.finding` events. |
| `detect` | defaults above | UI check thresholds. |
| `theme` | `prefers-color-scheme` | `() => "light" \| "dark" \| "unknown"`: the theme actually showing, for apps with their own toggle. Read at every snapshot; any other value, or a throw, is recorded as `unknown`. |

The transport options above (`maxQueueEvents`, `flushIntervalMs`, …) keep their v1 defaults.

# Changelog

The three npm packages (`@codepress/interactions-browser`, `@codepress/interactions-react`, `@codepress/interactions-playwright`) were released together at 1.0.0; a later release bumps only the packages whose code changed. 1.0.0 is the first release published to npm; earlier versions were developed in this repository only. Versions follow [Semantic Versioning](https://semver.org): within 1.x, options, exports and protocol v2 fields are only added, never removed or changed in meaning. A check whose meaning changes gets a new `check_version`.

The Python SDK in `python/` is versioned separately and is not covered by 1.0.

## Unreleased

### Added

- `data-layout-allow-overlap` allows a designed overlap (an avatar's status badge, a sticky header over content) for one pair and the overlap check only, in the component's markup. Put it on either element; its value is the other element's test IDs (space-separated, matched before the test ID filter) or `*`. It gives way when the cover sits on the centre of a control: then the overlap is reported with `allow_marker_overridden: true`. See [Allowing a designed overlap](packages/browser/README.md#allowing-a-designed-overlap). The Playwright helpers honour it with no change.
- Protocol v2, additive: snapshot flag `allow_overlap` (16384) on elements carrying the marker, an optional `allow_overlap` table of allowed row pairs in the snapshot body (the marker's value is never recorded), and the overlap evidence key `allow_marker_overridden`.
- `@codepress/interactions-browser`: hover and keyboard-focus follow-through. A mouse or pen pointer resting on a control for `hoverDwellMs` (150 ms), or keyboard focus (`:focus-visible`), is followed like a click; when something happens it is sent as a new `ui.hover.settled` event (`kind`, `control_id`, `route_template`, `dwell_ms`, `settle_ms`, booleans `transition_started`, `animation_started`, `nodes_added`, `overlay_opened`, `expanded_changed`, `class_changed`, `style_changed`, `snapshot_sha256`, `has_hover_handler`). Touch is never a hover. Limited to one event per kind, control and route every 30 s and 30 per minute per page. New options `hovers`, `hoverDwellMs`, `hoverSettleMs`, `hoverRecordIntervalMs`, `maxHoverRecordsPerMinute`. See [Hover and focus follow-through](packages/browser/README.md#hover-and-focus-follow-through).
- Snapshot triggers `hover` and `focus`: taken when a hover or keyboard focus opened a dialog, tooltip, menu, listbox or popover, so the layout checks run on it.
- `perf.summary` gains `hovers_silent` and `focus_silent`, the hovers and keyboard focuses that changed nothing. Each is absent when zero, so with `hovers: false` a summary is the same as before.
- Check `a11y.no_focus_indicator`: keyboard focus with no visible change to the outline, box shadow, border or background of the element or its two nearest ancestors. `focusIndicatorFindings` in `@codepress/interactions-browser/detect`.
- Protocol v2, additive: the `ui.hover.settled` event, the two trigger values, the two summary fields and the check name. A receiver must accept them before an SDK that sends them is deployed.
- `a11y.low_contrast`: text below the WCAG 1.4.3 contrast minimum (4.5:1, or 3:1 for large text), measured in the page. Evidence: `contrast_ratio`, `required_ratio`, `font_px`, `bold`, `theme_dark`. Colours never leave the page. See [Accessibility measurements](packages/browser/README.md#accessibility-measurements).
- `a11y.unnamed_control`: a shown control with no accessible name. Evidence: `has_title`, `has_icon_only`. Labels and text never leave the page.
- Snapshot bodies carry two optional tables, `contrast` (element, ratio, font size, bold) and `unnamed_controls` (element, `has_title`, `icon_only`). Older bodies without them still validate and give no a11y findings.
- `perf.summary` carries `contrast_unknown`: text on new screens whose contrast could not be measured (an image or gradient behind it, opacity, or, for text below 4.5:1, a filter, blend mode or overlapping positioned layer).
- `maxContrastElements` caps the text whose contrast is measured per snapshot (default 2000; 0 turns it off). Leaving `low_contrast` or `unnamed_control` out of `detect.checks` skips that measurement in the walk too, and its table is left out of the body.
- The overhead bench (`scripts/overhead.mjs`) takes `--src` (measure another checkout), `--options` (SDK options), `--sizes`, `--throttles` and `--snapshots-only`, and reports walk CPU p95 next to the median.
- `@codepress/interactions-playwright`: `sweepInteractions(page, options?)` hovers and then keyboard-focuses every visible control (up to `maxControls`, 200), runs the checks at rest and after each hover and focus settles, and returns `{ findings, controls, skipped }` with each finding once per fingerprint; `expectNoSweepFindings` fails a test on any of them. New options `maxControls`, `hover`, `focus` and `settleMs`. See [Hover and focus sweep](packages/playwright/README.md#hover-and-focus-sweep).
- Check `a11y.hover_only_content`, from a sweep only: hover opened an overlay and keyboard focus on the same control did not. `hoverOnlyFindings` in `@codepress/interactions-browser/detect`. The browser SDK never sends it, so receivers need no change; the check name fits the existing `check` pattern.
- The page script (`@codepress/interactions-browser/page-script`) gains `hook(source)` and `sweep(setup)`, the in-page half of a sweep, built on the hover and focus follow-through.
- Motion checks in `@codepress/interactions-browser`: `motion.layout_animation` (a transition or keyframe animation on a layout property), `motion.stuck_animation` (a finite animation with no end after `stuckAnimationMs`, default 10 s), `motion.offscreen_loop` (an infinite animation running over `offscreenLoopMs`, default 5 s, on an element that is not visible), `motion.janky_animation` (long animation frames over 50 ms of blocking during a visible animation, where `long-animation-frame` is supported) and `a11y.reduced_motion_ignored` (a large move or fade over 200 ms while the user asks for reduced motion). The SDK observes animation and transition events on `document` and sends these as `ui.finding` events; no new event type and no protocol change. See [Motion checks](packages/browser/README.md#motion-checks).
- `checkMotion(runs, options)` and the `MotionRun` type in `@codepress/interactions-browser/detect`; `detect()` takes `motion` runs too.
- Detect options `stuckAnimationMs` and `offscreenLoopMs`.

### Changed

- Hover and focus follow-through reads animation and transition starts from the motion checks' listeners, so the page has one set of `animationstart` and `transitionrun` listeners. Hover events are unchanged.
- Click follow-through runs on a follow-through observer shared with hovers and focus (the same mutation observer configuration, settle and timeout timers and dialog detection). Click events are unchanged.

## 1.1.0

`@codepress/interactions-browser` and `@codepress/interactions-playwright`. `@codepress/interactions-react` has no code change and stays at 1.0.0; its `^1.0.0` dependency picks up this browser release, and its `InteractionOptions` type gains `testId`.

### Added

- `testId` option: `(value, element) => string | null` decides which `data-interaction-id` and `data-testid` values are recorded, everywhere one is read. It replaces the default. A hook that throws, or returns anything other than a string or `null`, drops the ID. See [Test IDs and privacy](packages/browser/README.md#test-ids-and-privacy).
- `defaultTestIdFilter` export, to call the default from a hook.
- `@codepress/interactions-playwright`: `testId` option on `captureSnapshot`, `findIssues` and `expectNoFindings`. It runs in the page, so it must be self-contained; a hook that uses a name missing from the page fails the capture. `globalThis.__codepressInteractions.defaultTestIdFilter` is there for a hook to call.

### Changed

- Test IDs that look built from data are no longer recorded. With no hook, a value is dropped when it contains a `.`, or has a segment (split on `-`, `_`, `.` or `:`) that contains a digit or is longer than 32 characters. Values such as `item-42` and `row-example.com` previously left the page in the snapshot dictionary, `control_id` and `stable_id`. The fields keep their shape and are absent more often; there is no protocol change.
- A click's tag path `control_id` is cut to the protocol's 128 characters, keeping the end nearest the control. Long custom element names could exceed it and make a batch invalid.
- `initInteractions` no longer joins a runtime from an older copy of the SDK on the same page, which would ignore options it does not know. The second caller gets an inactive handle.
- Findings on an element whose ID is now dropped use its structural path, so their fingerprint changes. Fingerprints in `ignoreFingerprints` lists for those elements need updating, and elements that shared a per-record pattern now share one finding.

## 1.0.0

First public release.

### Added

- `ui.click.settled` reports `selection_changed`: the click's press, or the page while the click was open, changed the text selection or moved the caret. Positions are compared; selected text is never read.
- Overlap evidence: `subject_content_covered` (whether any of the subject's text, controls, images or opaque boxes lie under the overlap), `subject_interactive` and `other_interactive`.
- `findingTier(finding)` and `involvesControl(finding)` in `@codepress/interactions-browser/detect`.
- Sinks get `context.fetch`, the page's `fetch` without the SDK's wrapper.
- `@codepress/interactions-react` is published, with its own publish workflow.
- A runnable example ([`examples/react-vite`](examples/react-vite)) that writes snapshots and findings to local JSON, and a portable agent skill ([`skills/fix-ui-findings`](skills/fix-ui-findings/SKILL.md)).
- [Protocol guide](protocol/README.md), contributing guide and issue templates.

### Changed

- Sorting: inside the "rest" tier, findings that involve a control come first. An overlap that covers none of the subject's content (a fixed header over a padded `<main>`) sorts with decorative and empty findings. It is still reported.
- `click.rage_click` treats a caret in a focused text field, or a changed selection, as an answer. Repeated clicks in one field, or a triple-click selecting a line, are no longer a rage burst; a dead button still is.
- Sent fingerprints are remembered by recency, up to 2,000. A fingerprint found again is not resent; past the limit, the one unseen for longest is forgotten. A fingerprint found in the current run is never evicted, so a screen that keeps producing more than 2,000 findings does not resend them.
- A sink's own requests are no longer recorded as the app's: requests started before the sink's first `await`, and any made with `context.fetch`. A same-origin sink previously made every flush record requests that caused the next flush.
- When hit tests cannot tell which of two overlapping elements is on top (a `pointer-events: none` cover), a positioned ancestor they share no longer counts for either side. A static button inside a `position: relative` card was treated as positioned, so a badge over it could be reported as covered by the button.
- `involvesControl` is also true when a finding blocks a control inside its subject (`subject_blocked_controls` > 0), such as `main × widget`.
- The React and Playwright publish workflows do not publish until npm has the browser version they depend on; until then they warn and skip.
- `sortFindings`, `formatFinding` and `involvesControl` accept `ui.finding` data as a sink receives it (`FindingData`), not only `Finding`.
- A field joined to a form through the `form` attribute, and any label for it, is recorded on that form. A click on such a field outside any form element was previously not recorded.

## 0.3.0

Not published.

- `@codepress/interactions-browser/detect`: pure checks over snapshots and events (overlap, spill, page horizontal scroll, offscreen controls, small tap targets, clipped text, dead, rage, slow and silently failing clicks, errors after a click, stuck busy states, layout shift, slow input, broken images), with measured evidence, fingerprints and sorting. The SDK runs them in idle time and sends `ui.finding` events.
- `@codepress/interactions-playwright`: `captureSnapshot`, `findIssues`, `expectNoFindings`.
- Snapshots record theme, coarse pointer, open popovers, ellipsis, broken images and `aria-hidden`. Clicks record `target_key`, `target_interactive`, `value_changed`, `field_focused` and `new_context`.

## 0.2.0

Not published.

- Protocol v2: screen snapshots (columnar element boxes, text boxes, hit tests), click follow-through, performance summaries, findings.
- Pluggable sinks (`sink`, `createMemorySink`, `createHttpSink`), route templates with `routeSegments`, `routeTemplate`, `requestLabel`, `propagateHeader` and `release` options.

## 0.1.0

Not published.

- Browser SDK: clicks, submits, navigation, structural UI changes and allowed-origin requests, with explicit `runAction` correlation.
- Python SDK for Django and Celery (protocol v1).
- Optional React adapter.

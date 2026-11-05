# Changelog

All three npm packages (`@codepress/interactions-browser`, `@codepress/interactions-react`, `@codepress/interactions-playwright`) share one version. 1.0.0 is the first release published to npm; earlier versions were developed in this repository only. Versions follow [Semantic Versioning](https://semver.org): within 1.x, options, exports and protocol v2 fields are only added, never removed or changed in meaning. A check whose meaning changes gets a new `check_version`.

The Python SDK in `python/` is versioned separately and is not covered by 1.0.

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

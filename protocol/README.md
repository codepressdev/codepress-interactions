# Wire protocol

What the browser SDK sends, as JSON Schema (draft 2020-12) with a real sample of each. Anything that receives the SDK's output reads these: a sink you write, a service, or an agent reading files on disk.

| File | What it is |
| --- | --- |
| [`v2-batch.schema.json`](v2-batch.schema.json), [`v2-batch.json`](v2-batch.json) | An event batch: clicks, click follow-through, snapshots taken, findings, performance summaries, requests. |
| [`v2-snapshot.schema.json`](v2-snapshot.schema.json), [`v2-snapshot.json`](v2-snapshot.json) | One screen as element boxes (a snapshot body). |
| [`v1-batch.schema.json`](v1-batch.schema.json), [`v1-batch.json`](v1-batch.json) | The v1 batch, still sent by the Python SDK. |
| [`generate-v2.mjs`](generate-v2.mjs) | Source of the v2 schemas. Edit this, then run `node protocol/generate-v2.mjs protocol`. Never edit the generated `.schema.json` files by hand. |

The two samples come from a real browser run (`UPDATE_GOLDEN=1 pnpm --filter @codepress/interactions-browser test:browser golden`); only IDs and timestamps are fixed.

## Batches

A batch is `{ batch_id, schema_version: 2, sdk_version, release, events }` with 1 to 200 events. A retry sends the same bytes with the same IDs, so a receiver can deduplicate on `batch_id` and on each `event_id`.

Every event has the same envelope: `event_id`, `interaction_id` (the click or action it belongs to, or `null`), `source`, `source_instance_id` (one per page session), `sequence`, `occurred_at`, `type`, `attribution` and `data`. `attribution` says how the event was tied to an interaction: `explicit` (inside `runAction`), `inferred` (by timing, such as click follow-through) or `unknown`.

| `type` | `data` |
| --- | --- |
| `interaction.started` | A click or submit: `action`, `control_id` (a test ID that passed the SDK's filter, or a short tag path) and, for clicks, `target_key` (an opaque per-session number for the element clicked; only equality means anything). |
| `ui.click.settled` | What followed a click until the page went quiet: time to first feedback, settle time, mutation, request, failure, error and long task counts, layout shift, whether the route changed, a dialog opened, focus moved, a value changed, a field took focus, the selection changed or a new tab opened, and the screen hashes before and after. |
| `ui.snapshot` | A snapshot was taken: its `sha256`, trigger, route template, viewport, theme, element count, size, and walk timing. The body itself travels separately. |
| `ui.finding` | A check matched (see below). |
| `perf.summary` | Layout shifts, event timing, long tasks, image and script errors since the last summary. A signal the browser does not support is `null` and listed in `unavailable`, never `0`. |
| `ui.state.changed`, `request.started`, `request.completed`, `capture.*`, `operation.*` | The v1 events, unchanged. |

## Snapshot bodies

A body is columnar: every array under `elements` has `element_count` entries, and row `i` of each array describes the same element. Rows are in depth-first order, so a parent always comes before its children. Strings (tags, roles, test IDs) are indexes into `dictionaries`. `legend` repeats the decoding tables in every body, so a body can be read on its own.

- `elements`: parent row, tag, role, test ID, `x`/`y`/`width`/`height` in viewport CSS pixels, z-index, CSS position, a flags bitmask (see `legend.flags`) and the length of the element's own text.
- `text_boxes`: for elements with direct text, the box the rendered text occupies and its line count. Geometry only.
- `hit_tests`: for visible controls, how many of five points (center and four inset points) land on something else, which ones, and the row on top.
- `allow_overlap` (optional, since 1.2.0): overlaps the page allows with `data-layout-allow-overlap`, as row pairs (`other` is `-1` for any element). The marker's value is resolved in the page and never recorded. Absent when no element carries the marker.
- `truncated`: the walk stopped at its element or byte limit. `torn`: the page changed between slices of the walk, so positions may not belong to one moment.

The body's `sha256` is over its exact uncompressed UTF-8 bytes. A body is identified by that hash and sent once per page session.

## Findings

`ui.finding` data is `{ check, check_version, fingerprint, route_template, snapshot_sha256, viewport_width, viewport_height, subject, other, control_id, evidence }`.

- `subject` and `other` point at rows of the snapshot (`index`) and carry the element's tag, role, test ID, `stable_id` and box, so a finding can be read without the body.
- `evidence` holds measured facts only: numbers, booleans, or `null` for unknown, at most 32 keys. It never holds text or a verdict.
- `fingerprint` is 32 hex characters of SHA-256 over the check, the route template, the viewport width band and the elements' `stable_id`s (or the `control_id`). It never includes coordinates, scroll offsets or text, so the same problem has the same fingerprint across sessions and machines.

The checks themselves, their evidence keys and their thresholds are documented in the [browser package README](../packages/browser/README.md#ui-checks).

## Privacy

No field carries page text, input values, HTML, attribute values (other than roles and safe test IDs), full URLs, query strings, request or response bodies, cookies or user identifiers. Route templates replace every path segment with `:id` unless the app lists it as a static word. The schemas enforce this with patterns and bounds, so a receiver can reject anything else.

## HTTP

With `endpoint`, the SDK sends:

- `POST {endpoint}/v2/batches` with a batch as the JSON body.
- `HEAD {endpoint}/v2/snapshots/{sha256}`, and only on `404` a `PUT` of the body to the same URL, gzip-compressed (`Content-Encoding: gzip`) when the browser has `CompressionStream`.

`Authorization: Bearer <projectKey>` goes on each request. `401` or `403` stops capture. With a `sink` there is no HTTP at all: the SDK calls `sendBatch(batch, serialized)` and `sendSnapshot({ sha256, body, serialized })`, and the sink stores them however it likes.

## Compatibility

Within `schema_version: 2`, changes are additive: new optional fields, new optional flags, new evidence keys. A body or batch written by an older SDK still validates (the 0.2.0 fixtures in `packages/browser/test/fixtures` are checked in the tests). Fields added after 0.2.0 say in their schema description which version added them. A check whose meaning changes gets a new `check_version`, so old and new findings are never mixed. A change that would reject older data needs a new `schema_version`.

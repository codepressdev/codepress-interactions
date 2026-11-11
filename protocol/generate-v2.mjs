// Generates protocol/v2-*.schema.json. Run: node protocol/generate-v2.mjs protocol
import { writeFileSync } from "node:fs";
const out = process.argv[2];
const base = "https://github.com/quantfive/codepress-interactions/blob/main/protocol/";
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const str = (max, pattern) => ({ type: "string", maxLength: max, ...(pattern ? { pattern } : {}) });
const int = (min, max) => ({ type: "integer", minimum: min, maximum: max });
const num = (min, max) => ({ type: "number", minimum: min, maximum: max });
const ms = num(0, 86400000);
const count = int(0, 1000000);
const SHA = "^[0-9a-f]{64}$";
const ID = "^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$";
const ROUTE = "^/[A-Za-z0-9_\\-./:{}\\[\\]*()+@~]{0,255}$";
const LABEL = "^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$";
const TRACE = "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$";
const strict = (properties, required = Object.keys(properties), extra = {}) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
  ...extra,
});

const legacyTypes = [
  "interaction.started",
  "ui.state.changed",
  "request.started",
  "request.completed",
  "operation.started",
  "operation.phase",
  "operation.completed",
  "capture.interrupted",
  "capture.events_dropped",
];
const LegacyData = {
  ...strict(
    {
      control_id: nullable(str(128)),
      surface: nullable(str(128)),
      action: nullable(str(128)),
      route_template: nullable(str(256, ROUTE)),
      feedback_type: nullable(str(64)),
      trace_id: nullable(str(128, TRACE)),
      phase: nullable(str(128)),
      outcome: nullable({
        type: "string",
        enum: ["running", "succeeded", "failed", "cancelled", "pending", "completed", "error", "abandoned"],
      }),
      duration_ms: nullable(ms),
      count: nullable(count),
      request_label: nullable(str(64, LABEL)),
      target_key: {
        ...int(1, 1000000),
        description: "interaction.started for a click: an opaque per-page-session number for the element clicked (the nearest control or label inside control_id, else the clicked element). Only equality is meaningful; rage_click groups by it. Absent before 0.3.0.",
      },
    },
    [],
  ),
  description:
    "v1 event data, unchanged except: sdk_version moved to the batch, request_label (a bounded label returned by the host's requestLabel callback) was added, and target_key was added in 0.3.0.",
};
const TRIGGERS = ["route", "click", "resize", "visible", "manual", "hover", "focus"];
const THEMES = ["light", "dark", "unknown"];
const SnapshotData = {
  ...strict({
    sha256: { type: "string", pattern: SHA, description: "SHA-256 of the uncompressed snapshot body bytes; the body is stored at /v2/snapshots/{sha256}." },
    trigger: { type: "string", enum: TRIGGERS, description: "What took the snapshot. hover and focus (added in 1.2.0): an overlay opened after a resting pointer or keyboard focus (see ui.hover.settled)." },
    route_template: nullable(str(256, ROUTE)),
    viewport_width: int(0, 100000),
    viewport_height: int(0, 100000),
    element_count: int(0, 50000),
    truncated: { type: "boolean" },
    torn: { type: "boolean" },
    bytes: int(0, 10000000),
    walk_ms: ms,
    slices: int(1, 1000000),
    max_slice_ms: ms,
    theme: { type: "string", enum: THEMES, description: "Color scheme on screen, as in the body's viewport.theme. Absent before 0.3.0." },
  }, ["sha256", "trigger", "route_template", "viewport_width", "viewport_height", "element_count", "truncated", "torn", "bytes", "walk_ms", "slices", "max_slice_ms"]),
  description: "A screen was captured. Sent once per distinct sha256 per page session.",
};
const SIGNALS = ["layout_shift", "event_timing", "long_task", "image_error", "uncaught_error"];
const ClickData = {
  ...strict({
    action: { const: "click" },
    control_id: str(128),
    route_template: nullable(str(256, ROUTE)),
    first_feedback_ms: { ...nullable(ms), description: "First DOM change, route change, dialog or focus move after the click; null when none was observed." },
    settle_ms: { ...ms, description: "Time to the last observed effect when settled; otherwise time until the window ended." },
    mutation_count: count,
    request_count: count,
    request_failed_count: count,
    error_count: count,
    long_task_count: { ...nullable(count), description: "Null when long tasks are unavailable in this browser." },
    layout_shift_score: { ...nullable(num(0, 1000)), description: "Null when layout shifts are unavailable in this browser." },
    route_changed: { type: "boolean" },
    dialog_opened: { type: "boolean" },
    focus_moved: { type: "boolean" },
    target_interactive: { type: "boolean", description: "The click landed on a control (button, link, form field, label, summary, control role or tabindex), not only inside a container. Absent before 0.3.0." },
    value_changed: { type: "boolean", description: "An input or change event fired on the clicked field (checkbox, radio, select). Absent before 0.3.0." },
    field_focused: { type: "boolean", description: "The click put focus in a text field, select or editable region; the caret or picker is its effect. Absent before 0.3.0." },
    new_context: { type: "boolean", description: "The click opened a new tab or window (link target, modifier key, download or window.open). Absent before 0.3.0." },
    selection_changed: { type: "boolean", description: "The click changed the text selection or moved the caret (a selectionchange from its own press or while it was open), for example selecting a word with a double-click. rage_click counts it as an answer. Absent before 1.0.0." },
    overlapped: { type: "boolean", description: "Another click started before this one settled (on both clicks). Counts are never shared between them." },
    incomplete: { type: "boolean", description: "The window ended by timeout or by the page being hidden/unloaded." },
    end_reason: { type: "string", enum: ["settled", "overlapped", "timeout", "page_hidden"] },
    before_sha256: nullable({ type: "string", pattern: SHA }),
    after_sha256: nullable({ type: "string", pattern: SHA }),
  }, [
    "action", "control_id", "route_template", "first_feedback_ms", "settle_ms", "mutation_count",
    "request_count", "request_failed_count", "error_count", "long_task_count", "layout_shift_score",
    "route_changed", "dialog_opened", "focus_moved", "overlapped", "incomplete", "end_reason",
    "before_sha256", "after_sha256",
  ]),
  description:
    "What followed a click until the page was quiet for clickSettleMs with no observed request in flight. Always attribution \"inferred\"; interaction_id is the click's interaction.started id. Requests in the window are counted here and never marked explicit.",
};
const bool = (description) => ({ type: "boolean", description });
const HoverData = {
  ...strict({
    kind: { type: "string", enum: ["pointer", "focus"], description: "pointer: a mouse or pen pointer (never touch) rested on the control for at least hoverDwellMs. focus: keyboard focus (:focus-visible) reached it." },
    control_id: { ...str(128), description: "The hovered or focused control, identified as a click's control_id is (test ID, else a tag path)." },
    route_template: nullable(str(256, ROUTE)),
    dwell_ms: { ...ms, description: "How long the pointer rested before the hover counted; 0 for focus." },
    settle_ms: { ...ms, description: "Time from the pointer arriving (or focus) to the last observed effect." },
    transition_started: bool("A CSS transition ran on the control, an ancestor, or inside what appeared."),
    animation_started: bool("A CSS animation started on the control, an ancestor, or inside what appeared."),
    nodes_added: bool("Elements were added anywhere in the observed root."),
    overlay_opened: bool("A dialog, tooltip, menu, listbox or popover appeared (added, or shown by an attribute, class or style change, or a popover toggle)."),
    expanded_changed: bool("An aria-expanded attribute changed."),
    class_changed: bool("A class attribute changed on the control, an ancestor, or inside what appeared."),
    style_changed: bool("An inline style changed on the control, an ancestor, or inside what appeared."),
    snapshot_sha256: { ...nullable({ type: "string", pattern: SHA }), description: "The snapshot taken after settling because an overlay opened (trigger hover or focus); null when none was taken." },
    has_hover_handler: { anyOf: [{ type: "boolean" }, { type: "null" }], description: "A React onMouseEnter, onMouseOver, onPointerEnter or onPointerOver handler on the control or up to 3 ancestors; false when they are React elements without one; null when none is a React element." },
  }),
  description:
    "Added in 1.2.0. What followed a resting mouse or pen pointer or a keyboard focus until the page was quiet for hoverSettleMs. Sent only when at least one effect boolean is true; hovers and focuses that changed nothing are counted in perf.summary (hovers_silent, focus_silent). At most one per kind, control and route every hoverRecordIntervalMs (default 30 s) and maxHoverRecordsPerMinute (default 30) per page. Always attribution \"unknown\" with a null interaction_id.",
};
const PerfData = {
  ...strict({
    window_ms: ms,
    layout_shift_score: nullable(num(0, 1000)),
    layout_shift_count: nullable(count),
    long_task_count: nullable(count),
    long_task_ms: nullable(ms),
    event_timing_count: nullable(count),
    event_timing_max_ms: nullable(ms),
    image_error_count: nullable(count),
    uncaught_error_count: nullable(count),
    contrast_unknown: { ...count, description: "Text elements on screens snapshotted in this window whose contrast could not be measured: an image or gradient behind them, opacity below 1 on the way up, or (looked for only around text measuring below 4.5:1) a filter or blend mode on the way up or a positioned layer overlapping them. Absent when zero (and before 1.2.0)." },
    unavailable: { type: "array", uniqueItems: true, maxItems: 5, items: { type: "string", enum: SIGNALS } },
    hovers_silent: { ...count, description: "Mouse or pen hovers in this window that rested past the dwell and changed nothing observable. Absent when zero (always with hovers: false, and before 1.2.0)." },
    focus_silent: { ...count, description: "Keyboard focuses in this window that changed nothing observable. Absent when zero (always with hovers: false, and before 1.2.0)." },
  }, ["window_ms", "layout_shift_score", "layout_shift_count", "long_task_count", "long_task_ms", "event_timing_count", "event_timing_max_ms", "image_error_count", "uncaught_error_count", "unavailable"]),
  description:
    "Performance signal totals since the previous summary. A signal the browser does not support is null and listed in unavailable, never reported as zero.",
};
const POSITIONS = ["static", "relative", "absolute", "fixed", "sticky"];
const ElementRef = strict(
  {
    index: { ...int(-1, 49999), description: "Row in the snapshot's element columns; -1 when not in the snapshot." },
    tag: str(64, "^[a-z][a-z0-9-]{0,63}$"),
    role: nullable(str(32, "^[a-z]{1,32}$")),
    test_id: nullable(str(128, ID)),
    stable_id: { ...str(1024, "^[#*A-Za-z0-9_.:/-]{1,1024}$"), description: "Identity used by the fingerprint: the test ID, or a structural tag path from the nearest ancestor with a test ID (#anchor/div/button), from the root, or after * when cut at 8 tags. Not unique: siblings with the same tags share a path." },
    x: num(-1e7, 1e7),
    y: num(-1e7, 1e7),
    width: num(0, 1e7),
    height: num(0, 1e7),
    position: { type: "string", enum: POSITIONS },
    z_index: nullable(int(-2147483648, 2147483647)),
  },
  ["index", "tag", "x", "y", "width", "height"],
);
const FindingData = {
  ...strict(
    {
      check: { ...str(64, "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*){1,3}$"), description: "Check identifier: layout.overlap, layout.spill, layout.page_h_scroll, layout.offscreen_control, layout.small_tap_target, layout.clipped_text, click.dead_click, click.rage_click, click.slow_feedback, click.silent_failure, click.error_after_click, stability.stuck_busy, stability.layout_shift, stability.slow_input, stability.broken_image, a11y.low_contrast (1.2.0), a11y.unnamed_control (1.2.0), a11y.no_focus_indicator (added in 1.2.0: keyboard focus reached control_id and its outline, box shadow, border colours and background colour, and those of two ancestors, were the same focused and unfocused; evidence kind_focus is true), a11y.hover_only_content (1.2.0: reported by the Playwright sweep only, never sent by the browser SDK; hovering control_id opened an overlay and keyboard focus on it did not), motion.layout_animation, motion.stuck_animation, motion.offscreen_loop, motion.janky_animation or a11y.reduced_motion_ignored (1.2.0: CSS animations and transitions observed in the page; subject is the animated element with index -1)." },
      check_version: int(1, 1000),
      fingerprint: { type: "string", pattern: "^[0-9a-f]{16,64}$", description: "Stable grouping key: SHA-256 (first 32 hex) of check, route_template, viewport width band and the elements' stable_id (or control_id); never coordinates, scroll offsets or text." },
      route_template: nullable(str(256, ROUTE)),
      snapshot_sha256: nullable({ type: "string", pattern: SHA }),
      viewport_width: int(0, 100000),
      viewport_height: int(0, 100000),
      subject: { ...nullable(ElementRef), description: "The element the finding is about; null when it has no element (click and performance findings without a matching snapshot row)." },
      other: nullable(ElementRef),
      control_id: { ...nullable(str(128)), description: "The clicked control's identifier, for click findings." },
      evidence: {
        type: "object",
        description:
          "Measured facts only, never a verdict or text. Keys are snake_case measurement names, e.g. overlap_px, overlap_ratio, text_overlap_px, blocked_points, tested_points, clip_px, first_feedback_ms, same_stacking_context.",
        maxProperties: 32,
        additionalProperties: false,
        patternProperties: {
          "^[a-z][a-z0-9_]{0,47}$": { anyOf: [{ type: "number", minimum: -1e9, maximum: 1e9 }, { type: "boolean" }, { type: "null" }] },
        },
      },
    },
    ["check", "check_version", "fingerprint", "route_template", "snapshot_sha256", "viewport_width", "viewport_height", "subject", "other", "evidence"],
  ),
  description: "A check matched: a pointer with measured evidence, never a verdict. The browser SDK runs the checks in idle time and sends each fingerprint once per page session; tests and services can run the same checks (@codepress/interactions-browser/detect) over stored snapshots and events.",
};

const envelope = (typeSchema, dataRef, attribution) =>
  strict(
    {
      event_id: { type: "string", format: "uuid" },
      schema_version: { const: 2 },
      interaction_id: nullable({ type: "string", format: "uuid" }),
      operation_id: nullable({ type: "string", format: "uuid" }),
      source: { type: "string", enum: ["browser", "server", "worker"] },
      source_instance_id: { type: "string", minLength: 1, maxLength: 128 },
      sequence: int(0, 9223372036854775807),
      occurred_at: { type: "string", format: "date-time" },
      elapsed_ms: nullable(ms),
      type: typeSchema,
      attribution,
      data: { $ref: dataRef },
    },
    ["event_id", "schema_version", "source", "source_instance_id", "sequence", "occurred_at", "type", "attribution", "data"],
  );
const anyAttribution = { type: "string", enum: ["explicit", "inferred", "unknown"] };
const batch = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: base + "v2-batch.schema.json",
  title: "Batch",
  description:
    "Protocol v2 event batch (POST /v2/batches). Retries reuse identical bytes and IDs. operation.* events require operation_id; ui.* and perf.* events cannot have one. No field carries page text, input values, HTML, URLs, queries or user IDs.",
  ...strict(
    {
      batch_id: { type: "string", format: "uuid" },
      schema_version: { const: 2 },
      sdk_version: str(64, "^[0-9A-Za-z.+-]{1,64}$"),
      release: nullable(str(128, "^[A-Za-z0-9][A-Za-z0-9_.+:@/-]{0,127}$")),
      events: { type: "array", minItems: 1, maxItems: 200, items: { $ref: "#/$defs/Event" } },
    },
    ["batch_id", "schema_version", "sdk_version", "events"],
  ),
  $defs: {
    Event: {
      oneOf: [
        { $ref: "#/$defs/LegacyEvent" },
        { $ref: "#/$defs/SnapshotEvent" },
        { $ref: "#/$defs/ClickSettledEvent" },
        { $ref: "#/$defs/HoverSettledEvent" },
        { $ref: "#/$defs/FindingEvent" },
        { $ref: "#/$defs/PerfSummaryEvent" },
      ],
    },
    LegacyEvent: envelope({ type: "string", enum: legacyTypes }, "#/$defs/LegacyData", anyAttribution),
    SnapshotEvent: envelope({ const: "ui.snapshot" }, "#/$defs/SnapshotData", { const: "unknown" }),
    ClickSettledEvent: envelope({ const: "ui.click.settled" }, "#/$defs/ClickSettledData", { const: "inferred" }),
    HoverSettledEvent: envelope({ const: "ui.hover.settled" }, "#/$defs/HoverSettledData", { const: "unknown" }),
    FindingEvent: envelope({ const: "ui.finding" }, "#/$defs/FindingData", { type: "string", enum: ["inferred", "unknown"] }),
    PerfSummaryEvent: envelope({ const: "perf.summary" }, "#/$defs/PerfSummaryData", { const: "unknown" }),
    LegacyData,
    SnapshotData,
    ClickSettledData: ClickData,
    HoverSettledData: HoverData,
    FindingData,
    PerfSummaryData: PerfData,
    ElementRef,
  },
};

const col = (items, desc) => ({ type: "array", maxItems: 50000, items, ...(desc ? { description: desc } : {}) });
const coord = num(-1e7, 1e7);
const size = num(0, 1e7);
const idx = int(-1, 49999);
const FLAGS = { visible: 1, interactive: 2, clipped: 4, scrollable: 8, overlay: 16, ignored: 32, pointer_events_none: 64, opaque: 128, clips_content: 256, in_shadow: 512, popover_open: 1024, ellipsis: 2048, broken_image: 4096, aria_hidden: 8192, allow_overlap: 16384 };
/** Flags 0.2.0 bodies do not list in their legend. */
const LATER_FLAGS = ["popover_open", "ellipsis", "broken_image", "aria_hidden", "allow_overlap"];
const snapshot = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: base + "v2-snapshot.schema.json",
  title: "SnapshotBody",
  description:
    "One screen as element boxes (PUT /v2/snapshots/{sha256}, gzip when supported). sha256 is over the exact uncompressed UTF-8 bytes uploaded. Columnar: every array in `elements` has element_count entries and row i describes the same element; rows are in depth-first pre-order of the rendered (flat) tree, so a parent always precedes its children. Coordinates are CSS pixels relative to the viewport (getBoundingClientRect), rounded to 0.01. Geometry and layout facts only: no text, values, attributes other than role and safe test IDs, URLs or HTML.",
  ...strict({
    schema_version: { const: 2 },
    route_template: nullable(str(256, ROUTE)),
    viewport: strict({
      width: int(0, 100000),
      height: int(0, 100000),
      client_width: int(0, 100000),
      client_height: int(0, 100000),
      device_pixel_ratio: num(0, 100),
      scroll_x: coord,
      scroll_y: coord,
      coarse_pointer: { type: "boolean", description: "(pointer: coarse) matched: the primary input is touch. Absent before 0.3.0." },
      theme: { type: "string", enum: THEMES, description: "Color scheme on screen: the host's theme() option when given (anything outside the enum is unknown), else prefers-color-scheme. Absent before 0.3.0." },
    }, ["width", "height", "client_width", "client_height", "device_pixel_ratio", "scroll_x", "scroll_y"]),
    document: strict({ width: size, height: size }),
    element_count: int(0, 50000),
    truncated: { type: "boolean", description: "The walk stopped at maxElements or rows were dropped to fit maxSnapshotBytes." },
    torn: { type: "boolean", description: "The DOM, scroll position or viewport changed between slices of a multi-slice walk." },
    legend: {
      ...strict({
        position: { type: "array", prefixItems: POSITIONS.map((p) => ({ const: p })), items: false, minItems: 5 },
        // Flags added after 0.2.0 are optional so older bodies still validate.
        flags: strict(
          Object.fromEntries(Object.entries(FLAGS).map(([k, v]) => [k, { const: v }])),
          Object.keys(FLAGS).filter((k) => !LATER_FLAGS.includes(k)),
        ),
        hit_points: {
          type: "array",
          prefixItems: ["center", "top_left", "top_right", "bottom_left", "bottom_right"].map((p) => ({ const: p })),
          items: false,
          minItems: 5,
        },
      }),
      description: "Fixed decoding tables, repeated in every body so a body is self-describing.",
    },
    dictionaries: strict({
      tag: { type: "array", maxItems: 50000, items: str(64, "^[a-z][a-z0-9-]{0,63}$") },
      role: { type: "array", maxItems: 50000, items: str(32, "^[a-z]{1,32}$") },
      test_id: { type: "array", maxItems: 50000, items: str(128, ID), description: "Safe data-interaction-id or data-testid values." },
    }),
    elements: strict({
      parent: col(idx, "Row of the parent element, -1 for the root."),
      tag: col(int(0, 49999), "Index into dictionaries.tag."),
      role: col(idx, "Index into dictionaries.role (explicit role, else implicit role for common tags), -1 when none."),
      test_id: col(idx, "Index into dictionaries.test_id, -1 when none."),
      x: col(coord),
      y: col(coord),
      width: col(size),
      height: col(size),
      z_index: col(nullable(int(-2147483648, 2147483647)), "Computed z-index; null for auto."),
      position: col(int(0, 4), "Index into legend.position (computed CSS position)."),
      flags: col(int(0, 32767), "Bitmask, see legend.flags. visible: has area, visibility visible, effective opacity > 0.01 and not entirely clipped by an ancestor. interactive: focusable/clickable control that is not disabled. clipped: box extends past an ancestor's overflow clip. scrollable: overflow auto/scroll with overflowing content. overlay: position fixed, absolute with z-index > 0, an open dialog/popover, or role dialog/alertdialog/tooltip/menu/listbox. ignored: matched ignoreSelector, [data-layout-ignore] or [data-interactions-exclude]; recorded as one box, never descended. pointer_events_none: computed pointer-events none. opaque: canvas, iframe, embed, object or video; recorded as one box, never descended. clips_content: the element clips its own overflow. in_shadow: the element's own tree is an open shadow root (slotted light-DOM content is not). popover_open: matches :popover-open. ellipsis: computed text-overflow ellipsis or a line clamp. broken_image: an img that finished loading with no image data. aria_hidden: the element or an ancestor has aria-hidden=true. allow_overlap: the element carries a data-layout-allow-overlap marker (added in 1.2.0; see allow_overlap). Bodies before 0.3.0 never set popover_open, ellipsis, broken_image or aria_hidden."),
      text_length: col(count, "Characters in direct, non-whitespace text node children (trimmed). The text itself is never read into the body."),
    }),
    text_boxes: {
      ...strict({
        element: col(int(0, 49999)),
        x: col(coord),
        y: col(coord),
        width: col(size),
        height: col(size),
        lines: col(int(0, 1000), "Distinct line tops among the text's client rects."),
      }),
      description: "For visible elements with direct text: the union box of that text's rendered client rects (from a Range). Geometry only. An element's box can overlap another while its text does not.",
    },
    hit_tests: {
      ...strict({
        element: col(int(0, 49999)),
        tested: col(int(0, 5), "Points inside the viewport that elementFromPoint answered."),
        blocked: col(int(0, 5), "Tested points whose topmost element is not the control, inside it, or its label."),
        points: col(int(0, 31), "Bitmask of blocked points, see legend.hit_points."),
        top: col(idx, "Row of the topmost element at the first blocked point (or its nearest recorded ancestor that does not contain the control); -1 when unknown."),
      }),
      description: "For visible interactive elements only: elementFromPoint at the center and at the four points 25% in from each edge. elementFromPoint is never called for other elements.",
    },
    allow_overlap: {
      ...strict({
        element: col(int(0, 49999), "Row of an element flagged allow_overlap."),
        other: col(idx, "Row of the element its marker allows, or -1 when the marker allows any element (*)."),
      }),
      description: "Added in 1.2.0. Overlaps allowed in the markup with data-layout-allow-overlap, resolved in the page to row pairs: a marker's space-separated names match elements whose data-interaction-id or data-testid has that value (before the test ID filter), and * matches any element. Only pairs whose boxes intersect are listed, at most 10000. The marker's value is never recorded. Absent when no recorded element carries the marker.",
    },
    contrast: {
      ...strict({
        element: col(int(0, 49999)),
        ratio: col(num(1, 21), "WCAG 2.x contrast ratio of the text colour (alpha composited) against the background behind it, rounded down to 2 decimal places."),
        font_px: col(num(0, 100000), "Computed font size in CSS px, rounded to 0.01."),
        bold: col({ type: "boolean" }, "Computed font weight 700 or more."),
      }),
      description: "Text below 4.5:1, the highest WCAG AA threshold (text at or above it meets every size's minimum and is not listed). Visible elements with direct text, not aria-hidden and not a disabled or aria-disabled control (or inside one), whose background could be worked out: background colours composited up the ancestors onto the canvas (white, or black when the root's color-scheme is dark). Text is left out (and counted in perf.summary contrast_unknown) when a background image or gradient or opacity below 1 is on the way up, its colour is not sRGB, or (looked for only around text measuring below 4.5:1) a filter or mix-blend-mode is on the way up or a positioned element that paints its own layer and is not an ancestor overlaps it. Contrast is worked out for at most maxContrastElements (default 2000) text elements per snapshot. Colours are never recorded. Absent before 1.2.0.",
    },
    unnamed_controls: {
      ...strict({
        element: col(int(0, 49999)),
        has_title: col({ type: "boolean" }, "The control has a title attribute (blank, since a non-blank one would name it)."),
        icon_only: col({ type: "boolean" }, "The control holds an svg, img or picture and no text, or is an image input."),
      }),
      description: "Visible, enabled interactive elements with a role, not aria-hidden, whose accessible name is empty: no aria-labelledby target with text, aria-label, associated label with text, alt (image inputs), title, placeholder, own text (for roles named from content: button, link, checkbox, radio, switch, tab, menu items, option, treeitem) or value (button-type inputs; submit and reset without a value have a default name). Worked out in the page; only these booleans are recorded. Absent before 1.2.0.",
    },
  }, [
    "schema_version", "route_template", "viewport", "document", "element_count", "truncated", "torn",
    "legend", "dictionaries", "elements", "text_boxes", "hit_tests",
  ]),
};
writeFileSync(`${out}/v2-batch.schema.json`, JSON.stringify(batch, null, 2) + "\n");
writeFileSync(`${out}/v2-snapshot.schema.json`, JSON.stringify(snapshot, null, 2) + "\n");

// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkEvents,
  checkSnapshot,
  detect,
  fingerprint,
  formatFinding,
  sha256HexSync,
  sortFindings,
  toFindingData,
  viewportBand,
  type Finding,
  type SnapshotBody,
  type TimelineEvent,
} from "../src/detect/index";
import { FLAGS, HIT_POINTS, POSITIONS } from "../src/format";

const protocol = resolve(__dirname, "../../../protocol");

interface El {
  parent: number;
  tag?: string;
  box: [number, number, number, number];
  flags?: number;
  position?: (typeof POSITIONS)[number];
  testId?: string;
  role?: string;
  text?: [number, number, number, number];
}

/** A columnar body from a readable element list (pre-order, parents first). */
function body(
  els: El[],
  extra: Partial<SnapshotBody> & { hits?: { row: number; tested: number; blocked: number; points: number; top: number }[] } = {},
): SnapshotBody {
  const tags: string[] = [];
  const roles: string[] = [];
  const ids: string[] = [];
  const index = (list: string[], value?: string) => {
    if (value === undefined) return -1;
    let at = list.indexOf(value);
    if (at < 0) at = list.push(value) - 1;
    return at;
  };
  const text = els.map((el, row) => ({ el, row })).filter(({ el }) => el.text);
  const { hits = [], ...rest } = extra;
  return {
    schema_version: 2,
    route_template: "/settings/:id",
    viewport: { width: 1280, height: 800, client_width: 1280, client_height: 800, device_pixel_ratio: 1, scroll_x: 0, scroll_y: 0 },
    document: { width: 1280, height: 800 },
    element_count: els.length,
    truncated: false,
    torn: false,
    legend: { position: POSITIONS, flags: FLAGS, hit_points: HIT_POINTS },
    dictionaries: { tag: tags, role: roles, test_id: ids },
    elements: {
      parent: els.map((e) => e.parent),
      tag: els.map((e) => index(tags, e.tag ?? "div")),
      role: els.map((e) => index(roles, e.role)),
      test_id: els.map((e) => index(ids, e.testId)),
      x: els.map((e) => e.box[0]),
      y: els.map((e) => e.box[1]),
      width: els.map((e) => e.box[2]),
      height: els.map((e) => e.box[3]),
      z_index: els.map(() => null),
      position: els.map((e) => POSITIONS.indexOf(e.position ?? "static")),
      flags: els.map((e) => e.flags ?? FLAGS.visible),
      text_length: els.map((e) => (e.text ? 4 : 0)),
    },
    text_boxes: {
      element: text.map((t) => t.row),
      x: text.map((t) => t.el.text![0]),
      y: text.map((t) => t.el.text![1]),
      width: text.map((t) => t.el.text![2]),
      height: text.map((t) => t.el.text![3]),
      lines: text.map(() => 1),
    },
    hit_tests: {
      element: hits.map((h) => h.row),
      tested: hits.map((h) => h.tested),
      blocked: hits.map((h) => h.blocked),
      points: hits.map((h) => h.points),
      top: hits.map((h) => h.top),
    },
    ...rest,
  } as SnapshotBody;
}

const V = FLAGS.visible;
const I = FLAGS.interactive;

/** Root, a relative wrapper, a button with a label and a badge over its center. */
const covered = (hitTop = 3, extra = {}) =>
  body(
    [
      { parent: -1, tag: "body", box: [0, 0, 1280, 800] },
      { parent: 0, box: [0, 0, 400, 200], position: "relative" },
      { parent: 1, tag: "button", box: [0, 0, 160, 40], flags: V | I, position: "absolute", testId: "pay", text: [40, 12, 80, 16] },
      { parent: 1, tag: "span", box: [30, 4, 100, 32], position: "absolute", testId: "promo" },
      { parent: 0, box: [0, 300, 200, 50], flags: V | FLAGS.clips_content, testId: "card" },
      { parent: 4, box: [0, 300, 320, 20], testId: "row" },
    ],
    { hits: [{ row: 2, tested: 5, blocked: 5, points: 31, top: hitTop }], ...extra },
  );

describe("checks run on data alone", () => {
  it("runs in Node without document or window", () => {
    expect(typeof (globalThis as any).document).toBe("undefined");
    expect(typeof (globalThis as any).window).toBe("undefined");
    expect(checkSnapshot(covered()).length).toBeGreaterThan(0);
  });

  it("gives the saved golden snapshot the same finding the browser sent for it", () => {
    const saved = JSON.parse(readFileSync(resolve(protocol, "v2-snapshot.json"), "utf8"));
    const batch = JSON.parse(readFileSync(resolve(protocol, "v2-batch.json"), "utf8"));
    const sent = batch.events.filter((e: any) => e.type === "ui.finding").map((e: any) => e.data);
    expect(sent.length).toBeGreaterThan(0);
    const sha256 = sent[0].snapshot_sha256;
    const node = checkSnapshot(saved, { sha256 }).map(toFindingData);
    for (const data of sent) expect(node).toContainEqual(data);
  });

  it("sync SHA-256 matches Node's", () => {
    for (const text of ["", "abc", "x".repeat(1000), "ünïcødé ✓"])
      expect(sha256HexSync(text)).toBe(createHash("sha256").update(text).digest("hex"));
  });
});

describe("overlap", () => {
  it("reports blocked points and covered text with the covered element as subject", () => {
    const [overlap] = checkSnapshot(covered()).filter((f) => f.type === "overlap");
    expect(overlap.subject?.test_id).toBe("pay");
    expect(overlap.other?.test_id).toBe("promo");
    expect(overlap.evidence).toMatchObject({
      overlap_px: 3200,
      subject_blocked_points: 5,
      center_blocked: true,
      subject_text_covered: true,
      paint_order_from_hit_test: true,
      subject_depth_to_common: 1,
      other_depth_to_common: 1,
      common_parent_positioned: true,
    });
  });

  it("never counts a hit test whose top row is unknown or missing from a truncated body", () => {
    for (const top of [-1, 99]) {
      const [overlap] = checkSnapshot(covered(top, { truncated: true })).filter((f) => f.type === "overlap");
      expect(overlap.evidence).toMatchObject({ subject_blocked_points: 0, paint_order_from_hit_test: false });
    }
  });

  it("treats an opaque subject's text as unknown, never as empty", () => {
    const b = covered();
    b.elements.flags[2] |= FLAGS.opaque;
    const [overlap] = checkSnapshot(b).filter((f) => f.type === "overlap");
    expect(overlap.evidence.subject_text_covered).toBeNull();
    expect(overlap.evidence.subject_text_overlap_px).toBeNull();
  });

  it("does not report containment, sub-pixel touches, ignored or 1px elements", () => {
    const b = body([
      { parent: -1, tag: "body", box: [0, 0, 1280, 800] },
      { parent: 0, box: [0, 0, 100, 100], testId: "a" },
      { parent: 1, box: [10, 10, 50, 50], testId: "inside" },
      { parent: 0, box: [99.6, 0, 100, 100], testId: "touch" },
      { parent: 0, box: [20, 20, 40, 40], flags: V | FLAGS.ignored, testId: "ignored" },
      { parent: 0, box: [30, 30, 1, 1], testId: "pixel" },
    ]);
    expect(checkSnapshot(b).filter((f) => f.type === "overlap")).toEqual([]);
  });

  it("keeps a layer separate from what is beneath it", () => {
    const b = body([
      { parent: -1, tag: "body", box: [0, 0, 1280, 800] },
      { parent: 0, tag: "button", box: [0, 0, 100, 40], flags: V | I, testId: "under" },
      { parent: 0, box: [20, 10, 200, 40], role: "tooltip", position: "absolute", testId: "tip" },
      { parent: 0, box: [0, 0, 300, 300], role: "menu", position: "absolute", testId: "menu" },
      { parent: 0, tag: "dialog", box: [10, 10, 300, 300], position: "fixed", testId: "dialog" },
    ]);
    const overlaps = checkSnapshot(b).filter((f) => f.type === "overlap");
    // Layers do not overlap the page; they may still overlap each other... but never the page beneath.
    for (const f of overlaps) expect([f.subject?.test_id, f.other?.test_id]).not.toContain("under");
  });
});

describe("torn and truncated snapshots", () => {
  it("a torn body gives no position-based findings", () => {
    const b = covered(3, { torn: true });
    const checks = checkSnapshot(b).map((f) => f.type);
    expect(checks).not.toContain("overlap");
    expect(checks).not.toContain("spill");
  });

  it("a torn body still reports broken images and small tap targets", () => {
    const b = body(
      [
        { parent: -1, tag: "body", box: [0, 0, 1280, 800] },
        { parent: 0, tag: "img", box: [0, 0, 100, 100], flags: V | FLAGS.broken_image, testId: "hero" },
        { parent: 0, tag: "button", box: [0, 200, 10, 10], flags: V | I, testId: "x" },
      ],
      { torn: true },
    );
    expect(checkSnapshot(b, { touch: true }).map((f) => f.type)).toEqual(["small_tap_target", "broken_image"]);
  });

  it("a truncated body without the widening element gives no page_h_scroll", () => {
    const b = body([{ parent: -1, tag: "body", box: [0, 0, 1280, 800] }], {
      document: { width: 1600, height: 800 },
      truncated: true,
    });
    expect(checkSnapshot(b)).toEqual([]);
    const complete = { ...b, truncated: false };
    expect(checkSnapshot(complete).map((f) => [f.type, f.subject])).toEqual([["page_h_scroll", null]]);
  });

  it("ignores malformed rows instead of throwing", () => {
    const b = covered();
    b.elements.parent[3] = 42;
    b.elements.x.length = 4;
    expect(() => checkSnapshot(b)).not.toThrow();
    expect(checkSnapshot({} as SnapshotBody)).toEqual([]);
  });
});

describe("spill", () => {
  it("reports the outermost spill against the nearest clipping box", () => {
    const spills = checkSnapshot(covered()).filter((f) => f.type === "spill");
    expect(spills.map((f) => [f.subject?.test_id, f.other?.test_id])).toEqual([["row", "card"]]);
    expect(spills[0].evidence.overflow_right_px).toBe(120);
  });

  it("does not report content crossing a scroller or within the tolerance", () => {
    const b = covered();
    b.elements.flags[4] |= FLAGS.scrollable;
    expect(checkSnapshot(b).filter((f) => f.type === "spill")).toEqual([]);
    const near = covered();
    near.elements.width[5] = 201;
    expect(checkSnapshot(near).filter((f) => f.type === "spill")).toEqual([]);
  });
});

describe("fingerprints", () => {
  it("ignore coordinates and scroll, and change with route, band and identity", () => {
    const a = checkSnapshot(covered());
    const moved = covered();
    moved.viewport.scroll_y = 500;
    moved.elements.y = moved.elements.y.map((y) => y - 500);
    moved.text_boxes.y = moved.text_boxes.y.map((y) => y - 500);
    expect(checkSnapshot(moved).map((f) => f.fingerprint)).toEqual(a.map((f) => f.fingerprint));
    expect(a[0].fingerprint).toBe(fingerprint("overlap", "/settings/:id", "1024-1439", ["pay", "promo"]));
    expect(fingerprint("overlap", "/other", "1024-1439", ["pay", "promo"])).not.toBe(a[0].fingerprint);
    expect(fingerprint("overlap", "/settings/:id", "768-1023", ["pay", "promo"])).not.toBe(a[0].fingerprint);
  });

  it("bands viewport widths", () => {
    const bands = [480, 768, 1024, 1440];
    expect([320, 480, 800, 1024, 1920].map((w) => viewportBand(w, bands))).toEqual(["0-479", "480-767", "768-1023", "1024-1439", "1440+"]);
  });
});

describe("sorting", () => {
  it("blocked controls, then covered or clipped text, then the rest; nothing dropped", () => {
    const f = (type: Finding["type"], evidence: Finding["evidence"]) => ({ type, evidence }) as Finding;
    const input = [
      f("spill", {}),
      f("overlap", { subject_blocked_points: 0, subject_text_covered: false }),
      f("clipped_text", { text_clipped: true }),
      f("overlap", { subject_blocked_points: 2, subject_text_covered: true }),
      f("dead_click", {}),
      f("overlap", { subject_blocked_points: 0, subject_text_covered: true }),
    ];
    const sorted = sortFindings(input);
    expect(sorted).toHaveLength(input.length);
    expect(sorted).toEqual([input[3], input[5], input[2], input[1], input[0], input[4]]);
  });
});

// ---- Timeline checks --------------------------------------------------------------

const t0 = Date.parse("2026-01-01T00:00:00Z");
const at = (ms: number) => new Date(t0 + ms).toISOString();
const snap = (ms = 0): TimelineEvent => ({
  type: "ui.snapshot",
  occurred_at: at(ms),
  data: { sha256: "a".repeat(64), route_template: "/settings/:id", viewport_width: 1280, viewport_height: 800 },
});
const settled = (data: Record<string, unknown>, ms = 100, id = "i1"): TimelineEvent => ({
  type: "ui.click.settled",
  interaction_id: id,
  occurred_at: at(ms),
  data: {
    action: "click",
    control_id: "save",
    route_template: "/settings/:id",
    first_feedback_ms: null,
    settle_ms: 500,
    mutation_count: 0,
    request_count: 0,
    request_failed_count: 0,
    error_count: 0,
    long_task_count: 0,
    layout_shift_score: 0,
    route_changed: false,
    dialog_opened: false,
    focus_moved: false,
    overlapped: false,
    incomplete: false,
    end_reason: "settled",
    before_sha256: null,
    after_sha256: null,
    target_interactive: true,
    value_changed: false,
    field_focused: false,
    new_context: false,
    ...data,
  },
});
const types = (events: TimelineEvent[], options = {}) => checkEvents(events, options).map((f) => f.type);

describe("click checks", () => {
  it("a settled click on a control with no effect is a dead click", () => {
    const [dead] = checkEvents([snap(), settled({})]);
    expect(dead).toMatchObject({ type: "dead_click", check: "click.dead_click", control_id: "save", interaction_id: "i1", subject: null });
    expect(dead.fingerprint).toBe(fingerprint("dead_click", "/settings/:id", "1024-1439", ["save"]));
    expect(dead.evidence.structural_id).toBe(false);
  });

  it("any effect, an unknown target or an incomplete window is not a dead click", () => {
    const effects = [
      { request_count: 1 },
      { mutation_count: 1, first_feedback_ms: 20 },
      { route_changed: true },
      { dialog_opened: true },
      { focus_moved: true },
      { value_changed: true },
      { field_focused: true },
      { new_context: true },
      { target_interactive: false },
      { target_interactive: undefined }, // 0.2.0 data
      { end_reason: "page_hidden", incomplete: true },
      { end_reason: "timeout", incomplete: true },
      { overlapped: true },
    ];
    for (const effect of effects) expect(types([snap(), settled(effect)]), JSON.stringify(effect)).not.toContain("dead_click");
  });

  it("slow feedback, silent failure and errors after a click", () => {
    expect(types([settled({ first_feedback_ms: 1500, mutation_count: 1 })])).toEqual(["slow_feedback"]);
    expect(types([settled({ first_feedback_ms: 999, mutation_count: 1 })])).toEqual([]);
    expect(types([settled({ request_count: 1, settle_ms: 2000 })])).toEqual(["slow_feedback"]);
    expect(types([settled({ request_count: 1, request_failed_count: 1 })])).toEqual(["silent_failure"]);
    expect(types([settled({ request_count: 1, request_failed_count: 1, mutation_count: 2, first_feedback_ms: 10 })])).toEqual([]);
    expect(
      types([settled({ request_count: 1, request_failed_count: 1, mutation_count: 2, first_feedback_ms: 10, before_sha256: "b".repeat(64), after_sha256: "b".repeat(64) })]),
    ).toEqual(["silent_failure"]);
    expect(types([settled({ mutation_count: 1, first_feedback_ms: 5, error_count: 2 })])).toEqual(["error_after_click"]);
  });

  it("rage clicks: enough clicks on one control within the window", () => {
    const start = (ms: number, control = "save"): TimelineEvent => ({
      type: "interaction.started",
      interaction_id: `s${ms}`,
      occurred_at: at(ms),
      data: { action: "click", control_id: control },
    });
    expect(types([snap(), start(0), start(200), start(400)])).toEqual(["rage_click"]);
    expect(types([snap(), start(0), start(200), start(1400)])).toEqual([]);
    expect(types([snap(), start(0), start(100, "other"), start(200)])).toEqual([]);
    expect(types([snap(), start(0), start(200)], { rageClickCount: 2 })).toEqual(["rage_click"]);
  });
});

describe("stability checks", () => {
  const state = (phase: string, ms: number): TimelineEvent => ({
    type: "ui.state.changed",
    occurred_at: at(ms),
    data: { feedback_type: "busy", phase, control_id: "save" },
  });

  it("a busy state still open after the threshold", () => {
    expect(types([snap(), state("active", 0)], { now: t0 + 12_000 })).toEqual(["stuck_busy"]);
    expect(types([snap(), state("active", 0)], { now: t0 + 5_000 })).toEqual([]);
    expect(types([snap(), state("active", 0), state("inactive", 500)], { now: t0 + 60_000 })).toEqual([]);
    // Without `now`, measured to the last event.
    expect(types([snap(), state("active", 0), snap(11_000)])).toEqual(["stuck_busy"]);
  });

  it("layout shift and slow input from performance summaries, with thresholds as options", () => {
    const perf = (data: Record<string, unknown>): TimelineEvent => ({ type: "perf.summary", occurred_at: at(0), data });
    expect(types([snap(), perf({ layout_shift_score: 0.25, event_timing_max_ms: 350 })])).toEqual(["layout_shift", "slow_input"]);
    expect(types([snap(), perf({ layout_shift_score: 0.05, event_timing_max_ms: 150 })])).toEqual([]);
    expect(types([snap(), perf({ layout_shift_score: 0.05 })], { layoutShiftScore: 0.01 })).toEqual(["layout_shift"]);
    expect(types([snap(), perf({ layout_shift_score: 0.25 })], { checks: ["slow_input"] })).toEqual([]);
  });
});

describe("output", () => {
  it("formats a readable line per finding", () => {
    const [overlap] = checkSnapshot(covered());
    const line = formatFinding(overlap);
    expect(line).toContain("layout.overlap pay × promo on /settings/:id @1280x800:");
    expect(line).toContain("subject_blocked_points=5");
    expect(line).toContain(overlap.fingerprint);
  });

  it("detect() combines snapshots and events, sorted", () => {
    const all = detect({ snapshots: [{ body: covered(), sha256: "c".repeat(64) }], events: [snap(), settled({})] });
    expect(all[0].type).toBe("overlap");
    expect(all.map((f) => f.type)).toContain("dead_click");
    expect(all.find((f) => f.type === "overlap")!.snapshot_sha256).toBe("c".repeat(64));
  });

  it("evidence stays within the wire bounds", () => {
    for (const finding of checkSnapshot(covered())) {
      expect(Object.keys(finding.evidence).length).toBeLessThanOrEqual(32);
      for (const value of Object.values(finding.evidence))
        expect(value === null || typeof value === "boolean" || Number.isFinite(value)).toBe(true);
    }
  });
});

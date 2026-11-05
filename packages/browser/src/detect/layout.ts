/**
 * Layout checks over one snapshot body: overlap, spill, page horizontal scroll,
 * offscreen controls, small tap targets, clipped text and broken images.
 * Findings are pointers with measured evidence; none of them is a verdict.
 */
import { FLAGS, type SnapshotBody } from "../format";
import { fingerprint, viewportBand } from "./fingerprint";
import {
  CHECK_IDS,
  CHECK_VERSION,
  type CheckName,
  type ElementRef,
  type Evidence,
  type Finding,
  type ResolvedOptions,
  boundEvidence,
} from "./types";
import { FIXED_POSITION, SnapshotView, area, intersect, type Content, type Rect } from "./view";

const r2 = (value: number): number => {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
};
const ratio = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 10000) / 10000 : 0);

interface Context {
  view: SnapshotView;
  body: SnapshotBody;
  options: ResolvedOptions;
  sha256: string | null;
  band: string;
  out: Finding[];
}

function emit(
  ctx: Context,
  type: CheckName,
  subject: number | null,
  other: number | null,
  evidence: Evidence,
): void {
  const { view, body } = ctx;
  const subjectRef: ElementRef | null = subject === null ? null : view.ref(subject);
  const otherRef: ElementRef | null = other === null ? null : view.ref(other);
  if (subject !== null) evidence.subject_structural_id = view.structural(subject);
  if (other !== null) evidence.other_structural_id = view.structural(other);
  ctx.out.push({
    type,
    check: CHECK_IDS[type],
    check_version: CHECK_VERSION,
    fingerprint: fingerprint(type, body.route_template ?? null, ctx.band, [
      subjectRef?.stable_id ?? null,
      otherRef?.stable_id ?? null,
    ]),
    route_template: body.route_template ?? null,
    snapshot_sha256: ctx.sha256,
    viewport_width: Math.max(0, Math.round(body.viewport?.width ?? 0)),
    viewport_height: Math.max(0, Math.round(body.viewport?.height ?? 0)),
    subject: subjectRef,
    other: otherRef,
    control_id: null,
    interaction_id: null,
    evidence: boundEvidence(evidence),
  });
}

/** Runs the layout checks on one body. Torn bodies only get checks that do not compare positions. */
export function layoutFindings(body: SnapshotBody, sha256: string | null, options: ResolvedOptions): Finding[] {
  const view = new SnapshotView(body);
  const ctx: Context = {
    view,
    body,
    options,
    sha256,
    band: viewportBand(body.viewport?.width ?? 0, options.viewportBands),
    out: [],
  };
  const on = (name: CheckName) => options.checks.has(name);
  // A torn body mixes positions from before and after a change: comparing boxes
  // (or a box with the viewport) could report something that never rendered.
  if (!body.torn) {
    if (on("overlap")) overlap(ctx);
    if (on("spill")) spill(ctx);
    if (on("page_h_scroll")) pageHorizontalScroll(ctx);
    if (on("offscreen_control")) offscreenControl(ctx);
    if (on("clipped_text")) clippedText(ctx);
  }
  if (on("small_tap_target")) smallTapTarget(ctx);
  if (on("broken_image")) brokenImage(ctx);
  return ctx.out;
}

// ---- Overlap -------------------------------------------------------------

function overlap(ctx: Context): void {
  const { view, options } = ctx;
  const min = options.overlapMinPx;
  const eligible: number[] = [];
  for (let i = 0; i < view.n; i++) {
    if (!view.shown(i)) continue;
    const v = view.visible[i];
    if (v.right - v.left <= min || v.bottom - v.top <= min) continue;
    eligible.push(i);
  }
  const pairs = new Set<number>();
  const found: [number, number][] = [];
  const key = (a: number, b: number) => a * 65536 + b;
  // Sweep down the page: only boxes that are still open at this top can intersect.
  const byTop = eligible.slice().sort((a, b) => view.visible[a].top - view.visible[b].top || a - b);
  let active: number[] = [];
  for (const b of byTop) {
    const vb = view.visible[b];
    active = active.filter((a) => view.visible[a].bottom - vb.top > min);
    for (const a of active) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (view.within(hi, lo)) continue;
      const va = view.visible[a];
      const w = Math.min(va.right, vb.right) - Math.max(va.left, vb.left);
      const h = Math.min(va.bottom, vb.bottom) - Math.max(va.top, vb.top);
      if (w <= min || h <= min) continue;
      if (excluded(view, lo, hi)) continue;
      pairs.add(key(lo, hi));
      found.push([lo, hi]);
    }
    active.push(b);
  }
  // Nearest eligible ancestor, for collapsing a collision to the outermost pair.
  const shownSet = new Set(eligible);
  const up = new Int32Array(view.n).fill(-1);
  for (let i = 0; i < view.n; i++) {
    const p = view.parent[i];
    up[i] = p < 0 ? -1 : shownSet.has(p) ? p : up[p];
  }
  const has = (a: number, b: number) => a >= 0 && b >= 0 && pairs.has(key(Math.min(a, b), Math.max(a, b)));
  found.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  for (const [a, b] of found) {
    // When a's (or b's) parent already collides with the other side, that outer
    // pair is the finding; its evidence covers everything inside it.
    if (has(up[a], b) || has(a, up[b])) continue;
    overlapFinding(ctx, a, b);
  }
}

/**
 * Overlays over the page, and content scrolled under a pinned element, are not
 * overlaps. At the page's origin nothing has scrolled yet, so a fixed or sticky
 * element covering content there is reported.
 */
function excluded(view: SnapshotView, a: number, b: number): boolean {
  if (view.layer[a] !== view.layer[b] && (view.layer[a] !== -1 || view.layer[b] !== -1)) return true;
  const pa = view.pinned[a];
  const pb = view.pinned[b];
  if (pa !== pb && (pa === -1 || pb === -1)) {
    // One side is pinned (fixed or sticky) and the other is not: their offset
    // changes as the page or a scroller scrolls, so crossing is scrolling.
    const loose = pa === -1 ? a : b;
    if ((view.documentScrolls && view.documentScrolled) || view.scroller[loose] !== -1) return true;
  }
  return false;
}

interface Coverage {
  tested: number;
  blocked: number;
  controls: number;
  center: boolean;
}

/** Hit tests of controls inside `under` whose topmost element at a blocked point is inside `over`. */
function coverage(view: SnapshotView, under: number, over: number, overRect: Rect): Coverage {
  const h = view.body.hit_tests;
  const result: Coverage = { tested: 0, blocked: 0, controls: 0, center: false };
  for (let row = under; row <= view.end[under]; row++) {
    const at = view.hitRows.get(row);
    if (at === undefined) continue;
    if (area(intersect(view.visible[row], overRect)) <= 0) continue;
    result.tested += h.tested[at] ?? 0;
    const top = h.top[at];
    // An unknown top (for example a row dropped by truncation) is never counted as this element.
    if (!Number.isInteger(top) || top < 0 || !view.within(top, over)) continue;
    result.blocked += h.blocked[at] ?? 0;
    result.controls++;
    if ((h.points[at] ?? 0) & 1) result.center = true;
  }
  return result;
}

/** Area of the text boxes inside `row`'s subtree that `rect` covers; null when the content is unknown (opaque). */
function textOverlap(view: SnapshotView, row: number, rect: Rect, min: number): { px: number; covered: boolean } | null {
  if (view.has(row, FLAGS.opaque)) return null;
  let px = 0;
  let covered = false;
  for (let at = row; at <= view.end[row]; at++) {
    const boxes = view.textBoxes.get(at);
    if (!boxes) continue;
    for (const box of boxes) {
      const hit = intersect(box, rect);
      const w = hit.right - hit.left;
      const h = hit.bottom - hit.top;
      if (w > 0 && h > 0) px += w * h;
      if (w > min && h > min) covered = true;
    }
  }
  return { px: r2(px), covered };
}

function overlapFinding(ctx: Context, a: number, b: number): void {
  const { view, options } = ctx;
  const va = view.visible[a];
  const vb = view.visible[b];
  // Who is on top: a measured hit test when one exists, else CSS stacking order.
  const aUnder = coverage(view, a, b, vb);
  const bUnder = coverage(view, b, a, va);
  let fromHitTest = true;
  let top: number;
  if (aUnder.controls > bUnder.controls) top = b;
  else if (bUnder.controls > aUnder.controls) top = a;
  else {
    fromHitTest = false;
    const za = view.stackZ(a);
    const zb = view.stackZ(b);
    if (za !== zb) top = za > zb ? a : b;
    else if (view.isPositioned(a) !== view.isPositioned(b)) top = view.isPositioned(a) ? a : b;
    else top = b; // Later in document order paints later.
  }
  const subject = top === a ? b : a;
  const other = top;
  const vs = view.visible[subject];
  const vo = view.visible[other];
  const hit = intersect(vs, vo);
  const hitArea = area(hit);
  const covered = subject === a ? aUnder : bUnder;
  const subjectText = textOverlap(view, subject, vo, options.overlapMinPx);
  const otherText = textOverlap(view, other, vs, options.overlapMinPx);
  const common = view.common(subject, other);
  const sc = view.content(subject);
  const oc = view.content(other);
  emit(ctx, "overlap", subject, other, {
    overlap_px: r2(hitArea),
    overlap_width_px: r2(hit.right - hit.left),
    overlap_height_px: r2(hit.bottom - hit.top),
    subject_covered_ratio: ratio(hitArea, area(vs)),
    other_covered_ratio: ratio(hitArea, area(vo)),
    subject_blocked_points: covered.blocked,
    subject_tested_points: covered.tested,
    subject_blocked_controls: covered.controls,
    center_blocked: covered.center,
    subject_text_covered: subjectText ? subjectText.covered : null,
    subject_text_overlap_px: subjectText ? subjectText.px : null,
    subject_text_covered_ratio: subjectText && sc.textPx > 0 ? ratio(subjectText.px, sc.textPx) : null,
    other_text_overlap_px: otherText ? otherText.px : null,
    paint_order_from_hit_test: fromHitTest,
    subject_overlay: view.has(subject, FLAGS.overlay),
    other_overlay: view.has(other, FLAGS.overlay),
    other_pointer_events_none: view.has(other, FLAGS.pointer_events_none),
    subject_has_content: contentOf(sc),
    other_has_content: contentOf(oc),
    subject_decorative: sc.decorative,
    other_decorative: oc.decorative,
    subject_depth_to_common: common.a,
    other_depth_to_common: common.b,
    common_parent_positioned: common.row >= 0 ? view.position[common.row] !== 0 : null,
  });
}

/** Text or a control somewhere in the subtree; null when an opaque box hides it and there is no control. */
function contentOf(content: Content): boolean | null {
  return content.interactive || content.text === true ? true : content.text === null ? null : false;
}

// ---- Spill ---------------------------------------------------------------

function crossing(box: Rect, container: Rect): { left: number; right: number; top: number; bottom: number } {
  return {
    left: Math.max(0, container.left - box.left),
    right: Math.max(0, box.right - container.right),
    top: Math.max(0, container.top - box.top),
    bottom: Math.max(0, box.bottom - container.bottom),
  };
}

function spill(ctx: Context): void {
  const { view, options } = ctx;
  const tolerance = options.tolerancePx;
  const spilled = new Uint8Array(view.n);
  const inherited = new Uint8Array(view.n);
  for (let i = 0; i < view.n; i++) {
    const p = view.parent[i];
    if (p >= 0) inherited[i] = spilled[p] || inherited[p] ? 1 : 0;
    if (!view.shown(i)) continue;
    const container = view.clipper[i];
    if (container < 0) continue;
    // Inside a scroller, crossing is scrolling.
    if (view.has(container, FLAGS.scrollable)) continue;
    const box = view.box[i];
    const over = crossing(box, view.box[container]);
    if (Math.max(over.left, over.right, over.top, over.bottom) <= tolerance) continue;
    spilled[i] = 1;
    if (inherited[i]) continue;
    const text = view.textBoxes.get(i);
    const content = view.content(i);
    emit(ctx, "spill", i, container, {
      overflow_left_px: r2(over.left),
      overflow_right_px: r2(over.right),
      overflow_top_px: r2(over.top),
      overflow_bottom_px: r2(over.bottom),
      visible_ratio: ratio(area(view.visible[i]), area(box)),
      subject_interactive: view.has(i, FLAGS.interactive),
      subject_has_text: view.has(i, FLAGS.opaque) ? null : !!text,
      container_is_parent: container === view.parent[i],
      subject_has_content: contentOf(content),
      subject_decorative: content.decorative,
    });
  }
}

// ---- Page horizontal scroll ---------------------------------------------

function pageHorizontalScroll(ctx: Context): void {
  const { view, body, options } = ctx;
  const vp = body.viewport;
  const client = vp?.client_width || vp?.width || 0;
  const docWidth = body.document?.width ?? 0;
  if (!(client > 0) || docWidth <= client + options.tolerancePx) return;
  const scrollX = vp.scroll_x ?? 0;
  // The root and body propagate their overflow to the viewport rather than clipping.
  const pageLevel = (row: number) => {
    const tag = view.tag(row);
    return tag === "html" || tag === "body";
  };
  const contained = new Uint8Array(view.n);
  const culprit = new Uint8Array(view.n);
  let best = -1;
  let bestRight = -Infinity;
  let count = 0;
  for (let i = 0; i < view.n; i++) {
    const p = view.parent[i];
    if (p >= 0) contained[i] = contained[p] || (view.has(p, FLAGS.clips_content) && !pageLevel(p)) ? 1 : 0;
    if (contained[i] || view.position[i] === FIXED_POSITION || view.pinned[i] !== -1 && view.position[view.pinned[i]] === FIXED_POSITION) continue;
    const box = view.box[i];
    if (box.right - box.left <= 0 || box.bottom - box.top <= 0) continue;
    const right = box.right + scrollX;
    if (right <= client + options.tolerancePx) continue;
    culprit[i] = 1;
    if (p >= 0 && (culprit[p] || hasCulpritAncestor(view, culprit, p))) continue;
    count++;
    if (right > bestRight) {
      bestRight = right;
      best = i;
    }
  }
  // The element that widens the page may be in a part the walk did not record.
  if (best < 0 && body.truncated) return;
  emit(ctx, "page_h_scroll", best < 0 ? null : best, null, {
    document_width_px: r2(docWidth),
    client_width_px: r2(client),
    overflow_px: r2(docWidth - client),
    subject_right_px: best < 0 ? null : r2(bestRight),
    culprit_count: count,
  });
}

function hasCulpritAncestor(view: SnapshotView, culprit: Uint8Array, row: number): boolean {
  for (let at = row; at >= 0; at = view.parent[at]) if (culprit[at]) return true;
  return false;
}

// ---- Offscreen control ----------------------------------------------------

function offscreenControl(ctx: Context): void {
  const { view, body, options } = ctx;
  const vp = body.viewport;
  const cw = vp?.client_width || vp?.width || 0;
  const ch = vp?.client_height || vp?.height || 0;
  const docW = Math.max(body.document?.width ?? 0, cw);
  const docH = Math.max(body.document?.height ?? 0, ch);
  for (let i = 0; i < view.n; i++) {
    if (!view.has(i, FLAGS.interactive) || !view.shown(i)) continue;
    // Inside a scroller the control may simply be scrolled away.
    if (view.scroller[i] !== -1) continue;
    const box = view.box[i];
    const pinnedRow = view.pinned[i];
    // A fixed control never moves with the page: it must fit the viewport.
    const fixed = pinnedRow !== -1 && view.position[pinnedRow] === FIXED_POSITION;
    const dx = fixed ? 0 : vp?.scroll_x ?? 0;
    const dy = fixed ? 0 : vp?.scroll_y ?? 0;
    const page: Rect = fixed ? { left: 0, top: 0, right: cw, bottom: ch } : { left: 0, top: 0, right: docW, bottom: docH };
    const placed = { left: box.left + dx, top: box.top + dy, right: box.right + dx, bottom: box.bottom + dy };
    const over = crossing(placed, page);
    if (Math.max(over.left, over.right, over.top, over.bottom) <= options.tolerancePx) continue;
    emit(ctx, "offscreen_control", i, null, {
      outside_left_px: r2(over.left),
      outside_right_px: r2(over.right),
      outside_top_px: r2(over.top),
      outside_bottom_px: r2(over.bottom),
      reachable_ratio: ratio(area(intersect(placed, page)), area(placed)),
      fixed,
    });
  }
}

// ---- Small tap target ------------------------------------------------------

function smallTapTarget(ctx: Context): void {
  const { view, body, options } = ctx;
  const touch = options.touch ?? body.viewport?.coarse_pointer === true;
  if (!touch) return;
  const min = options.minTapTargetPx;
  const controls: number[] = [];
  for (let i = 0; i < view.n; i++) if (view.has(i, FLAGS.interactive) && view.shown(i)) controls.push(i);
  for (const i of controls) {
    const box = view.box[i];
    const w = box.right - box.left;
    const h = box.bottom - box.top;
    if (w >= min && h >= min) continue;
    let gap: number | null = null;
    for (const j of controls) {
      if (j === i || view.within(j, i) || view.within(i, j)) continue;
      const o = view.box[j];
      const dx = Math.max(0, o.left - box.right, box.left - o.right);
      const dy = Math.max(0, o.top - box.bottom, box.top - o.bottom);
      const d = Math.hypot(dx, dy);
      if (gap === null || d < gap) gap = d;
    }
    const p = view.parent[i];
    emit(ctx, "small_tap_target", i, null, {
      width_px: r2(w),
      height_px: r2(h),
      min_size_px: min,
      nearest_control_gap_px: gap === null ? null : r2(gap),
      inline_in_text: view.tag(i) === "a" && p >= 0 && (body.elements.text_length[p] ?? 0) > 0,
    });
  }
}

// ---- Clipped text ------------------------------------------------------------

function clippedText(ctx: Context): void {
  const { view, options } = ctx;
  const tolerance = options.tolerancePx;
  for (const [row, boxes] of view.textBoxes) {
    if (!view.shown(row)) continue;
    for (const [index, text] of boxes.entries()) {
      // Walk out from the text's own element to the first clipping box it crosses.
      let clipper = -1;
      let ellipsis = false;
      let over = { left: 0, right: 0, top: 0, bottom: 0 };
      for (let at = row; at >= 0; at = view.parent[at]) {
        if (view.has(at, FLAGS.ellipsis)) ellipsis = true;
        if (view.has(at, FLAGS.clips_content)) {
          const cross = crossing(text, view.box[at]);
          if (Math.max(cross.left, cross.right, cross.top, cross.bottom) > tolerance) {
            clipper = at;
            over = cross;
            break;
          }
        }
        if (view.position[at] === FIXED_POSITION) break;
      }
      if (clipper < 0 || ellipsis) continue;
      if (view.has(clipper, FLAGS.scrollable)) continue;
      const c = view.box[clipper];
      // A clipping box of a pixel or less is screen-reader-only text, not visible text.
      if (c.right - c.left <= 1 || c.bottom - c.top <= 1) continue;
      emit(ctx, "clipped_text", row, clipper === row ? null : clipper, {
        text_clipped: true,
        clipped_left_px: r2(over.left),
        clipped_right_px: r2(over.right),
        clipped_top_px: r2(over.top),
        clipped_bottom_px: r2(over.bottom),
        text_visible_ratio: ratio(area(intersect(text, c)), area(text)),
        text_width_px: r2(text.right - text.left),
        lines: view.textLines.get(row)?.[index] ?? null,
        clipper_is_self: clipper === row,
      });
      break;
    }
  }
}

// ---- Broken image --------------------------------------------------------------

function brokenImage(ctx: Context): void {
  const { view } = ctx;
  for (let i = 0; i < view.n; i++) {
    if (!view.has(i, FLAGS.broken_image) || view.has(i, FLAGS.ignored)) continue;
    const box = view.box[i];
    emit(ctx, "broken_image", i, null, {
      width_px: r2(box.right - box.left),
      height_px: r2(box.bottom - box.top),
      visible: view.has(i, FLAGS.visible),
    });
  }
}

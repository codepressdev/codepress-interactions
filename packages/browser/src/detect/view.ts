/**
 * A decoded, read-only view of a snapshot body: tree ranges, clip chains,
 * overlay layers and stable element identities. Pure computation over the
 * columns; no DOM.
 */
import { FLAGS, POSITIONS, type SnapshotBody } from "../format";
import type { ElementRef } from "./types";

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Roles whose element floats over the page by design. */
const OVERLAY_ROLES = new Set(["dialog", "alertdialog", "tooltip", "menu", "listbox"]);
const STATIC = 0;
const ABSOLUTE = 2;
const FIXED = 3;
const STICKY = 4;
/** Structural paths stop after this many tags. */
const PATH_DEPTH = 8;

export const area = (r: Rect): number => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);

export const intersect = (a: Rect, b: Rect | null): Rect =>
  b
    ? {
        left: Math.max(a.left, b.left),
        top: Math.max(a.top, b.top),
        right: Math.min(a.right, b.right),
        bottom: Math.min(a.bottom, b.bottom),
      }
    : a;

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export interface Content {
  text: boolean | null;
  textPx: number;
  interactive: boolean;
  decorative: boolean;
}

export class SnapshotView {
  readonly n: number;
  readonly parent: Int32Array;
  /** Last row of each element's subtree (rows are depth-first pre-order). */
  readonly end: Int32Array;
  readonly flags: Uint32Array;
  readonly position: Uint8Array;
  readonly box: Rect[];
  /** Box intersected with every clipping ancestor that applies (fixed elements escape them). */
  readonly visible: Rect[];
  /** Nearest clipping ancestor that applies, or -1. */
  readonly clipper: Int32Array;
  /** Nearest scrollable ancestor (not the document), or -1. */
  readonly scroller: Int32Array;
  /** Outermost fixed or sticky element at or above this row, or -1. */
  readonly pinned: Int32Array;
  /** Row of the overlay layer this row belongs to (a dialog, menu, tooltip, popover or scrim and its positioned wrappers), or -1. */
  readonly layer: Int32Array;
  readonly textBoxes: Map<number, Rect[]>;
  readonly hitRows: Map<number, number>;
  readonly documentScrolls: boolean;
  /** The page is scrolled away from its origin. */
  readonly documentScrolled: boolean;
  private paths = new Map<number, string>();
  private contents = new Map<number, Content>();

  constructor(readonly body: SnapshotBody) {
    const e = body.elements;
    const n = Math.max(
      0,
      Math.min(
        ...(["parent", "tag", "role", "test_id", "x", "y", "width", "height", "z_index", "position", "flags", "text_length"] as const).map(
          (key) => (Array.isArray(e?.[key]) ? e[key].length : 0),
        ),
      ),
    );
    this.n = n;
    this.parent = new Int32Array(n);
    this.end = new Int32Array(n);
    this.flags = new Uint32Array(n);
    this.position = new Uint8Array(n);
    this.clipper = new Int32Array(n);
    this.scroller = new Int32Array(n);
    this.pinned = new Int32Array(n);
    this.layer = new Int32Array(n).fill(-1);
    this.box = new Array(n);
    this.visible = new Array(n);
    const childClip: (Rect | null)[] = new Array(n);
    const vp = body.viewport ?? ({} as SnapshotBody["viewport"]);
    const clientWidth = num(vp.client_width) || num(vp.width);
    const clientHeight = num(vp.client_height) || num(vp.height);
    for (let i = 0; i < n; i++) {
      // A parent always precedes its children; anything else is malformed and treated as a root.
      const p = Number.isInteger(e.parent[i]) && e.parent[i] >= 0 && e.parent[i] < i ? e.parent[i] : -1;
      this.parent[i] = p;
      this.end[i] = i;
      this.flags[i] = Number.isInteger(e.flags[i]) ? e.flags[i] >>> 0 : 0;
      const position = e.position[i];
      this.position[i] = Number.isInteger(position) && position >= 0 && position < POSITIONS.length ? position : STATIC;
      const x = num(e.x[i]);
      const y = num(e.y[i]);
      const box = { left: x, top: y, right: x + Math.max(0, num(e.width[i])), bottom: y + Math.max(0, num(e.height[i])) };
      this.box[i] = box;
      const fixed = this.position[i] === FIXED;
      const clip = fixed || p < 0 ? null : childClip[p];
      this.visible[i] = intersect(box, clip);
      const clips = (this.flags[i] & FLAGS.clips_content) !== 0;
      childClip[i] = clips ? intersect(box, clip) : clip;
      this.clipper[i] = fixed || p < 0 ? -1 : (this.flags[p] & FLAGS.clips_content) !== 0 ? p : this.clipper[p];
      this.scroller[i] = p < 0 ? -1 : (this.flags[p] & FLAGS.scrollable) !== 0 ? p : this.scroller[p];
      const pinnedAbove = p < 0 ? -1 : this.pinned[p];
      this.pinned[i] = pinnedAbove !== -1 ? pinnedAbove : fixed || this.position[i] === STICKY ? i : -1;
    }
    for (let i = n - 1; i > 0; i--) {
      const p = this.parent[i];
      if (p >= 0 && this.end[i] > this.end[p]) this.end[p] = this.end[i];
    }

    // Overlay layers: recognized overlays and the positioned wrappers they sit in.
    const viewportArea = clientWidth * clientHeight;
    const roles = body.dictionaries?.role ?? [];
    const tags = body.dictionaries?.tag ?? [];
    const top = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const role = roles[e.role[i]];
      const tag = tags[e.tag[i]];
      const scrim =
        (this.flags[i] & FLAGS.overlay) !== 0 &&
        (this.position[i] === FIXED || this.position[i] === ABSOLUTE) &&
        viewportArea > 0 &&
        area(intersect(this.box[i], { left: 0, top: 0, right: clientWidth, bottom: clientHeight })) >= 0.9 * viewportArea;
      if (!(role && OVERLAY_ROLES.has(role)) && tag !== "dialog" && !(this.flags[i] & FLAGS.popover_open) && !scrim) continue;
      let at = i;
      for (let up = this.parent[at]; up >= 0 && (this.position[up] === ABSOLUTE || this.position[up] === FIXED); up = this.parent[up]) at = up;
      top[at] = at;
    }
    for (let i = 0; i < n; i++) {
      const p = this.parent[i];
      this.layer[i] = p >= 0 && this.layer[p] !== -1 ? this.layer[p] : top[i];
    }

    this.textBoxes = new Map();
    const t = body.text_boxes;
    const tn = Math.min(...(["element", "x", "y", "width", "height"] as const).map((key) => (Array.isArray(t?.[key]) ? t[key].length : 0)));
    for (let i = 0; i < tn; i++) {
      const row = t.element[i];
      if (!Number.isInteger(row) || row < 0 || row >= n) continue;
      const x = num(t.x[i]);
      const y = num(t.y[i]);
      const rect = { left: x, top: y, right: x + num(t.width[i]), bottom: y + num(t.height[i]) };
      const list = this.textBoxes.get(row);
      if (list) list.push(rect);
      else this.textBoxes.set(row, [rect]);
    }
    this.hitRows = new Map();
    const h = body.hit_tests;
    const hn = Math.min(...(["element", "tested", "blocked", "points", "top"] as const).map((key) => (Array.isArray(h?.[key]) ? h[key].length : 0)));
    for (let i = 0; i < hn; i++) if (Number.isInteger(h.element[i]) && h.element[i] >= 0 && h.element[i] < n) this.hitRows.set(h.element[i], i);
    const doc = body.document ?? { width: 0, height: 0 };
    this.documentScrolls = num(doc.height) > clientHeight + 1 || num(doc.width) > clientWidth + 1;
    this.documentScrolled = num(body.viewport?.scroll_x) > 0.5 || num(body.viewport?.scroll_y) > 0.5;
  }

  has(row: number, flag: number): boolean {
    return (this.flags[row] & flag) !== 0;
  }

  /**
   * What the element's subtree holds that a person would read or use: shown
   * text (its area, in px²) and enabled controls. `text` is null when an opaque
   * box (canvas, iframe, video) hides whether there is any.
   */
  content(row: number): Content {
    const cached = this.contents.get(row);
    if (cached) return cached;
    let textPx = 0;
    let unknown = false;
    let interactive = false;
    for (let at = row; at <= this.end[row]; at++) {
      if (!this.shown(at)) continue;
      if (this.has(at, FLAGS.interactive)) interactive = true;
      if (this.has(at, FLAGS.opaque)) unknown = true;
      for (const box of this.textBoxes.get(at) ?? []) textPx += Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top);
    }
    const text = textPx > 0 ? true : unknown ? null : false;
    const result: Content = {
      text,
      textPx,
      interactive,
      // Nothing to read or use, and either hidden from assistive technology or
      // not hit-testable: a decorative layer (gradient, glow, background art).
      decorative:
        text === false &&
        !interactive &&
        (this.has(row, FLAGS.aria_hidden) || this.has(row, FLAGS.pointer_events_none)),
    };
    this.contents.set(row, result);
    return result;
  }

  /** `row` is `ancestor` or inside it. */
  within(row: number, ancestor: number): boolean {
    return row >= ancestor && row <= this.end[ancestor];
  }

  /** Rendered and not marked ignored. 1x1-or-smaller boxes are visually hidden (screen-reader-only) content. */
  shown(row: number): boolean {
    const b = this.box[row];
    return (
      this.has(row, FLAGS.visible) &&
      !this.has(row, FLAGS.ignored) &&
      !(b.right - b.left <= 1 && b.bottom - b.top <= 1)
    );
  }

  tag(row: number): string {
    const tag = this.body.dictionaries?.tag?.[this.body.elements.tag[row]];
    return typeof tag === "string" ? tag : "unknown";
  }

  role(row: number): string | null {
    const role = this.body.dictionaries?.role?.[this.body.elements.role[row]];
    return typeof role === "string" ? role : null;
  }

  testId(row: number): string | null {
    const id = this.body.dictionaries?.test_id?.[this.body.elements.test_id[row]];
    return typeof id === "string" ? id : null;
  }

  /** Test ID, else a structural path from the nearest ancestor with one. Never coordinates or sibling positions. */
  stableId(row: number): string {
    const own = this.testId(row);
    if (own) return own;
    const cached = this.paths.get(row);
    if (cached) return cached;
    const tags: string[] = [];
    let anchor: string | null = null;
    let at = row;
    for (; at >= 0 && tags.length < PATH_DEPTH; at = this.parent[at]) {
      const id = at === row ? null : this.testId(at);
      if (id) {
        anchor = `#${id}`;
        break;
      }
      tags.unshift(this.tag(at));
    }
    const prefix = anchor ?? (at >= 0 ? "*" : null);
    const path = (prefix ? [prefix, ...tags] : tags).join("/");
    this.paths.set(row, path);
    return path;
  }

  structural(row: number): boolean {
    return !this.testId(row);
  }

  ref(row: number): ElementRef {
    const e = this.body.elements;
    const z = e.z_index[row];
    return {
      index: row,
      tag: this.tag(row),
      role: this.role(row),
      test_id: this.testId(row),
      stable_id: this.stableId(row),
      x: num(e.x[row]),
      y: num(e.y[row]),
      width: Math.max(0, num(e.width[row])),
      height: Math.max(0, num(e.height[row])),
      position: POSITIONS[this.position[row]],
      z_index: typeof z === "number" && Number.isInteger(z) ? z : null,
    };
  }

  /** Lowest common ancestor and how many levels each row is below it; -1 when none. */
  common(a: number, b: number): { row: number; a: number; b: number } {
    const depthOf = new Map<number, number>();
    let depth = 0;
    for (let at = a; at >= 0; at = this.parent[at]) depthOf.set(at, depth++);
    depth = 0;
    for (let at = b; at >= 0; at = this.parent[at], depth++) {
      const found = depthOf.get(at);
      if (found !== undefined) return { row: at, a: found, b: depth };
    }
    return { row: -1, a: -1, b: -1 };
  }

  /** Effective z order: z-index of the nearest positioned ancestor-or-self that sets one. */
  stackZ(row: number): number {
    for (let at = row; at >= 0; at = this.parent[at]) {
      const z = this.body.elements.z_index[at];
      if (this.position[at] !== STATIC && typeof z === "number") return z;
    }
    return 0;
  }

  isPositioned(row: number): boolean {
    for (let at = row; at >= 0; at = this.parent[at]) if (this.position[at] !== STATIC) return true;
    return false;
  }
}

export const FIXED_POSITION = FIXED;

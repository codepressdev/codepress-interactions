/**
 * Screen snapshots: a time-sliced walk of the rendered element tree that records
 * geometry and layout facts in a columnar body. Never records text, values,
 * attributes other than role/test IDs, URLs or HTML.
 */
import { FLAGS, HIT_POINTS, POSITIONS, THEMES, type SnapshotBody, type Theme } from "./format";
import { blends, namedFromContent, paint, paintsOwnLayer, rootBackdrop, unnamedControl, UNMEASURED, type Backdrop } from "./a11y";
import { composite, floorRatio, luminance, luminanceOf, parseColor, ratioOf } from "./color";
import type { SnapshotTrigger } from "./types";
import { elementTestId, now, type TestIdFilter } from "./util";

export { FLAGS, HIT_POINTS, POSITIONS, THEMES } from "./format";
export type { SnapshotBody } from "./format";

export interface SnapshotSummary {
  sha256: string;
  trigger: SnapshotTrigger;
  route_template: string | null;
  viewport_width: number;
  viewport_height: number;
  element_count: number;
  truncated: boolean;
  torn: boolean;
  bytes: number;
  walk_ms: number;
  slices: number;
  max_slice_ms: number;
  /** Local diagnostics only (first 500 slices); never sent. Nodes visited per slice, including skipped ones. */
  slice_ms: number[];
  slice_elements: number[];
  /** Elements processed between clock checks. */
  check_every: number;
  deduplicated: boolean;
}

export interface WalkOptions {
  root: Element;
  maxElements: number;
  maxSliceMs: number;
  ignoreSelector: string;
  routeTemplate: string | null;
  /** Checked before every slice; returning true abandons the walk. */
  shouldAbort: () => boolean;
  /** The theme actually showing, when the app has its own toggle. Default: prefers-color-scheme. */
  theme?: () => unknown;
  /** Test ID filter (the `testId` option). Default: `defaultTestIdFilter`. */
  testId?: TestIdFilter;
  /** Contrast is worked out for at most this many text elements per snapshot. Default 2000; 0 turns it off (no colour reads, no `contrast` table). */
  maxContrastElements?: number;
  /** Look for controls without an accessible name. Default true; false leaves out the `unnamed_controls` table. */
  unnamedControls?: boolean;
}

export interface WalkResult {
  body: SnapshotBody;
  walkMs: number;
  slices: number;
  maxSliceMs: number;
  sliceMs: number[];
  sliceElements: number[];
  /** Elements with their own text whose contrast could not be measured (an image, gradient, filter, blend mode, opacity or layered box behind or on them). */
  contrastUnknown: number;
}

/** The marker that allows a designed overlap with named partners (test IDs) or `*`. */
export const ALLOW_OVERLAP_ATTRIBUTE = "data-layout-allow-overlap";
/** Most partner names read from one marker; longer lists are cut. */
const ALLOW_TOKENS = 32;
/** Most allowed pairs recorded in one body. */
export const MAX_ALLOWED_PAIRS = 10_000;

/** Clock checks happen once per batch of this many elements. */
export const CHECK_EVERY = 8;

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "TEMPLATE", "HEAD", "NOSCRIPT", "LINK", "META", "TITLE", "BASE",
]);
const OPAQUE_TAGS = new Set(["CANVAS", "IFRAME", "FRAME", "EMBED", "OBJECT", "VIDEO"]);
/** Recorded as one box; internals are not layout of interest (or have no boxes). */
const LEAF_TAGS = new Set(["svg", "SVG", "MATH", "math", "SELECT", "PICTURE", "AUDIO"]);
/** Enabled-or-not controls: focusable/clickable elements and control roles. */
export const INTERACTIVE = [
  "a[href]", "button", 'input:not([type="hidden"])', "select", "textarea", "summary",
  "[tabindex]:not([tabindex='-1'])", '[contenteditable=""]', '[contenteditable="true"]',
  ...[
    "button", "link", "checkbox", "radio", "switch", "tab", "menuitem",
    "menuitemcheckbox", "menuitemradio", "option", "slider", "combobox", "textbox",
  ].map((role) => `[role="${role}"]`),
].join(",");
const OVERLAY_ROLES = new Set(["dialog", "alertdialog", "tooltip", "menu", "listbox"]);
const IMPLICIT_ROLES: Record<string, string> = {
  BUTTON: "button", SUMMARY: "button", SELECT: "combobox", TEXTAREA: "textbox",
  IMG: "img", NAV: "navigation", MAIN: "main", DIALOG: "dialog", FORM: "form",
  UL: "list", OL: "list", LI: "listitem", TABLE: "table", H1: "heading",
  H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading",
  PROGRESS: "progressbar", ASIDE: "complementary",
};
const INPUT_ROLES: Record<string, string> = {
  checkbox: "checkbox", radio: "radio", range: "slider", button: "button",
  submit: "button", reset: "button", image: "button",
};

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
interface Frame {
  /** Lazily iterated siblings (light DOM) or an explicit list (shadow/slot). */
  next: Element | null;
  list: Element[] | null;
  index: number;
  parent: number;
  clip: Rect | null;
  opacity: number;
  /** What the parent's content is painted on. */
  backdrop: Backdrop;
}

/** Text whose contrast was measured, waiting for the check against positioned layers. */
interface ContrastCandidate {
  row: number;
  box: Rect;
  ratio: number;
  fontPx: number;
  bold: boolean;
  opaqueRow: number;
  opaquePositioned: boolean;
  opaqueZ: number;
}

/** A visible positioned element: it may paint a layer of its own (background or replaced content). */
interface Painter {
  row: number;
  element: Element;
  box: Rect;
  z: number;
}

const r2 = (value: number): number => {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
};

function implicitRole(element: Element): string | null {
  const tag = element.tagName;
  if (tag === "A") return element.hasAttribute("href") ? "link" : null;
  if (tag === "INPUT") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    return INPUT_ROLES[type] ?? "textbox";
  }
  return IMPLICIT_ROLES[tag] ?? null;
}

function roleOf(element: Element): string | null {
  const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0]?.toLowerCase();
  if (explicit && /^[a-z]{1,32}$/.test(explicit)) return explicit;
  return implicitRole(element);
}

function tagOf(element: Element): string {
  const tag = element.localName.toLowerCase();
  return /^[a-z][a-z0-9-]{0,63}$/.test(tag) ? tag : "unknown";
}

const intersect = (a: Rect | null, b: Rect): Rect =>
  a
    ? {
        left: Math.max(a.left, b.left),
        top: Math.max(a.top, b.top),
        right: Math.min(a.right, b.right),
        bottom: Math.min(a.bottom, b.bottom),
      }
    : b;

const clipsOverflow = (style: CSSStyleDeclaration): boolean =>
  style.overflowX !== "visible" ||
  style.overflowY !== "visible" ||
  /\b(paint|strict|content)\b/.test(style.contain ?? "");

const yieldToIdle = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestIdleCallback === "function")
      requestIdleCallback(() => resolve(), { timeout: 250 });
    else setTimeout(resolve, 0);
  });

class Dictionary {
  readonly values: string[] = [];
  private index = new Map<string, number>();
  get(value: string | null | undefined): number {
    if (!value) return -1;
    let found = this.index.get(value);
    if (found === undefined) {
      found = this.values.length;
      this.values.push(value);
      this.index.set(value, found);
    }
    return found;
  }
}

/** Walks the rendered tree in slices of at most ~maxSliceMs main-thread time. */
export async function walkSnapshot(options: WalkOptions): Promise<WalkResult | null> {
  const { root, maxElements, maxSliceMs } = options;
  const ignoreSelector = [
    "[data-layout-ignore]",
    "[data-interactions-exclude]",
    options.ignoreSelector,
  ]
    .filter(Boolean)
    .join(",");
  const view = document.documentElement;
  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
    client_width: view.clientWidth,
    client_height: view.clientHeight,
    device_pixel_ratio: r2(window.devicePixelRatio || 1),
    scroll_x: r2(window.scrollX),
    scroll_y: r2(window.scrollY),
    coarse_pointer: coarsePointer(),
    theme: themeOf(options.theme),
  };
  const tags = new Dictionary();
  const roles = new Dictionary();
  const testIds = new Dictionary();
  const elements: SnapshotBody["elements"] = {
    parent: [], tag: [], role: [], test_id: [], x: [], y: [], width: [], height: [],
    z_index: [], position: [], flags: [], text_length: [],
  };
  const text: SnapshotBody["text_boxes"] = {
    element: [], x: [], y: [], width: [], height: [], lines: [],
  };
  const hits: SnapshotBody["hit_tests"] = {
    element: [], tested: [], blocked: [], points: [], top: [],
  };
  const contrast: NonNullable<SnapshotBody["contrast"]> = { element: [], ratio: [], font_px: [], bold: [] };
  const unnamed: NonNullable<SnapshotBody["unnamed_controls"]> = { element: [], has_title: [], icon_only: [] };
  const candidates: ContrastCandidate[] = [];
  const painters: Painter[] = [];
  let contrastUnknown = 0;
  /** Text elements whose contrast was worked out, up to the cap. */
  let measured = 0;
  const maxContrast = options.maxContrastElements ?? 2000;
  const measureNames = options.unnamedControls !== false;
  // Filters and blend modes are read only up the ancestors of low-contrast
  // text: per row, 0 not read yet, 1 none at or above it, 2 one at or above it.
  const rowStyles: CSSStyleDeclaration[] = [];
  const blendState = new Uint8Array(maxContrast > 0 ? maxElements : 0);
  const blendedAt = (row: number): boolean => {
    const path: number[] = [];
    let at = row;
    while (at >= 0 && blendState[at] === 0) {
      path.push(at);
      at = elements.parent[at];
    }
    let state = at >= 0 ? blendState[at] : 1;
    for (let i = path.length - 1; i >= 0; i--) {
      if (state !== 2 && blends(rowStyles[path[i]])) state = 2;
      blendState[path[i]] = state;
    }
    return state === 2;
  };
  const hitTargets: (Element | null)[] = [];
  const indexOf = new Map<Element, number>();
  /** Rows carrying the allow marker and the names it lists; never leaves the page. */
  const marked: { row: number; names: string[] }[] = [];

  let torn = false;
  const markTorn = () => {
    torn = true;
  };
  const tornObserver = new MutationObserver(markTorn);
  tornObserver.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  window.addEventListener("resize", markTorn, true);
  document.addEventListener("scroll", markTorn, { capture: true, passive: true });

  const stack: Frame[] = [
    { next: root, list: null, index: 0, parent: -1, clip: null, opacity: 1, backdrop: maxContrast > 0 ? rootBackdrop(root) : UNMEASURED },
  ];
  // The root itself is visited once: stop the sibling chain after it.
  let rootPending = true;
  const takeNext = (frame: Frame): Element | null => {
    if (frame.list) return frame.index < frame.list.length ? frame.list[frame.index++] : null;
    const element = frame.next;
    if (element) {
      if (rootPending && element === root) {
        rootPending = false;
        frame.next = null;
      } else frame.next = element.nextElementSibling;
    }
    return element;
  };
  const hasMore = (): boolean =>
    stack.some((frame) => (frame.list ? frame.index < frame.list.length : !!frame.next));

  const visit = (element: Element, frame: Frame): void => {
    if (SKIP_TAGS.has(element.tagName)) return;
    const style = getComputedStyle(element);
    if (style.display === "none") return;
    const rect = element.getBoundingClientRect();
    const box: Rect = {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    };
    const index = elements.parent.length;
    indexOf.set(element, index);
    const ownOpacity = parseFloat(style.opacity) || 0;
    const opacity = frame.opacity * ownOpacity;
    const hasArea = rect.width > 0 && rect.height > 0;
    const clip = style.position === "fixed" ? null : frame.clip;
    const clipped =
      hasArea &&
      !!clip &&
      (box.left < clip.left - 0.5 ||
        box.top < clip.top - 0.5 ||
        box.right > clip.right + 0.5 ||
        box.bottom > clip.bottom + 0.5);
    const fullyClipped =
      !!clip &&
      (box.right <= clip.left || box.left >= clip.right ||
        box.bottom <= clip.top || box.top >= clip.bottom);
    const ignored = element.matches(ignoreSelector);
    const opaque = OPAQUE_TAGS.has(element.tagName);
    const role = roleOf(element);
    const interactive =
      !ignored &&
      element.matches(INTERACTIVE) &&
      !(element as HTMLButtonElement).disabled &&
      !element.closest("fieldset:disabled");
    const visible =
      hasArea && style.visibility === "visible" && opacity > 0.01 && !fullyClipped && rendered(element);
    const contentClip = clipsOverflow(style);
    const scrollable =
      /auto|scroll|overlay/.test(style.overflowX + style.overflowY) &&
      (element.scrollHeight > element.clientHeight + 1 ||
        element.scrollWidth > element.clientWidth + 1);
    const position = Math.max(0, POSITIONS.indexOf(style.position as (typeof POSITIONS)[number]));
    const z = style.zIndex === "auto" ? null : parseInt(style.zIndex, 10);
    const zIndex = z === null || !Number.isFinite(z) ? null : Math.max(-2147483648, Math.min(2147483647, z));
    const popoverOpen = safeMatches(element, ":popover-open");
    const overlay =
      style.position === "fixed" ||
      (style.position === "absolute" && zIndex !== null && zIndex > 0) ||
      (role !== null && OVERLAY_ROLES.has(role)) ||
      (element.tagName === "DIALOG" && element.hasAttribute("open")) ||
      popoverOpen;

    let flags = 0;
    if (visible) flags |= FLAGS.visible;
    if (interactive) flags |= FLAGS.interactive;
    if (clipped) flags |= FLAGS.clipped;
    if (scrollable) flags |= FLAGS.scrollable;
    if (overlay) flags |= FLAGS.overlay;
    if (ignored) flags |= FLAGS.ignored;
    if (style.pointerEvents === "none") flags |= FLAGS.pointer_events_none;
    if (opaque) flags |= FLAGS.opaque;
    if (contentClip) flags |= FLAGS.clips_content;
    // From the element's own tree, not the walk: slotted light-DOM content is
    // walked under its slot but lives in the host's tree.
    if (typeof ShadowRoot === "function" && element.getRootNode() instanceof ShadowRoot)
      flags |= FLAGS.in_shadow;
    if (popoverOpen) flags |= FLAGS.popover_open;
    const names = ignored ? null : allowNames(element);
    if (names) {
      flags |= FLAGS.allow_overlap;
      marked.push({ row: index, names });
    }
    // Hidden from assistive technology, itself or through an ancestor.
    if (element.closest('[aria-hidden="true"]')) flags |= FLAGS.aria_hidden;
    if (
      style.textOverflow === "ellipsis" ||
      ((style as CSSStyleDeclaration & { webkitLineClamp?: string }).webkitLineClamp ?? "none") !== "none"
    )
      flags |= FLAGS.ellipsis;
    if (
      element.tagName === "IMG" &&
      (element as HTMLImageElement).complete &&
      (element as HTMLImageElement).naturalWidth === 0 &&
      !!(element as HTMLImageElement).currentSrc
    )
      flags |= FLAGS.broken_image;

    let textLength = 0;
    if (!ignored && !opaque && visible) textLength = measureText(element, index, text);

    // The backdrop is worked out only where something uses it: own text or children.
    // Past the contrast cap no backdrop is worked out: children share the parent's.
    let backdrop: Backdrop | null = measured >= maxContrast ? frame.backdrop : null;
    // Whether it paints a layer is read in the post-pass, only when some text measures low.
    if (measured < maxContrast && visible && position !== 0) painters.push({ row: index, element, box, z: zIndex ?? 0 });
    if (textLength > 0 && !(flags & FLAGS.aria_hidden) && measured < maxContrast) {
      measured++;
      const own = (backdrop ??= paint(element, style, box, frame.backdrop, index, zIndex ?? 0, ownOpacity, position !== 0));
      // Gradient text (background-clip: text) has its own background image, so it is unknown here.
      const fgValue = own.disabled ? "" : style.color;
      const fg = own.disabled ? null : parseColor(fgValue);
      if (own.disabled || (fg && fg[3] === 0)) {
        // Exempt (an inactive control) or not painted at all.
      } else if (own.tainted || !own.color || !fg) contrastUnknown++;
      else {
        const last = text.element.length - 1;
        const textBox: Rect =
          last >= 0 && text.element[last] === index
            ? { left: text.x[last], top: text.y[last], right: text.x[last] + text.width[last], bottom: text.y[last] + text.height[last] }
            : box;
        const clipBox = own.clip;
        if (
          clipBox &&
          (textBox.left < clipBox.left - 1 || textBox.top < clipBox.top - 1 ||
            textBox.right > clipBox.right + 1 || textBox.bottom > clipBox.bottom + 1)
        )
          contrastUnknown++;
        else {
          const bgLuminance = own.luminance;
          const fgLuminance = fg[3] >= 1 ? luminanceOf(fgValue, fg) : luminance(composite(fg, own.color));
          const ratio = floorRatio(ratioOf(fgLuminance, bgLuminance));
          // 4.5:1 meets every size threshold, so only text below it is looked at
          // further: font size and weight, filters and blend modes on the way up,
          // and (in the post-pass) positioned layers overlapping it.
          if (ratio >= 4.5) {
            // Meets the minimum for any size.
          } else if (blends(style) || (frame.parent >= 0 && blendedAt(frame.parent))) contrastUnknown++;
          else candidates.push({
            row: index,
            box: textBox,
            ratio,
            fontPx: r2(parseFloat(style.fontSize) || 0),
            bold: (parseInt(style.fontWeight, 10) || 400) >= 700,
            opaqueRow: own.opaqueRow,
            opaquePositioned: own.opaquePositioned,
            opaqueZ: own.opaqueZ,
          });
        }
      }
    }
    // A button or link with text of its own is named by it (the common case: no further reads).
    if (measureNames && interactive && visible && role && !(flags & FLAGS.aria_hidden) && !(textLength > 0 && namedFromContent(role))) {
      const missing = unnamedControl(element, role);
      if (missing) {
        unnamed.element.push(index);
        unnamed.has_title.push(missing.hasTitle);
        unnamed.icon_only.push(missing.iconOnly);
      }
    }

    elements.parent.push(frame.parent);
    if (maxContrast > 0) rowStyles.push(style);
    elements.tag.push(tags.get(tagOf(element)));
    elements.role.push(roles.get(role));
    elements.test_id.push(
      testIds.get(elementTestId(element, options.testId)),
    );
    elements.x.push(r2(rect.left));
    elements.y.push(r2(rect.top));
    elements.width.push(r2(rect.width));
    elements.height.push(r2(rect.height));
    elements.z_index.push(zIndex);
    elements.position.push(position);
    elements.flags.push(flags);
    elements.text_length.push(textLength);

    if (interactive && visible) hitTest(element, rect, viewport, index, hits, hitTargets);

    if (ignored || opaque || LEAF_TAGS.has(element.tagName)) return;
    let children: Element[] | null = null;
    const shadowRoot = (element as HTMLElement).shadowRoot;
    if (shadowRoot) {
      children = Array.from(shadowRoot.children);
    } else if (element instanceof HTMLSlotElement) {
      const assigned = element.assignedElements({ flatten: true });
      if (assigned.length) children = assigned;
    }
    const first = children ? null : element.firstElementChild;
    if (!children && !first) return;
    stack.push({
      next: first,
      list: children,
      index: 0,
      parent: index,
      clip: contentClip ? intersect(clip, box) : clip,
      opacity,
      backdrop: backdrop ?? paint(element, style, box, frame.backdrop, index, zIndex ?? 0, ownOpacity, position !== 0),
    });
  };

  const sliceMs: number[] = [];
  const sliceElements: number[] = [];
  let walkMs = 0;
  let maxSlice = 0;
  let lastSliceMs = 0;
  let slices = 0;
  let truncated = false;
  try {
    for (;;) {
      if (options.shouldAbort()) return null;
      const started = now();
      let processed = 0;
      let elapsed = 0;
      while (stack.length) {
        if (elements.parent.length >= maxElements) {
          truncated = hasMore();
          stack.length = 0;
          break;
        }
        const frame = stack[stack.length - 1];
        const element = takeNext(frame);
        if (!element) {
          stack.pop();
          continue;
        }
        visit(element, frame);
        if (++processed % CHECK_EVERY === 0) {
          elapsed = now() - started;
          if (elapsed >= maxSliceMs) break;
        }
      }
      elapsed = now() - started;
      slices++;
      walkMs += elapsed;
      maxSlice = Math.max(maxSlice, elapsed);
      lastSliceMs = elapsed;
      if (sliceMs.length < 500) {
        sliceMs.push(Math.round(elapsed * 1000) / 1000);
        sliceElements.push(processed);
      }
      if (!stack.length) break;
      await yieldToIdle();
      // Mutation records for changes made while yielded are delivered by now.
      if (tornObserver.takeRecords().length) torn = true;
    }
  } finally {
    tornObserver.disconnect();
    window.removeEventListener("resize", markTorn, true);
    document.removeEventListener("scroll", markTorn, { capture: true });
  }

  // Runs in the same task as the last slice: its time counts towards that slice.
  const postStarted = now();
  const layered = layeredRows(candidates, painters, elements.parent, rowStyles);
  for (const candidate of candidates) {
    if (layered.has(candidate.row)) {
      contrastUnknown++;
      continue;
    }
    contrast.element.push(candidate.row);
    contrast.ratio.push(candidate.ratio);
    contrast.font_px.push(candidate.fontPx);
    contrast.bold.push(candidate.bold);
  }
  const post = now() - postStarted;
  walkMs += post;
  maxSlice = Math.max(maxSlice, lastSliceMs + post);

  for (let i = 0; i < hitTargets.length; i++) {
    const target = hitTargets[i];
    hits.top[i] = target ? resolveIndex(target, indexOf, hits.element[i], elements.parent) : -1;
  }
  const allowed = marked.length ? resolveAllowed(marked, indexOf, elements) : null;

  const body: SnapshotBody = {
    schema_version: 2,
    route_template: options.routeTemplate,
    viewport,
    document: {
      width: r2(Math.max(view.scrollWidth, document.body?.scrollWidth ?? 0)),
      height: r2(Math.max(view.scrollHeight, document.body?.scrollHeight ?? 0)),
    },
    element_count: elements.parent.length,
    truncated,
    torn,
    legend: { position: POSITIONS, flags: FLAGS, hit_points: HIT_POINTS },
    dictionaries: { tag: tags.values, role: roles.values, test_id: testIds.values },
    elements,
    text_boxes: text,
    hit_tests: hits,
    ...(allowed ? { allow_overlap: allowed } : {}),
    // A table is absent when its measurement is off: absent means not measured, not none found.
    ...(maxContrast > 0 ? { contrast } : {}),
    ...(measureNames ? { unnamed_controls: unnamed } : {}),
  };
  return {
    body,
    walkMs,
    slices,
    maxSliceMs: maxSlice,
    sliceMs,
    sliceElements,
    contrastUnknown,
  };
}

/** Painters are bucketed by this many px of page height for the overlap search. */
const BAND_PX = 256;

/**
 * Candidates whose text box overlaps a positioned element (not an ancestor)
 * that paints its own layer: something other than the computed backdrop may
 * be behind the text, so its contrast is unknown. A painter is ignored when
 * the text's nearest opaque backdrop is positioned, comes later in the tree
 * and is at least as high in z-index: that backdrop paints over it (a dialog
 * over its scrim).
 */
function layeredRows(
  candidates: ContrastCandidate[],
  painters: Painter[],
  parents: number[],
  styles: CSSStyleDeclaration[],
): Set<number> {
  const out = new Set<number>();
  if (!painters.length || !candidates.length) return out;
  const bands = new Map<number, Painter[]>();
  for (const painter of painters) {
    if (!paintsOwnLayer(painter.element, styles[painter.row])) continue;
    const from = Math.floor(painter.box.top / BAND_PX);
    const to = Math.floor(painter.box.bottom / BAND_PX);
    for (let band = from; band <= to && band - from < 1024; band++) {
      const list = bands.get(band);
      if (list) list.push(painter);
      else bands.set(band, [painter]);
    }
  }
  const isAncestor = (ancestor: number, row: number): boolean => {
    for (let at = parents[row]; at >= 0; at = parents[at]) if (at === ancestor) return true;
    return false;
  };
  for (const candidate of candidates) {
    const b = candidate.box;
    const from = Math.floor(b.top / BAND_PX);
    const to = Math.floor(b.bottom / BAND_PX);
    search: for (let band = from; band <= to && band - from < 1024; band++) {
      for (const painter of bands.get(band) ?? []) {
        const p = painter.box;
        if (painter.row === candidate.row) continue;
        if (Math.min(p.right, b.right) - Math.max(p.left, b.left) <= 0.5) continue;
        if (Math.min(p.bottom, b.bottom) - Math.max(p.top, b.top) <= 0.5) continue;
        if (
          candidate.opaquePositioned &&
          painter.row < candidate.opaqueRow &&
          candidate.opaqueZ >= painter.z
        )
          continue;
        if (isAncestor(painter.row, candidate.row)) continue;
        out.add(candidate.row);
        break search;
      }
    }
  }
  return out;
}

/**
 * The host's answer when it gives one (anything outside the enum, or a throw,
 * is "unknown": the host said it knows, so the media query would be a guess);
 * otherwise the user's prefers-color-scheme.
 */
export function themeOf(host?: () => unknown): Theme {
  if (host) {
    try {
      const value = host();
      return (THEMES as readonly unknown[]).includes(value) ? (value as Theme) : "unknown";
    } catch {
      return "unknown";
    }
  }
  try {
    if (typeof matchMedia !== "function") return "unknown";
    if (matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    if (matchMedia("(prefers-color-scheme: light)").matches) return "light";
  } catch {
    // fall through
  }
  return "unknown";
}

function coarsePointer(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

function safeMatches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

/**
 * Sums direct text lengths and records the union box of the rendered text (from
 * a Range), plus its line count. Geometry only: the text itself is never read
 * beyond counting characters.
 */
function measureText(
  element: Element,
  index: number,
  text: SnapshotBody["text_boxes"],
): number {
  let length = 0;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const lineTops = new Set<number>();
  let inspected = 0;
  for (
    let node = element.firstChild;
    node && inspected < 64;
    node = node.nextSibling, inspected++
  ) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const data = (node as Text).data;
    const trimmed = data.trim().length;
    if (!trimmed) continue;
    length += trimmed;
    if (typeof document.createRange !== "function") continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    if (typeof range.getClientRects !== "function") continue;
    const rects = range.getClientRects();
    for (let i = 0; i < rects.length && i < 256; i++) {
      const rect = rects[i];
      if (rect.width <= 0 || rect.height <= 0) continue;
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
      lineTops.add(Math.round(rect.top));
    }
  }
  if (length && right > left && bottom > top) {
    text.element.push(index);
    text.x.push(r2(left));
    text.y.push(r2(top));
    text.width.push(r2(right - left));
    text.height.push(r2(bottom - top));
    text.lines.push(Math.min(lineTops.size, 1000));
  }
  return Math.min(length, 1_000_000);
}

/**
 * Probes the center and four inset points (25% in from each edge) with
 * elementFromPoint. A point is blocked when the topmost element there is neither
 * the control, inside it, nor a label for it.
 */
function hitTest(
  element: Element,
  rect: DOMRect,
  viewport: SnapshotBody["viewport"],
  index: number,
  hits: SnapshotBody["hit_tests"],
  targets: (Element | null)[],
): void {
  const scope = element.getRootNode() as Document | ShadowRoot;
  if (typeof scope.elementFromPoint !== "function") return;
  const points: [number, number][] = [
    [0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75],
  ];
  let tested = 0;
  let blocked = 0;
  let mask = 0;
  let top: Element | null = null;
  points.forEach(([fx, fy], bit) => {
    const x = rect.left + rect.width * fx;
    const y = rect.top + rect.height * fy;
    if (x < 0 || y < 0 || x >= viewport.client_width || y >= viewport.client_height) return;
    const hit = scope.elementFromPoint(x, y);
    if (!hit) return;
    tested++;
    if (
      hit === element ||
      element.contains(hit) ||
      (hit instanceof HTMLLabelElement && hit.control === element)
    )
      return;
    blocked++;
    mask |= 1 << bit;
    if (!top) top = hit;
  });
  hits.element.push(index);
  hits.tested.push(tested);
  hits.blocked.push(blocked);
  hits.points.push(mask);
  hits.top.push(-1);
  targets.push(top);
}

/** Index of the hit element, or its nearest recorded ancestor that does not contain the control. */
function resolveIndex(
  target: Element,
  indexOf: Map<Element, number>,
  control: number,
  parents: number[],
): number {
  let node: Node | null = target;
  for (let steps = 0; node && steps < 64; steps++) {
    if (node instanceof Element) {
      const found = indexOf.get(node);
      if (found !== undefined) {
        // An ancestor of the control is not "something on top of it".
        for (let at = parents[control]; at !== -1; at = parents[at])
          if (at === found) return -1;
        return found;
      }
    }
    node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null);
  }
  return -1;
}

/** The partner names in an element's allow marker, or null when it has none. */
function allowNames(element: Element): string[] | null {
  const value = element.getAttribute(ALLOW_OVERLAP_ATTRIBUTE);
  if (!value) return null;
  const names = value.trim().split(/\s+/).filter(Boolean).slice(0, ALLOW_TOKENS);
  return names.length ? names : null;
}

/**
 * Resolves allow markers to row pairs in the page: a name matches a recorded
 * element whose `data-interaction-id` or `data-testid` is that value (before
 * the test ID filter), and `*` matches any element. Only pairs whose boxes
 * intersect can overlap, so only those are kept. The names themselves never
 * reach the body.
 */
function resolveAllowed(
  marked: { row: number; names: string[] }[],
  indexOf: Map<Element, number>,
  elements: SnapshotBody["elements"],
): NonNullable<SnapshotBody["allow_overlap"]> {
  const result: NonNullable<SnapshotBody["allow_overlap"]> = { element: [], other: [] };
  const wanted = new Set<string>();
  for (const { names } of marked) for (const name of names) if (name !== "*") wanted.add(name);
  // Elements bearing each wanted name, bucketed by grid cell so a marker is only
  // compared with the elements near it (a list of 1,000 badges naming 1,000
  // "avatar"s is not a million comparisons).
  const byName = new Map<string, PlaceIndex>();
  if (wanted.size)
    for (const [element, row] of indexOf)
      for (const name of new Set([element.getAttribute("data-interaction-id"), element.getAttribute("data-testid")])) {
        if (!name || !wanted.has(name)) continue;
        let index = byName.get(name);
        if (!index) byName.set(name, (index = { cells: new Map(), wide: [], all: [] }));
        index.all.push(row);
        const span = cellsOf(elements, row);
        if (!span) index.wide.push(row);
        else for (const key of span) {
          const list = index.cells.get(key);
          if (list) list.push(row);
          else index.cells.set(key, [row]);
        }
      }
  const crosses = (a: number, b: number) =>
    Math.min(elements.x[a] + elements.width[a], elements.x[b] + elements.width[b]) > Math.max(elements.x[a], elements.x[b]) &&
    Math.min(elements.y[a] + elements.height[a], elements.y[b] + elements.height[b]) > Math.max(elements.y[a], elements.y[b]);
  for (const { row, names } of marked) {
    if (result.element.length >= MAX_ALLOWED_PAIRS) break;
    if (names.includes("*")) {
      result.element.push(row);
      result.other.push(-1);
      continue;
    }
    const span = cellsOf(elements, row);
    const partners = new Set<number>();
    const consider = (other: number) => {
      if (other !== row && crosses(row, other)) partners.add(other);
    };
    for (const name of names) {
      const index = byName.get(name);
      if (!index) continue;
      if (!span) index.all.forEach(consider);
      else {
        index.wide.forEach(consider);
        for (const key of span) index.cells.get(key)?.forEach(consider);
      }
    }
    for (const other of [...partners].sort((a, b) => a - b)) {
      if (result.element.length >= MAX_ALLOWED_PAIRS) break;
      result.element.push(row);
      result.other.push(other);
    }
  }
  return result;
}

interface PlaceIndex {
  /** Rows by grid cell. */
  cells: Map<string, number[]>;
  /** Rows spanning too many cells to bucket: compared with every marker. */
  wide: number[];
  all: number[];
}

/** Side of a grid cell, in CSS pixels. */
const CELL_PX = 256;
/** A box spanning more cells than this is not bucketed. */
const MAX_CELLS = 64;

/** Grid cells a row's box touches, or null when it spans too many to list. */
function cellsOf(elements: SnapshotBody["elements"], row: number): string[] | null {
  const x0 = Math.floor(elements.x[row] / CELL_PX);
  const y0 = Math.floor(elements.y[row] / CELL_PX);
  const x1 = Math.floor((elements.x[row] + elements.width[row]) / CELL_PX);
  const y1 = Math.floor((elements.y[row] + elements.height[row]) / CELL_PX);
  if (!(x1 >= x0 && y1 >= y0) || (x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS) return null;
  const keys: string[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push(`${x},${y}`);
  return keys;
}

/**
 * Serializes the body, dropping trailing elements (DFS preorder keeps parents
 * valid) until it fits in `maxBytes`.
 */
export function encodeSnapshot(
  body: SnapshotBody,
  maxBytes: number,
): { body: SnapshotBody; serialized: string; bytes: number } {
  let serialized = JSON.stringify(body);
  let bytes = new TextEncoder().encode(serialized).byteLength;
  for (let attempt = 0; attempt < 6 && bytes > maxBytes; attempt++) {
    const keep = Math.floor(body.element_count * (maxBytes / bytes) * 0.9);
    body = truncateBody(body, keep);
    serialized = JSON.stringify(body);
    bytes = new TextEncoder().encode(serialized).byteLength;
  }
  if (bytes > maxBytes) {
    body = truncateBody(body, 0);
    serialized = JSON.stringify(body);
    bytes = new TextEncoder().encode(serialized).byteLength;
  }
  return { body, serialized, bytes };
}

function truncateBody(body: SnapshotBody, keep: number): SnapshotBody {
  const e = body.elements;
  const elements = Object.fromEntries(
    Object.entries(e).map(([key, column]) => [key, column.slice(0, keep)]),
  ) as SnapshotBody["elements"];
  const text = body.text_boxes;
  const textKeep = text.element.findIndex((index) => index >= keep);
  const t = textKeep === -1 ? text.element.length : textKeep;
  const hits = body.hit_tests;
  const contrast = body.contrast;
  const c = contrast ? before(contrast.element, keep) : 0;
  const unnamed = body.unnamed_controls;
  const u = unnamed ? before(unnamed.element, keep) : 0;
  const hitKeep = hits.element.findIndex((index) => index >= keep);
  const h = hitKeep === -1 ? hits.element.length : hitKeep;
  const allow = body.allow_overlap;
  const allowKeep = allow ? allow.element.map((row, i) => row < keep && allow.other[i] < keep) : [];
  return {
    ...body,
    element_count: keep,
    truncated: true,
    elements,
    text_boxes: {
      element: text.element.slice(0, t),
      x: text.x.slice(0, t),
      y: text.y.slice(0, t),
      width: text.width.slice(0, t),
      height: text.height.slice(0, t),
      lines: text.lines.slice(0, t),
    },
    hit_tests: {
      element: hits.element.slice(0, h),
      tested: hits.tested.slice(0, h),
      blocked: hits.blocked.slice(0, h),
      points: hits.points.slice(0, h),
      top: hits.top.slice(0, h).map((index) => (index >= keep ? -1 : index)),
    },
    ...(allow
      ? {
          allow_overlap: {
            element: allow.element.filter((_, i) => allowKeep[i]),
            other: allow.other.filter((_, i) => allowKeep[i]),
          },
        }
      : {}),
    ...(contrast
      ? {
          contrast: {
            element: contrast.element.slice(0, c),
            ratio: contrast.ratio.slice(0, c),
            font_px: contrast.font_px.slice(0, c),
            bold: contrast.bold.slice(0, c),
          },
        }
      : {}),
    ...(unnamed
      ? {
          unnamed_controls: {
            element: unnamed.element.slice(0, u),
            has_title: unnamed.has_title.slice(0, u),
            icon_only: unnamed.icon_only.slice(0, u),
          },
        }
      : {}),
  };
}

/** Entries of an ascending row column that refer to rows below `keep`. */
function before(rows: number[], keep: number): number {
  const at = rows.findIndex((row) => row >= keep);
  return at === -1 ? rows.length : at;
}

/**
 * Content the browser skips rendering (the body of a closed <details>, other
 * content-visibility: hidden subtrees) still has layout boxes; checkVisibility
 * knows it is not shown. Where the API is missing, assume rendered.
 */
function rendered(element: Element): boolean {
  try {
    return typeof element.checkVisibility !== "function" || element.checkVisibility();
  } catch {
    return true;
  }
}

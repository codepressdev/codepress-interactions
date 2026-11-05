/**
 * Screen snapshots: a time-sliced walk of the rendered element tree that records
 * geometry and layout facts in a columnar body. Never records text, values,
 * attributes other than role/test IDs, URLs or HTML.
 */
import { FLAGS, HIT_POINTS, POSITIONS, THEMES, type SnapshotBody, type Theme } from "./format";
import type { SnapshotTrigger } from "./types";
import { now, safeIdentifier } from "./util";

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
}

export interface WalkResult {
  body: SnapshotBody;
  walkMs: number;
  slices: number;
  maxSliceMs: number;
  sliceMs: number[];
  sliceElements: number[];
}

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
  const hitTargets: (Element | null)[] = [];
  const indexOf = new Map<Element, number>();

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
    { next: root, list: null, index: 0, parent: -1, clip: null, opacity: 1 },
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
    const opacity = frame.opacity * (parseFloat(style.opacity) || 0);
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

    elements.parent.push(frame.parent);
    elements.tag.push(tags.get(tagOf(element)));
    elements.role.push(roles.get(role));
    elements.test_id.push(
      testIds.get(
        safeIdentifier(element.getAttribute("data-interaction-id")) ??
          safeIdentifier(element.getAttribute("data-testid")),
      ),
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
    });
  };

  const sliceMs: number[] = [];
  const sliceElements: number[] = [];
  let walkMs = 0;
  let maxSlice = 0;
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

  for (let i = 0; i < hitTargets.length; i++) {
    const target = hitTargets[i];
    hits.top[i] = target ? resolveIndex(target, indexOf, hits.element[i], elements.parent) : -1;
  }

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
  };
  return {
    body,
    walkMs,
    slices,
    maxSliceMs: maxSlice,
    sliceMs,
    sliceElements,
  };
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
  const hitKeep = hits.element.findIndex((index) => index >= keep);
  const h = hitKeep === -1 ? hits.element.length : hitKeep;
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
  };
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

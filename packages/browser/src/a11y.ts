/**
 * Accessibility measurements taken during the snapshot walk: the backdrop
 * behind each element (for text contrast) and whether a control has an
 * accessible name. Colours, labels and text are read here, in the page, and
 * only numbers and booleans are returned to the walk.
 */
import { BLACK, WHITE, composite, luminance, luminanceOf, parseColor, type Rgb } from "./color";

/** What is painted behind an element's content, inherited down the walk. */
export interface Backdrop {
  /** The opaque colour behind the content, or null when unknown (an image or gradient). */
  color: Rgb | null;
  /** Relative luminance of `color` (0 when unknown). */
  luminance: number;
  /** Opacity below 1 (or, above the walk's root, a filter or blend mode) at or above this element: every colour below is unknown. */
  tainted: boolean;
  /** Where `color` holds: the intersection of the boxes of the ancestors that painted it; null for the whole canvas. */
  clip: Box | null;
  /** Row of the nearest element at or above this one that painted an opaque colour, or -1 (the canvas). */
  opaqueRow: number;
  /** That element is positioned. */
  opaquePositioned: boolean;
  /** That element's z-index (0 for auto). */
  opaqueZ: number;
  /** A disabled control (or aria-disabled) at or above this element. */
  disabled: boolean;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const TRANSPARENT = "rgba(0, 0, 0, 0)";
const TRANSPARENT_RGBA = [0, 0, 0, 0] as const;
const DISABLABLE = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA", "FIELDSET", "OPTGROUP", "OPTION"]);

const intersectBox = (a: Box | null, b: Box): Box =>
  a
    ? {
        left: Math.max(a.left, b.left),
        top: Math.max(a.top, b.top),
        right: Math.min(a.right, b.right),
        bottom: Math.min(a.bottom, b.bottom),
      }
    : b;

/**
 * The canvas colour: white, or black when the root's used color-scheme is dark
 * (`color-scheme` on the root or a color-scheme meta tag).
 */
export function canvasColor(): Rgb {
  try {
    const own = getComputedStyle(document.documentElement).colorScheme ?? "";
    const scheme =
      own && own !== "normal" ? own : (document.querySelector('meta[name="color-scheme"]')?.getAttribute("content") ?? "");
    if (!/\bdark\b/.test(scheme)) return WHITE;
    if (!/\blight\b/.test(scheme)) return BLACK;
    return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? BLACK : WHITE;
  } catch {
    return WHITE;
  }
}

/** Stands in for the backdrop when contrast is off: nothing is read. */
export const UNMEASURED: Backdrop = {
  color: null,
  luminance: 0,
  tainted: true,
  clip: null,
  opaqueRow: -1,
  opaquePositioned: false,
  opaqueZ: 0,
  disabled: false,
};

/** The backdrop at the top of the page: the canvas, painted over by the root's ancestors when the walk starts below <html>. */
export function rootBackdrop(root: Element): Backdrop {
  let backdrop: Backdrop = {
    color: WHITE,
    luminance: 1,
    tainted: false,
    clip: null,
    opaqueRow: -1,
    opaquePositioned: false,
    opaqueZ: 0,
    disabled: false,
  };
  const canvas = canvasColor();
  if (canvas === BLACK) backdrop = { ...backdrop, color: BLACK, luminance: 0 };
  const chain: Element[] = [];
  for (let at = root.parentElement; at; at = at.parentElement) chain.unshift(at);
  for (const element of chain) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (blends(style)) backdrop = { ...backdrop, color: null, luminance: 0, tainted: true };
    backdrop = paint(element, style, rect, backdrop, -1, 0, parseFloat(style.opacity) || 0, style.position !== "static");
  }
  return backdrop;
}

/**
 * The backdrop for an element's own content and its children: its background
 * composited over the one it sits on. `<html>` and `<body>` paint the whole
 * canvas, so they never narrow where the colour holds.
 */
export function paint(
  element: Element,
  style: CSSStyleDeclaration,
  box: Box,
  below: Backdrop,
  row: number,
  zIndex: number,
  /** Computed opacity and position, already read by the walk. */
  opacity: number,
  positioned: boolean,
): Backdrop {
  const disabled =
    below.disabled ||
    (DISABLABLE.has(element.tagName) && (element as HTMLButtonElement).disabled === true) ||
    element.getAttribute("aria-disabled") === "true";
  // Most elements paint nothing: they share the backdrop below (no allocation).
  if (below.tainted) return disabled === below.disabled ? below : { ...below, disabled };
  // Filters and blend modes are checked later, only for text that measures low (see `blends`).
  if (opacity < 1)
    return { ...below, color: null, luminance: 0, tainted: true, disabled };
  const canvas = element.tagName === "HTML" || element.tagName === "BODY";
  const image = style.backgroundImage;
  if (image && image !== "none")
    return { ...below, color: null, luminance: 0, clip: canvas ? below.clip : intersectBox(below.clip, box), disabled };
  const value = style.backgroundColor;
  const parsed = value && value !== TRANSPARENT ? parseColor(value) : TRANSPARENT_RGBA;
  if (!parsed) return { ...below, color: null, luminance: 0, clip: canvas ? below.clip : intersectBox(below.clip, box), disabled };
  if (parsed[3] <= 0) return disabled === below.disabled ? below : { ...below, disabled };
  const clip = canvas ? below.clip : intersectBox(below.clip, box);
  if (parsed[3] >= 1)
    return {
      color: [parsed[0], parsed[1], parsed[2]],
      luminance: luminanceOf(value, parsed),
      tainted: false,
      clip,
      opaqueRow: row,
      opaquePositioned: positioned,
      opaqueZ: zIndex,
      disabled,
    };
  const color = below.color ? composite(parsed, below.color) : null;
  return { ...below, color, luminance: color ? luminance(color) : 0, clip, disabled };
}

/** A filter or blend mode changes the colours painted under it. */
export const blends = (style: CSSStyleDeclaration): boolean =>
  style.filter !== "none" || (style.mixBlendMode !== "normal" && !!style.mixBlendMode);

/** Paints something of its own: a background colour or image, or replaced content (image, video, canvas, frame). */
export function paintsOwnLayer(element: Element, style: CSSStyleDeclaration): boolean {
  switch (element.tagName) {
    case "IMG":
    case "VIDEO":
    case "CANVAS":
    case "PICTURE":
    case "IFRAME":
    case "EMBED":
    case "OBJECT":
    case "svg":
    case "SVG":
      return true;
  }
  const image = style.backgroundImage;
  if (image && image !== "none") return true;
  const color = style.backgroundColor;
  return !!color && color !== TRANSPARENT && parseColor(color)?.[3] !== 0;
}

// ---- Accessible names -------------------------------------------------------

/** Roles whose name can come from their content (WAI-ARIA "name from content"). */
const NAME_FROM_CONTENT = new Set([
  "button", "link", "checkbox", "radio", "switch", "tab", "menuitem",
  "menuitemcheckbox", "menuitemradio", "option", "treeitem",
]);
const FIELDS = new Set(["INPUT", "SELECT", "TEXTAREA"]);

/** The role takes its name from content: a control of this role with text of its own is named. */
export const namedFromContent = (role: string): boolean => NAME_FROM_CONTENT.has(role);
/** Descendants inspected for a name before giving up and assuming one exists. */
const NAME_BUDGET = 256;

const filled = (value: string | null | undefined): boolean => !!value && value.trim().length > 0;

/**
 * Whether `node`'s content gives a name: non-blank text, an aria-label, an
 * image's alt or an SVG title, skipping `skip` and anything aria-hidden.
 * Returns true when the budget runs out (unknown is not reported as unnamed).
 */
function contentNames(node: Node, skip: Element | null, budget: { left: number }): boolean {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (--budget.left < 0) return true;
    if (child.nodeType === 3) {
      if (filled((child as Text).data)) return true;
      continue;
    }
    if (child.nodeType !== 1 || child === skip) continue;
    const element = child as Element;
    if (element.getAttribute("aria-hidden") === "true") continue;
    if (filled(element.getAttribute("aria-label"))) return true;
    const tag = element.tagName;
    if (tag === "IMG" || tag === "AREA") {
      if (filled(element.getAttribute("alt"))) return true;
      continue;
    }
    if (tag === "svg" || tag === "SVG") {
      for (let part = element.firstElementChild; part; part = part.nextElementSibling)
        if (part.localName === "title" && filled(part.textContent)) return true;
      continue;
    }
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE") continue;
    if (contentNames(element, skip, budget)) return true;
  }
  return false;
}

export interface Unnamed {
  hasTitle: boolean;
  iconOnly: boolean;
}

/**
 * Null when the control has an accessible name from any of: aria-labelledby
 * targets, aria-label, an associated <label>, alt (image inputs), title,
 * placeholder, its own content (for roles named from content) or the value of
 * a button-type input (submit and reset have a default name). Otherwise what is
 * known about the unnamed control. Text is read here and never returned.
 */
export function unnamedControl(element: Element, role: string): Unnamed | null {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const scope = element.getRootNode() as Document | ShadowRoot;
    for (const id of labelledBy.trim().split(/\s+/)) {
      const target = typeof scope.getElementById === "function" ? scope.getElementById(id) : null;
      if (target && (filled(target.getAttribute("aria-label")) || contentNames(target, null, { left: NAME_BUDGET })))
        return null;
    }
  }
  if (filled(element.getAttribute("aria-label")) || filled(element.getAttribute("title"))) return null;
  const tag = element.tagName;
  let iconOnly = false;
  if (tag === "INPUT") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    if (type === "image") {
      if (filled(element.getAttribute("alt"))) return null;
      iconOnly = true;
    } else if (type === "submit" || type === "reset") {
      // An absent value gives the browser's default name ("Submit", "Reset").
      if (!element.hasAttribute("value") || filled(element.getAttribute("value"))) return null;
    } else if (type === "button") {
      if (filled(element.getAttribute("value"))) return null;
    }
  }
  if (FIELDS.has(tag) || tag === "BUTTON") {
    if (filled(element.getAttribute("placeholder")) && tag !== "BUTTON" && tag !== "SELECT") return null;
    // `labels` searches the tree for label[for]; without an id only a wrapping label can apply.
    if (element.id) {
      const labels = (element as HTMLInputElement).labels;
      if (labels)
        for (let i = 0; i < labels.length; i++) if (contentNames(labels[i], element, { left: NAME_BUDGET })) return null;
    } else {
      const label = element.closest("label");
      if (label && !label.hasAttribute("for") && contentNames(label, element, { left: NAME_BUDGET })) return null;
    }
  }
  if (!FIELDS.has(tag) && NAME_FROM_CONTENT.has(role)) {
    if (contentNames(element, null, { left: NAME_BUDGET })) return null;
    iconOnly = !!element.querySelector("svg, img, picture");
  }
  return { hasTitle: element.hasAttribute("title"), iconOnly };
}

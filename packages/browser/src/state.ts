/**
 * UI state (1.5.0): what an element claims (current, selected, expanded…),
 * read from ARIA and native state as a bitmask. Attribute values and hrefs are
 * read in the page to work out the bits and never leave it.
 */
import { STATE } from "./format";

/** Most rows in a snapshot's `state` table. */
export const MAX_STATE_ROWS = 10_000;

/** Attributes whose changes change state bits. */
export const STATE_ATTRIBUTES = [
  "aria-current", "aria-selected", "aria-expanded", "aria-pressed", "aria-checked",
  "aria-disabled", "aria-invalid", "aria-busy", "open", "disabled", "checked",
] as const;

/**
 * Elements that may have a state bit other than `links_here` right now: the
 * attributes, plus native state by pseudo-class, so plain buttons and inputs
 * are not visited. Pseudo-classes a browser lacks are dropped.
 */
const STATE_ATTRIBUTE_SELECTOR = STATE_ATTRIBUTES.map((name) => `[${name}]`).join(",");
const STATE_PSEUDO = [":checked", ":disabled", ":user-invalid", ":popover-open"];
let statefulSelector: string | null = null;
export function stateful(): string {
  if (statefulSelector) return statefulSelector;
  const supported = STATE_PSEUDO.filter((pseudo) => {
    try {
      document.createElement("div").matches(pseudo);
      return true;
    } catch {
      return false;
    }
  });
  return (statefulSelector = [STATE_ATTRIBUTE_SELECTOR, ...supported].join(","));
}

/** Tags whose state can come from properties or pseudo-classes rather than attributes. */
const NATIVE = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON", "FIELDSET", "OPTION", "OPTGROUP", "A"]);

const MARKED = STATE.current | STATE.selected;

/** The bit an attribute's value turns on, for revert tracking; 0 when the attribute is off at this value. */
export function attributeOn(name: string, value: string | null): boolean {
  if (value === null) return false;
  const v = value.trim().toLowerCase();
  switch (name) {
    case "aria-current":
    case "aria-invalid":
      return v !== "false";
    case "open":
    case "disabled":
    case "checked":
      return true;
    default:
      return v === "true";
  }
}

/** A pathname without its trailing slash, except the root. */
export const normalizePath = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.replace(/\/+$/, "") || "/" : path;

/** The page's own path, normalized: what `links_here` compares links with. */
export function herePath(): { origin: string; path: string } | null {
  try {
    return { origin: location.origin, path: normalizePath(location.pathname) };
  } catch {
    return null;
  }
}

function safeMatches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

/** A same-origin `<a href>` whose normalized path is the page's. */
export function linksHere(element: Element, here: { origin: string; path: string } | null): boolean {
  if (!here || element.tagName !== "A" || !element.hasAttribute("href")) return false;
  const link = element as HTMLAnchorElement;
  try {
    return link.origin === here.origin && normalizePath(link.pathname) === here.path;
  } catch {
    return false;
  }
}

/**
 * The element's state bits. `popoverOpen` is passed when already known (the
 * snapshot walk works it out for its own flag).
 */
export function stateBits(
  element: Element,
  here: { origin: string; path: string } | null,
  popoverOpen?: boolean,
  /** Reads an attribute; given to work out bits from earlier attribute values. */
  read?: (name: string) => string | null,
): number {
  const tag = element.tagName;
  // Most elements have no attributes and no native state: nothing to read.
  if (!read && !element.hasAttributes() && !NATIVE.has(tag)) return 0;
  const attr = read ?? ((name: string) => element.getAttribute(name));
  let bits = 0;
  if (attributeOn("aria-current", attr("aria-current"))) bits |= STATE.current;
  if (attributeOn("aria-selected", attr("aria-selected"))) bits |= STATE.selected;
  if (attributeOn("aria-expanded", attr("aria-expanded"))) bits |= STATE.expanded;
  if (attributeOn("aria-pressed", attr("aria-pressed"))) bits |= STATE.pressed;
  if (
    attributeOn("aria-checked", attr("aria-checked")) ||
    (tag === "INPUT" && (element as HTMLInputElement).checked &&
      /^(checkbox|radio)$/i.test((element as HTMLInputElement).type))
  )
    bits |= STATE.checked;
  if (attributeOn("aria-disabled", attr("aria-disabled")) || (NATIVE.has(tag) && safeMatches(element, ":disabled")))
    bits |= STATE.disabled;
  if (attributeOn("aria-invalid", attr("aria-invalid")) || (NATIVE.has(tag) && safeMatches(element, ":user-invalid")))
    bits |= STATE.invalid;
  if (attributeOn("aria-busy", attr("aria-busy"))) bits |= STATE.busy;
  if (
    ((tag === "DETAILS" || tag === "DIALOG") && attr("open") !== null) ||
    (popoverOpen ?? (element.hasAttribute("popover") && safeMatches(element, ":popover-open")))
  )
    bits |= STATE.open;
  if (tag === "A" && linksHere(element, here)) bits |= STATE.links_here;
  return bits;
}

/** Where a click's control sits: the group whose current or selected item it may move. */
export const GROUP =
  'nav,[role="navigation"],[role="tablist"],[role="menu"],[role="menubar"],[role="listbox"],[role="radiogroup"],' +
  'header,footer,aside,main,[role="banner"],[role="contentinfo"],[role="complementary"],[role="main"],[role="region"],[role="search"]';
/** Groups that hold items directly (tabs, menu items, options): nearer than a landmark. */
const ITEM_GROUP = 'nav,[role="navigation"],[role="tablist"],[role="menu"],[role="menubar"],[role="listbox"],[role="radiogroup"]';

/** The control's nearest item group (nav, tablist, menu, listbox, radiogroup), else its nearest landmark. */
export function groupOf(control: Element): Element | null {
  try {
    return control.closest(ITEM_GROUP) ?? control.closest(GROUP);
  } catch {
    return null;
  }
}

/** Elements marked current or selected inside `group`. */
export function markedIn(group: Element): number {
  let count = 0;
  const candidates = group.querySelectorAll('[aria-current],[aria-selected]');
  for (let i = 0; i < candidates.length && i < 10_000; i++)
    if (stateBits(candidates[i], null) & MARKED) count++;
  return count;
}

/**
 * Same-origin links under `root` that point at the page's path, and how many
 * of them are marked: the link, or its parent, is current or selected.
 */
export function linksHereIn(root: Element): { links: number; marked: number } {
  const here = herePath();
  let links = 0;
  let marked = 0;
  if (!here) return { links, marked };
  const anchors = root.querySelectorAll("a[href]");
  for (let i = 0; i < anchors.length && i < 10_000; i++) {
    const link = anchors[i];
    if (!linksHere(link, here)) continue;
    links++;
    const parent = link.parentElement;
    if (stateBits(link, null) & MARKED || (parent && stateBits(parent, null) & MARKED)) marked++;
  }
  return { links, marked };
}

/** `node` and the elements under it that may have state, at most `limit`. */
export function statefulIn(node: Element, limit: number): Element[] {
  const out: Element[] = [];
  try {
    if (node.matches(stateful())) out.push(node);
    const found = node.querySelectorAll(stateful());
    for (let i = 0; i < found.length && out.length < limit; i++) out.push(found[i]);
  } catch {
    /* Unreadable: nothing. */
  }
  return out;
}

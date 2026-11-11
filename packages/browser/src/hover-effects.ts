/**
 * Hover and keyboard-focus follow-through: what happened after a mouse or pen
 * pointer rested on a control, or keyboard focus reached one, until the page
 * went quiet. Built on the same follow-through windows as clicks (follow.ts).
 *
 * Only booleans and durations leave this module. Computed styles compared for
 * the focus indicator check stay in the page; only whether they differed is
 * reported.
 */
import { Follower, isOverlay, observeOptions, scanAdded, type FollowWindow } from "./follow";
import { INTERACTIVE } from "./snapshot";
import type { HoverKind, HoverSettledData } from "./types";
import { clampMs, now } from "./util";

/** Longest a hover or focus is followed; a page that keeps changing is reported as it was then. */
const HOVER_TIMEOUT_MS = 5000;
/** Ancestors searched for the hovered control, and for a React hover handler. */
const CONTROL_DEPTH = 6;
const HANDLER_DEPTH = 3;
const REACT_HANDLERS = ["onMouseEnter", "onMouseOver", "onPointerEnter", "onPointerOver"];
/** Records inspected per mutation callback. */
const RECORD_BUDGET = 64;
/** Added subtrees remembered per window, to attribute class, style and motion inside them. */
const MAX_ADDED = 16;
/** Rate-limit keys remembered; past this the oldest is forgotten. */
const MAX_KEYS = 500;
/** Style rules visited when collecting `:hover` selectors, and selectors kept. */
const MAX_RULES = 20000;
const MAX_HOVER_SELECTORS = 300;
const HOVER_RULES_TTL_MS = 10000;
/** Computed properties that show a focus indicator. Compared in the page, never sent. */
const INDICATOR_PROPERTIES = [
  "outline-style", "outline-width", "outline-color", "box-shadow",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "background-color",
];
/** Ancestors compared with the focused element: a wrapper styled with `:focus-within`. */
const INDICATOR_WRAPPERS = 2;

export interface HoverHost {
  root: Element;
  dwellMs: number;
  settleMs: number;
  /** At most one record per control and route in this many ms. */
  recordIntervalMs: number;
  maxPerMinute: number;
  controlId(element: Element): string;
  routeTemplate(): string | null;
  /** Snapshot after settling when an overlay opened; resolves with its hash, or null when skipped. */
  snapshot(trigger: "hover" | "focus"): Promise<string | null>;
  emit(data: HoverSettledData): void;
  /** A hover or focus that changed nothing observable. */
  silent(kind: HoverKind): void;
  /** Keyboard focus showed no visible change on the element or its wrappers. */
  noFocusIndicator(controlId: string, routeTemplate: string | null, wrappers: number): void;
  /**
   * Subscribes to animation and transition starts (the runtime passes the
   * motion tracker's, so the page has one set of motion listeners); returns
   * the unsubscribe. Without it, starts are not seen.
   */
  onMotion?(listener: (target: Element, kind: "transition" | "animation") => void): () => void;
}

interface Effects {
  transition: boolean;
  animation: boolean;
  nodes: boolean;
  overlay: boolean;
  expanded: boolean;
  classes: boolean;
  style: boolean;
}

interface HoverWindow extends FollowWindow {
  kind: HoverKind;
  control: Element;
  controlId: string;
  route: string | null;
  key: string;
  /** The dwell passed (always true for focus): the window is reported when it ends. */
  committed: boolean;
  dwellMs: number;
  /** When the last effect happened, or null when none did. */
  effectAt: number | null;
  effects: Effects;
  added: Element[];
  hasHandler: boolean | null;
  dwell?: ReturnType<typeof setTimeout>;
}

/** The focused element's indicator styles while focused, compared again once focus leaves. */
interface FocusCheck {
  element: Element;
  controlId: string;
  route: string | null;
  focused: string[];
  wrappers: number;
  /** A transition or animation ran on the element or a wrapper while focused: it is the indicator. */
  motion: boolean;
}

type EndReason = "input" | "page_hidden";

export class HoverEffects {
  private pointer: Follower<HoverWindow, EndReason>;
  private focus: Follower<HoverWindow, EndReason>;
  private removals: (() => void)[] = [];
  private active = false;
  /** Windows that settled with an overlay and wait for their snapshot. */
  private awaiting = new Set<() => void>();
  /** Rate limits: last record per control and route, and record times in the last minute. */
  private lastRecord = new Map<string, number>();
  private minute: number[] = [];
  private hoverRules = new HoverRules();
  private focusCheck: FocusCheck | null = null;
  /** Where the last mouse or pen pointerover happened. */
  private lastOver: { x: number; y: number } | null = null;

  constructor(private host: HoverHost) {
    const make = () =>
      new Follower<HoverWindow, EndReason>({
        root: host.root,
        observe: observeOptions(["style"]),
        settleMs: host.settleMs,
        timeoutMs: HOVER_TIMEOUT_MS,
        records: (window, records) => this.records(window, records),
        ended: (window, reason) => this.finish(window, reason),
      });
    this.pointer = make();
    this.focus = make();
  }

  start(): void {
    this.active = true;
    const listen = (type: string, listener: (event: Event) => void, target: EventTarget = document) => {
      const guarded = (event: Event) => {
        try {
          listener(event);
        } catch {
          /* Never affect the page. */
        }
      };
      target.addEventListener(type, guarded, { capture: true, passive: true });
      this.removals.push(() => target.removeEventListener(type, guarded, { capture: true }));
    };
    listen("pointerover", (event) => this.onPointerOver(event as PointerEvent));
    listen("pointerout", (event) => this.onPointerOut(event as PointerEvent));
    // `focus` (captured at the document) runs before the page's own focus and
    // focusin handlers, so what they do is inside the window.
    listen("focus", (event) => this.onFocusIn(event));
    listen("focusout", (event) => this.onFocusOut(event));
    // A press or key ends what a hover or focus was doing: what follows belongs to that input.
    for (const type of ["pointerdown", "keydown"])
      listen(type, () => {
        const hover = this.pointer.current;
        if (hover && !hover.committed) this.pointer.cancel();
        else if (hover) this.pointer.end(hover, "input");
        const focus = this.focus.current;
        // Tab moves focus after its keydown: the next focusin opens the next window.
        if (focus) this.focus.end(focus, "input");
      });
    const unsubscribe = this.host.onMotion?.((target, kind) => {
      try {
        this.motion(target, kind);
      } catch {
        /* Never affect the page. */
      }
    });
    if (unsubscribe) this.removals.push(unsubscribe);
    listen("toggle", (event) => {
      if ((event as Event & { newState?: string }).newState !== "open") return;
      for (const window of this.open()) this.mark(window, "overlay");
    });
  }

  /** The page is going away: report open windows now, synchronously. */
  pageHidden(): void {
    for (const follower of [this.pointer, this.focus]) {
      const window = follower.current;
      if (!window) continue;
      if (window.committed) follower.end(window, "page_hidden");
      else follower.cancel();
    }
    for (const report of this.awaiting) report();
  }

  stop(): void {
    this.active = false;
    this.awaiting.clear();
    this.pointer.stop();
    this.focus.stop();
    this.focusCheck = null;
    for (const remove of this.removals) remove();
    this.removals = [];
  }

  // ---- Triggers ----------------------------------------------------------

  private onPointerOver(event: PointerEvent): void {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    // A pointerover where the last one was is the page changing under a still
    // pointer (a tooltip appearing under it, an element replaced), not the user
    // moving to something new. Following it could also loop: reading the
    // control's ID runs the testId hook, which may replace the element under
    // the pointer and cause the next pointerover.
    const last = this.lastOver;
    this.lastOver = { x: event.clientX, y: event.clientY };
    if (last && last.x === event.clientX && last.y === event.clientY) return;
    const current = this.pointer.current;
    // Moving between the parts of one control is still the same hover.
    if (current && (current.control === target || current.control.contains(target))) return;
    const control = this.candidate(target);
    // Left before the dwell: nothing is recorded.
    if (current && !current.committed) this.pointer.cancel();
    if (!control) return;
    const window = this.begin("pointer", control);
    if (!window) return;
    this.pointer.open(window, false);
    window.dwell = setTimeout(() => {
      if (this.pointer.current !== window) return;
      window.committed = true;
      window.dwellMs = now() - window.t0;
      // Settles once quiet after the dwell, or after its last effect if later.
      this.pointer.scheduleQuiet(window);
    }, this.host.dwellMs);
  }

  private onPointerOut(event: PointerEvent): void {
    const current = this.pointer.current;
    if (!current || current.committed) return;
    const next = event.relatedTarget;
    if (next instanceof Node && (current.control === next || current.control.contains(next))) return;
    this.pointer.cancel();
  }

  private onFocusIn(event: Event): void {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !focusVisible(target)) return;
    if (!this.host.root.contains(target) || target.closest("[data-interactions-exclude]")) return;
    const controlId = this.host.controlId(target);
    const route = this.host.routeTemplate();
    const focused = indicatorStyles(target);
    this.focusCheck = {
      element: target,
      controlId,
      route,
      focused,
      wrappers: wrappersOf(target).length,
      // Reading the styles started any focus transition: computed values show its start, so it is the indicator.
      motion: animating(target),
    };
    const window = this.begin("focus", target, controlId, route);
    if (!window) return;
    window.committed = true;
    this.focus.open(window);
  }

  private onFocusOut(event: Event): void {
    const check = this.focusCheck;
    if (!check || event.target !== check.element) return;
    this.focusCheck = null;
    // Compared once focus has really left (the next element may take it in the same task).
    setTimeout(() => {
      if (!this.active || check.motion || !check.element.isConnected) return;
      if (check.element === document.activeElement) return;
      const unfocused = indicatorStyles(check.element);
      if (animating(check.element)) return;
      if (unfocused.length !== check.focused.length) return;
      if (unfocused.every((value, index) => value === check.focused[index]))
        this.host.noFocusIndicator(check.controlId, check.route, check.wrappers);
    }, 0);
  }

  /** A new window when the rate limits allow one, else null. */
  private begin(kind: HoverKind, control: Element, controlId?: string, route?: string | null): HoverWindow | null {
    if (!this.active) return null;
    controlId ??= this.host.controlId(control);
    route = route === undefined ? this.host.routeTemplate() : route;
    const key = `${kind}\u0000${route ?? ""}\u0000${controlId}`;
    if (!this.admit(key, now())) return null;
    const t0 = now();
    let hasHandler: boolean | null = null;
    try {
      hasHandler = reactHoverHandler(control);
    } catch {
      hasHandler = null;
    }
    return {
      kind,
      control,
      controlId,
      route,
      key,
      committed: false,
      dwellMs: 0,
      t0,
      lastEffect: t0,
      inflight: 0,
      effectAt: null,
      effects: {
        transition: false, animation: false, nodes: false, overlay: false,
        expanded: false, classes: false, style: false,
      },
      added: [],
      hasHandler,
    };
  }

  /**
   * The control a hover on `target` is about: the nearest element (up to six
   * levels) that is interactive, matches a `:hover` style rule or has a React
   * hover handler, else the outermost one that sets `cursor: pointer`.
   */
  private candidate(target: Element): Element | null {
    const root = this.host.root;
    const body = document.body;
    let found: Element | null = null;
    let node: Element | null = target;
    for (let depth = 0; node && depth < CONTROL_DEPTH; node = node.parentElement, depth++) {
      if (node === body || node === document.documentElement || !root.contains(node)) break;
      if (node.matches(INTERACTIVE) || this.hoverRules.matches(node) || reactHoverHandler(node, 0) === true) {
        found = node;
        break;
      }
    }
    if (!found) {
      // cursor is inherited: the element that sets it is the last one up the chain that has it.
      node = target;
      for (let depth = 0; node && depth < CONTROL_DEPTH; node = node.parentElement, depth++) {
        if (node === body || node === document.documentElement || !root.contains(node)) break;
        if (getComputedStyle(node).cursor !== "pointer") break;
        found = node;
      }
    }
    if (!found || found.closest("[data-interactions-exclude]")) return null;
    return found;
  }

  // ---- Effects -----------------------------------------------------------

  private open(): HoverWindow[] {
    const out: HoverWindow[] = [];
    if (this.pointer.current) out.push(this.pointer.current);
    if (this.focus.current) out.push(this.focus.current);
    return out;
  }

  /** `node` belongs to what `window` is about: the control, inside or around it, or in what appeared. */
  private related(window: HoverWindow, node: Node): boolean {
    if (node === window.control || window.control.contains(node) || node.contains(window.control)) return true;
    for (const added of window.added) if (added.contains(node)) return true;
    return node instanceof Element && !!node.closest('[role="tooltip"],[role="menu"],[role="listbox"],[popover]');
  }

  private mark(window: HoverWindow, effect: keyof Effects): void {
    window.effects[effect] = true;
    const at = now();
    window.effectAt = at;
    (window.kind === "pointer" ? this.pointer : this.focus).effect(window, at);
  }

  private motion(target: Element, kind: "transition" | "animation"): void {
    const check = this.focusCheck;
    if (check && (target === check.element || target.contains(check.element))) check.motion = true;
    for (const window of this.open()) if (this.related(window, target)) this.mark(window, kind);
  }

  private records(window: HoverWindow, records: MutationRecord[]): void {
    const effects = window.effects;
    for (let i = 0; i < records.length && i < RECORD_BUDGET; i++) {
      const record = records[i];
      if (record.type === "childList") {
        let added = false;
        for (let j = 0; j < record.addedNodes.length && j < 16; j++) {
          const node = record.addedNodes[j];
          if (!(node instanceof Element)) continue;
          added = true;
          if (window.added.length < MAX_ADDED) window.added.push(node);
        }
        if (added) this.mark(window, "nodes");
        continue;
      }
      if (record.type !== "attributes") continue;
      const target = record.target as Element;
      const name = record.attributeName;
      if (name === "aria-expanded") {
        this.mark(window, "expanded");
        continue;
      }
      if ((name === "class" || name === "style") && this.related(window, target))
        this.mark(window, name === "class" ? "classes" : "style");
      if (
        !effects.overlay &&
        (name === "class" || name === "style" || name === "hidden" || name === "open" ||
          name === "aria-hidden" || name === "aria-modal") &&
        isOverlay(target) &&
        shown(target)
      )
        this.mark(window, "overlay");
    }
    if (!effects.overlay && scanAdded(records, (element) => isOverlay(element)))
      this.mark(window, "overlay");
  }

  // ---- Reporting ---------------------------------------------------------

  private finish(window: HoverWindow, reason: EndReason | "settled" | "timeout" | "overlapped"): void {
    clearTimeout(window.dwell);
    // A pointer that left before the dwell (or was cut off by another hover) is not a hover.
    if (!window.committed || !this.active) return;
    const e = window.effects;
    if (!Object.values(e).some(Boolean)) {
      this.host.silent(window.kind);
      return;
    }
    if (!this.take(window.key, now())) return;
    const data: HoverSettledData = {
      kind: window.kind,
      control_id: window.controlId,
      route_template: window.route,
      dwell_ms: clampMs(window.kind === "pointer" ? window.dwellMs : 0),
      settle_ms: clampMs((window.effectAt ?? window.t0) - window.t0),
      transition_started: e.transition,
      animation_started: e.animation,
      nodes_added: e.nodes,
      overlay_opened: e.overlay,
      expanded_changed: e.expanded,
      class_changed: e.classes,
      style_changed: e.style,
      snapshot_sha256: null,
      has_hover_handler: window.hasHandler,
    };
    if (!e.overlay || reason === "page_hidden") {
      this.host.emit(data);
      return;
    }
    let reported = false;
    const report = (hash: string | null) => {
      if (reported) return;
      reported = true;
      this.awaiting.delete(flush);
      if (!this.active) return;
      data.snapshot_sha256 = hash;
      this.host.emit(data);
    };
    const flush = () => report(null);
    this.awaiting.add(flush);
    this.host
      .snapshot(window.kind === "pointer" ? "hover" : "focus")
      .catch(() => null)
      .then(report, flush);
  }

  /** Whether a record for `key` would be allowed now (checked before following, so limited hovers cost nothing). */
  private admit(key: string, at: number): boolean {
    const last = this.lastRecord.get(key);
    if (last !== undefined && at - last < this.host.recordIntervalMs) return false;
    while (this.minute.length && at - this.minute[0] >= 60000) this.minute.shift();
    return this.minute.length < this.host.maxPerMinute;
  }

  /** Takes a record slot for `key`; false when the limits are reached. */
  private take(key: string, at: number): boolean {
    if (!this.admit(key, at)) return false;
    this.lastRecord.delete(key);
    this.lastRecord.set(key, at);
    if (this.lastRecord.size > MAX_KEYS) this.lastRecord.delete(this.lastRecord.keys().next().value!);
    this.minute.push(at);
    return true;
  }
}

/** Keyboard focus: the element matches `:focus-visible` (false where the selector is unsupported). */
function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return false;
  }
}

/** Rendered and not hidden: an overlay that is actually showing. */
function shown(element: Element): boolean {
  const check = (element as Element & { checkVisibility?: (options?: object) => boolean }).checkVisibility;
  if (typeof check === "function") return check.call(element, { visibilityProperty: true, opacityProperty: true });
  return element.getClientRects().length > 0;
}

function wrappersOf(element: Element): Element[] {
  const out: Element[] = [];
  for (
    let node = element.parentElement;
    node && out.length < INDICATOR_WRAPPERS && node !== document.body && node !== document.documentElement;
    node = node.parentElement
  )
    out.push(node);
  return out;
}

/** A CSS transition or animation is running on the element or its wrappers (false where getAnimations is missing). */
function animating(element: Element): boolean {
  try {
    for (const node of [element, ...wrappersOf(element)])
      if (typeof node.getAnimations === "function" && node.getAnimations().length > 0) return true;
  } catch {
    /* Unknown: compare styles alone. */
  }
  return false;
}

/** The indicator properties of the element and its wrappers, in order. Never leaves the page. */
function indicatorStyles(element: Element): string[] {
  const out: string[] = [];
  try {
    for (const node of [element, ...wrappersOf(element)]) {
      const style = getComputedStyle(node);
      for (const property of INDICATOR_PROPERTIES) out.push(style.getPropertyValue(property));
    }
  } catch {
    return [];
  }
  return out;
}

/**
 * React's hover handlers on `element` or up to `ancestors` (default three) ancestors: true when one of
 * them has an onMouseEnter/Over or onPointerEnter/Over function, false when they
 * are React elements without one, null when none is a React element. Only the
 * handler's type is read.
 */
export function reactHoverHandler(element: Element, ancestors = HANDLER_DEPTH): boolean | null {
  let react = false;
  try {
    let node: Element | null = element;
    for (let depth = 0; node && depth <= ancestors; node = node.parentElement, depth++) {
      for (const key of Object.keys(node)) {
        if (!key.startsWith("__reactProps$")) continue;
        react = true;
        const props = (node as unknown as Record<string, Record<string, unknown> | null>)[key];
        if (props && REACT_HANDLERS.some((name) => typeof props[name] === "function")) return true;
      }
    }
  } catch {
    return null;
  }
  return react ? false : null;
}

/**
 * Selectors for the elements the page's `:hover` style rules react to:
 * `.card:hover .title` reacts to `.card`. Collected from same-origin style
 * sheets (cross-origin ones cannot be read) at most every 10 seconds, or when
 * a style sheet is added or removed.
 */
class HoverRules {
  private selector = "";
  private sheets = -1;
  private builtAt = -Infinity;

  matches(element: Element): boolean {
    this.refresh();
    if (!this.selector) return false;
    try {
      return element.matches(this.selector);
    } catch {
      return false;
    }
  }

  private refresh(): void {
    const at = now();
    const sheets = document.styleSheets.length;
    if (sheets === this.sheets && at - this.builtAt < HOVER_RULES_TTL_MS) return;
    this.sheets = sheets;
    this.builtAt = at;
    const found = new Set<string>();
    let visited = 0;
    const visit = (rules: CSSRuleList) => {
      for (let i = 0; i < rules.length && visited < MAX_RULES && found.size < MAX_HOVER_SELECTORS; i++) {
        visited++;
        const rule = rules[i] as CSSRule & { selectorText?: string; cssRules?: CSSRuleList };
        if (typeof rule.selectorText === "string" && HOVER.test(rule.selectorText))
          for (const selector of hoveredSelectors(rule.selectorText)) found.add(selector);
        else if (rule.cssRules && typeof rule.selectorText !== "string") visit(rule.cssRules);
      }
    };
    for (let i = 0; i < sheets; i++) {
      try {
        visit(document.styleSheets[i].cssRules);
      } catch {
        /* Cross-origin style sheet. */
      }
    }
    this.selector = [...found].slice(0, MAX_HOVER_SELECTORS).join(",");
  }
}

const HOVER = /(?<!\\):hover(?![\w-])/;
const HOVER_ALL = /(?<!\\):hover(?![\w-])/g;
const PSEUDO_ELEMENTS = /::?(before|after|placeholder|marker|selection|backdrop|first-line|first-letter)\b/g;

/** Splits on `separator` outside parentheses, brackets and escapes. */
function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * For each part of a selector list with `:hover`: the selector up to the end
 * of the compound that has it, without `:hover`. Parts that do not parse on
 * their own (nesting, `:hover` inside a function) are dropped.
 */
export function hoveredSelectors(selectorText: string): string[] {
  const out: string[] = [];
  for (const raw of splitTop(selectorText, ",")) {
    const part = raw.trim();
    const match = HOVER.exec(part);
    if (!match || part.includes("&")) continue;
    let depth = 0;
    let end = part.length;
    for (let i = match.index; i < part.length; i++) {
      const c = part[i];
      if (c === "\\") i++;
      else if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") {
        if (depth === 0) {
          end = i;
          break;
        }
        depth--;
      } else if (depth === 0 && (c === " " || c === ">" || c === "+" || c === "~" || c === "\n" || c === "\t")) {
        end = i;
        break;
      }
    }
    const selector = part.slice(0, end).replace(HOVER_ALL, "").replace(PSEUDO_ELEMENTS, "").trim();
    if (!selector || selector === "*" || /[>+~]$/.test(selector)) continue;
    try {
      document.createDocumentFragment().querySelector(selector);
      out.push(selector);
    } catch {
      /* Not a selector on its own. */
    }
  }
  return out;
}

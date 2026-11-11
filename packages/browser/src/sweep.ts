/**
 * The in-page half of a hover and keyboard-focus sweep (see
 * `sweepInteractions` in @codepress/interactions-playwright): lists the
 * controls to visit, and after the test runner hovers or focuses one, waits
 * for the page to settle with the SDK's hover follow-through (hover-effects.ts)
 * and reports whether an overlay tied to that control opened.
 *
 * Only booleans, counts and control identifiers leave this module. Whether an
 * overlay has text is read in the page and never sent.
 */
import { OVERLAYS, isOverlay } from "./follow";
import { HoverEffects } from "./hover-effects";
import { INTERACTIVE } from "./snapshot";
import { controlIdOf, type TestIdFilter } from "./util";

/** The sweep rests the mouse this long before a hover counts (it is deliberate, so short). */
const DWELL_MS = 30;
/** The follow-through's hard timeout (5 s) plus margin: a window that never reports ends here. */
const WINDOW_CAP_MS = 5500;
/** Longest wait for the page to go quiet, and for finite transitions and animations to finish. */
const QUIET_CAP_MS = 5000;
const ANIMATION_CAP_MS = 2000;
/** A layer this close to the control (px, between the boxes) counts as anchored to it. */
const NEAR_PX = 16;
/** Elements visited per overlay scan, and added elements remembered per step. */
const MAX_CANDIDATES = 2000;
const MAX_ADDED = 64;
/** IDs followed per ARIA reference attribute. */
const MAX_REFERENCES = 8;
const REFERENCES = ["aria-describedby", "aria-controls", "aria-owns"];
const OVERLAY_QUERY = `${OVERLAYS},[popover]`;

export interface SweepSetup {
  /** CSS selector of the subtree to sweep. Default: the document element. */
  root?: string;
  /** Extra selector for subtrees to leave out; `[data-layout-ignore]` and `[data-interactions-exclude]` always apply. */
  ignore?: string;
  /** Quiet time after the last effect before a hover or focus counts as settled. */
  settleMs: number;
  testId?: TestIdFilter;
}

/** What one hover or focus did. */
export interface SweepStep {
  /** The control got it: the mouse rested on it, or keyboard focus reached it. */
  reached: boolean;
  /**
   * An overlay tied to the control opened: a dialog, tooltip, menu, listbox or
   * open popover, or a newly shown positioned layer with text or a control,
   * that is inside the control or its parent, is referenced by the control's
   * `aria-describedby`, `aria-controls` or `aria-owns`, or sits within 16 px
   * of it. A toast or banner elsewhere does not count.
   */
  overlay: boolean;
  /** The follow-through window ended on its own (settled, or timed out at 5 s), rather than the sweep's cap. */
  settled: boolean;
}

type Kind = "pointer" | "focus";

export class Sweep {
  readonly root: Element;
  private hovers: HoverEffects;
  private ignore: string;
  private testId?: TestIdFilter;
  private settleMs: number;
  /** The control the follow-through opened its window on since `arm`. */
  private opened: Element | null = null;
  private waiting: { kind: Kind; resolve: () => void } | null = null;
  private baseline = new Set<Element>();
  /** Elements added under the root since `arm` (portaled overlays are found this way). */
  private added: Element[] = [];
  private observer: MutationObserver | null = null;

  constructor(setup: SweepSetup) {
    const root = setup.root ? document.querySelector(setup.root) : document.documentElement;
    if (!root) throw new Error(`No element matches ${setup.root}`);
    this.root = root;
    this.ignore = ["[data-layout-ignore]", "[data-interactions-exclude]", setup.ignore].filter(Boolean).join(",");
    this.testId = setup.testId;
    this.settleMs = Math.max(1, Math.floor(setup.settleMs));
    this.hovers = new HoverEffects({
      root,
      dwellMs: DWELL_MS,
      settleMs: this.settleMs,
      // No rate limits: every hover and focus of the sweep is followed.
      recordIntervalMs: 0,
      maxPerMinute: Infinity,
      controlId: (element) => {
        this.opened = element;
        return "sweep";
      },
      routeTemplate: () => null,
      snapshot: () => Promise.resolve(null),
      emit: (data) => this.report(data.kind),
      silent: (kind) => this.report(kind),
      noFocusIndicator: () => {},
    });
    this.hovers.start();
  }

  /** Visible, enabled controls in document order (the snapshot's interactive detection), the first `max` of them, and how many there are. */
  controls(max: number): { elements: Element[]; total: number } {
    const all: Element[] = [];
    if (this.root.matches(INTERACTIVE)) all.push(this.root);
    all.push(...this.root.querySelectorAll(INTERACTIVE));
    const elements: Element[] = [];
    let total = 0;
    for (const element of all) {
      if (!this.sweepable(element)) continue;
      total++;
      if (elements.length < max) elements.push(element);
    }
    return { elements, total };
  }

  /** The control's identifier, as the SDK records `control_id`. */
  controlId(element: Element): string {
    return controlIdOf(element, this.root, this.testId);
  }

  /** Records the overlays tied to `control` that show now, before it is hovered or focused, and starts noting added elements. */
  arm(control: Element): void {
    this.opened = null;
    this.added = [];
    this.observer?.disconnect();
    this.observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof Element && this.added.length < MAX_ADDED) this.added.push(node);
    });
    this.observer.observe(this.root, { subtree: true, childList: true });
    this.baseline = this.overlays(control);
  }

  /** After the mouse moved onto `control`: waits for the hover to settle. */
  async hovered(control: Element): Promise<SweepStep> {
    const window = this.opened;
    const own = !!window && related(window, control);
    const { settled } = await this.follow("pointer", window !== null);
    const reached = own || safeMatches(control, ":hover");
    return { reached, overlay: reached && this.appeared(control), settled };
  }

  /** Gives `control` keyboard focus and waits for it to settle. */
  async focus(control: Element): Promise<SweepStep> {
    try {
      (control as HTMLElement).focus({ focusVisible: true } as FocusOptions);
    } catch {
      /* Not focusable. */
    }
    const active = document.activeElement;
    const reached = !!active && (active === control || control.contains(active));
    if (!reached) {
      this.disarm();
      return { reached, overlay: false, settled: true };
    }
    const { settled } = await this.follow("focus", this.opened !== null);
    return { reached, overlay: this.appeared(control), settled };
  }

  /** Ends keyboard focus on `control`, if it has it. */
  blur(control: Element): void {
    const active = document.activeElement;
    if (active && (active === control || control.contains(active))) (active as HTMLElement).blur?.();
  }

  /** Waits until nothing in the root changed for `settleMs` (at most 5 s), then for finite animations. */
  async quiet(): Promise<void> {
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        observer.disconnect();
        clearTimeout(cap);
        clearTimeout(timer);
        resolve();
      };
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(done, this.settleMs);
      });
      observer.observe(this.root, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(done, this.settleMs);
      const cap = setTimeout(done, QUIET_CAP_MS);
    });
    await animationsDone();
  }

  /** A viewport point whose topmost element is not a control or inside one, to rest the mouse away from controls. */
  away(): { x: number; y: number } {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const points = [
      [w - 2, h - 2], [1, h - 2], [w - 2, 1], [1, 1], [w >> 1, h - 2], [w - 2, h >> 1], [1, h >> 1],
    ];
    for (const [x, y] of points) {
      const hit = document.elementFromPoint(x, y);
      if (!hit || hit === document.documentElement || hit === document.body) return { x, y };
      if (!hit.closest(INTERACTIVE) && getComputedStyle(hit).cursor !== "pointer") return { x, y };
    }
    return { x: w - 2, y: h - 2 };
  }

  stop(): void {
    this.disarm();
    this.hovers.stop();
    this.waiting?.resolve();
    this.waiting = null;
  }

  // ---- Internals ----------------------------------------------------------

  private sweepable(element: Element): boolean {
    if ((element as HTMLButtonElement).disabled || element.closest("fieldset:disabled")) return false;
    if (element.closest("[inert]") || safeClosest(element, this.ignore)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && visible(element);
  }

  private disarm(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  private report(kind: Kind): void {
    if (this.waiting?.kind !== kind) return;
    this.waiting.resolve();
    this.waiting = null;
  }

  /**
   * Waits for the follow-through window of `kind` to report (settled, or its
   * 5 s timeout); without one, for the page to go quiet. Then for finite
   * transitions. False when the sweep's own cap ended the wait.
   */
  private async follow(kind: Kind, opened: boolean): Promise<{ settled: boolean }> {
    if (!opened) {
      await this.quiet();
      return { settled: true };
    }
    let settled = true;
    await new Promise<void>((resolve) => {
      const cap = setTimeout(() => {
        settled = false;
        this.waiting = null;
        resolve();
      }, DWELL_MS + this.settleMs + WINDOW_CAP_MS);
      this.waiting = {
        kind,
        resolve: () => {
          clearTimeout(cap);
          resolve();
        },
      };
    });
    await animationsDone();
    return { settled };
  }

  /**
   * Shown overlays tied to `control`. Only candidates are inspected, never the
   * whole page: the subtree of the control's parent, what the control's ARIA
   * references point to, overlays by role or popover, and what was added
   * since `arm`.
   */
  private overlays(control: Element): Set<Element> {
    const out = new Set<Element>();
    const parent = control.parentElement;
    const owner =
      parent && parent !== document.body && parent !== document.documentElement && this.root.contains(parent) && parent !== this.root
        ? parent
        : control;
    const referenced: Element[] = [];
    for (const name of REFERENCES)
      for (const id of (control.getAttribute(name) ?? "").split(/\s+/).filter(Boolean).slice(0, MAX_REFERENCES)) {
        const element = document.getElementById(id);
        if (element) referenced.push(element);
      }
    const box = control.getBoundingClientRect();
    const tied = (element: Element) =>
      owner.contains(element) ||
      referenced.some((reference) => reference.contains(element) || element.contains(reference)) ||
      near(element.getBoundingClientRect(), box);
    let budget = MAX_CANDIDATES;
    const visit = (element: Element) => {
      if (budget-- <= 0 || out.has(element) || element === control || element.contains(control)) return;
      if (overlayLike(element) && tied(element)) out.add(element);
    };
    const subtree = (top: Element) => {
      visit(top);
      const all = top.getElementsByTagName("*");
      for (let i = 0; i < all.length && budget > 0; i++) visit(all[i]);
    };
    subtree(owner);
    for (const element of referenced) subtree(element);
    try {
      const overlays = this.root.querySelectorAll(OVERLAY_QUERY);
      for (let i = 0; i < overlays.length && budget > 0; i++) visit(overlays[i]);
    } catch {
      /* Selector unsupported. */
    }
    for (const element of this.added) if (element.isConnected) subtree(element);
    return out;
  }

  /** An overlay tied to the control shows that did not before `arm`. Ends noting added elements. */
  private appeared(control: Element): boolean {
    const now = this.overlays(control);
    this.disarm();
    for (const element of now) if (!this.baseline.has(element)) return true;
    return false;
  }
}

/** The boxes are at most `NEAR_PX` apart (or overlap). */
function near(a: DOMRect, b: DOMRect): boolean {
  const dx = Math.max(0, b.left - a.right, a.left - b.right);
  const dy = Math.max(0, b.top - a.bottom, a.top - b.bottom);
  return dx <= NEAR_PX && dy <= NEAR_PX;
}

function related(a: Element, b: Element): boolean {
  return a === b || a.contains(b) || b.contains(a);
}

function safeMatches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

function safeClosest(element: Element, selector: string): boolean {
  try {
    return !!element.closest(selector);
  } catch {
    return false;
  }
}

function visible(element: Element): boolean {
  const check = (element as Element & { checkVisibility?: (options?: object) => boolean }).checkVisibility;
  if (typeof check !== "function") return element.getClientRects().length > 0;
  return check.call(element, { visibilityProperty: true, opacityProperty: true });
}

function overlayLike(element: Element): boolean {
  const overlay = isOverlay(element);
  if (!overlay) {
    const position = getComputedStyle(element).position;
    if (position !== "absolute" && position !== "fixed") return false;
  }
  const rect = element.getBoundingClientRect();
  // Visually hidden text (1 px boxes) is not something a hover shows.
  if (rect.width <= 1 || rect.height <= 1 || !visible(element)) return false;
  if (overlay) return true;
  // A positioned layer counts when it has content: text (read here, never sent) or a control.
  return (element.textContent ?? "").trim().length > 0 || !!element.querySelector(INTERACTIVE);
}

/** Waits for running transitions and animations with a finite end, at most 2 s. */
async function animationsDone(): Promise<void> {
  let running: Animation[] = [];
  try {
    running = document.getAnimations().filter((animation) => {
      const end = animation.effect?.getComputedTiming().endTime;
      return animation.playState === "running" && typeof end === "number" && Number.isFinite(end);
    });
  } catch {
    return;
  }
  if (!running.length) return;
  await Promise.race([
    Promise.allSettled(running.map((animation) => animation.finished)),
    new Promise((resolve) => setTimeout(resolve, ANIMATION_CAP_MS)),
  ]);
}

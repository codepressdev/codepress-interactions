/**
 * The in-page half of a hover and keyboard-focus sweep (see
 * `sweepInteractions` in @codepress/interactions-playwright): lists the
 * controls to visit, and after the test runner hovers or focuses one, waits
 * for the page to settle with the SDK's hover follow-through (hover-effects.ts)
 * and reports whether an overlay opened.
 *
 * Only booleans, counts and control identifiers leave this module. Whether an
 * overlay has text is read in the page and never sent.
 */
import { isOverlay } from "./follow";
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
/** Elements visited when looking for overlays. */
const MAX_SCAN = 20000;

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
  /** An overlay opened: a dialog, tooltip, menu, listbox or open popover, or a newly shown positioned layer with text or a control. */
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
  private waiting: { kind: Kind; resolve: (overlay: boolean) => void } | null = null;
  private baseline = new Set<Element>();

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
      emit: (data) => this.report(data.kind, data.overlay_opened),
      silent: (kind) => this.report(kind, false),
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

  /** Records what is showing now, before a hover or focus. */
  arm(): void {
    this.opened = null;
    this.baseline = this.overlays();
  }

  /** After the mouse moved onto `control`: waits for the hover to settle. */
  async hovered(control: Element): Promise<SweepStep> {
    const window = this.opened;
    const own = !!window && related(window, control);
    const { overlay, settled } = await this.follow("pointer", window !== null);
    const reached = own || safeMatches(control, ":hover");
    return { reached, overlay: reached && (overlay || this.appeared(control)), settled };
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
    if (!reached) return { reached, overlay: false, settled: true };
    const { overlay, settled } = await this.follow("focus", this.opened !== null);
    return { reached, overlay: overlay || this.appeared(control), settled };
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
    this.hovers.stop();
    this.waiting?.resolve(false);
    this.waiting = null;
  }

  // ---- Internals ----------------------------------------------------------

  private sweepable(element: Element): boolean {
    if ((element as HTMLButtonElement).disabled || element.closest("fieldset:disabled")) return false;
    if (element.closest("[inert]") || safeClosest(element, this.ignore)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && visible(element);
  }

  private report(kind: Kind, overlay: boolean): void {
    if (this.waiting?.kind !== kind) return;
    this.waiting.resolve(overlay);
    this.waiting = null;
  }

  /** Waits for the follow-through window of `kind` to report; without one, for the page to go quiet. */
  private async follow(kind: Kind, opened: boolean): Promise<{ overlay: boolean; settled: boolean }> {
    if (!opened) {
      await this.quiet();
      return { overlay: false, settled: true };
    }
    let settled = true;
    const overlay = await new Promise<boolean>((resolve) => {
      const cap = setTimeout(() => {
        settled = false;
        this.waiting = null;
        resolve(false);
      }, DWELL_MS + this.settleMs + WINDOW_CAP_MS);
      this.waiting = {
        kind,
        resolve: (value) => {
          clearTimeout(cap);
          resolve(value);
        },
      };
    });
    await animationsDone();
    return { overlay, settled };
  }

  /** Shown overlays: the follow-through's overlays, plus absolutely or fixed positioned layers with text or a control. */
  private overlays(): Set<Element> {
    const out = new Set<Element>();
    const all = this.root.getElementsByTagName("*");
    for (let i = 0; i < all.length && i < MAX_SCAN; i++) {
      const element = all[i];
      if (overlayLike(element)) out.add(element);
    }
    return out;
  }

  /** An overlay is showing that was not before `arm`, other than the control and what contains it. */
  private appeared(control: Element): boolean {
    for (const element of this.overlays())
      if (!this.baseline.has(element) && element !== control && !element.contains(control)) return true;
    return false;
  }
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

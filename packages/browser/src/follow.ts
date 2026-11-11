/**
 * Follow-through windows, shared by clicks, hovers and keyboard focus: one
 * MutationObserver that is attached only while a window is open (idle pages
 * pay nothing), the quiet timer that settles a window once nothing happened
 * for `settleMs`, the hard timeout, and bounded detection of dialogs and
 * overlays in added subtrees.
 */
import { now } from "./util";

export const DIALOGS = 'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
/** Dialogs and what a hover or focus typically opens. `[popover]:popover-open` is tested separately (older browsers throw on it). */
export const OVERLAYS = `${DIALOGS},[role="tooltip"],[role="menu"],[role="listbox"]`;
/** Elements inspected per mutation callback, across all added subtrees. */
export const SCAN_BUDGET = 256;

const OBSERVED_ATTRIBUTES = [
  "class", "hidden", "open", "disabled", "aria-expanded", "aria-hidden",
  "aria-busy", "aria-selected", "aria-checked", "aria-pressed", "aria-modal",
];

/** The observer configuration for a follow-through window; `extra` adds attributes (hovers add `style`). */
export const observeOptions = (extra: readonly string[] = []): MutationObserverInit => ({
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
  attributeFilter: [...OBSERVED_ATTRIBUTES, ...extra],
});

/** `element` is an overlay: a dialog, tooltip, menu, listbox or an open popover. */
export function isOverlay(element: Element): boolean {
  try {
    if (element.matches(OVERLAYS)) return true;
  } catch {
    return false;
  }
  try {
    return element.matches("[popover]:popover-open");
  } catch {
    return false;
  }
}

/**
 * Looks for an element passing `test` in the subtrees added by `records`,
 * visiting at most `budget` elements in total (the first 32 records, 16 added
 * nodes each).
 */
export function scanAdded(
  records: readonly MutationRecord[],
  test: (element: Element) => boolean,
  budget = SCAN_BUDGET,
): boolean {
  for (let i = 0; i < records.length && i < 32 && budget > 0; i++) {
    const added = records[i].addedNodes;
    for (let j = 0; j < added.length && j < 16 && budget > 0; j++) {
      const node = added[j];
      if (!(node instanceof Element)) continue;
      const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
      for (let current: Node | null = node; current && budget > 0; current = walker.nextNode()) {
        budget--;
        if (test(current as Element)) return true;
      }
    }
  }
  return false;
}

/** The timing state every follow-through window has. */
export interface FollowWindow {
  t0: number;
  lastEffect: number;
  /** Observed requests still running: a window never settles while one is. */
  inflight: number;
  /**
   * false while the window may not settle yet (a hover still inside its dwell):
   * effects are recorded but start no quiet timer, and whoever commits it calls
   * `scheduleQuiet`. Absent means committed.
   */
  committed?: boolean;
  quiet?: ReturnType<typeof setTimeout>;
  hard?: ReturnType<typeof setTimeout>;
}

export interface FollowerHost<W extends FollowWindow, R extends string> {
  root: Element;
  observe: MutationObserverInit;
  settleMs: number;
  timeoutMs: number;
  /** Mutations while `window` is open. Exceptions are swallowed. */
  records(window: W, records: MutationRecord[]): void;
  /** The window ended: `settled`, `timeout`, or the reason passed to `end`. */
  ended(window: W, reason: R | "settled" | "timeout" | "overlapped"): void;
}

/** One open window at a time: opening another ends the open one as `overlapped`. */
export class Follower<W extends FollowWindow, R extends string = never> {
  current: W | null = null;
  private observer: MutationObserver | null = null;

  constructor(private host: FollowerHost<W, R>) {}

  /**
   * Opens `window` and starts observing. With `settle` false the quiet timer
   * waits for `scheduleQuiet` (a hover still inside its dwell; see `committed`).
   */
  open(window: W, settle = true): void {
    if (this.current) this.end(this.current, "overlapped");
    this.current = window;
    this.observer ??= new MutationObserver((records) => {
      const open = this.current;
      if (!open) return;
      try {
        this.host.records(open, records);
      } catch {
        /* Never affect the page. */
      }
    });
    this.observer.observe(this.host.root, this.host.observe);
    window.hard = setTimeout(() => this.end(window, "timeout"), this.host.timeoutMs);
    if (settle) this.scheduleQuiet(window);
  }

  /** Something happened in `window`: it settles `settleMs` after the last effect. */
  effect(window: W, at = now()): void {
    window.lastEffect = at;
    if (window.inflight === 0 && window.committed !== false) this.scheduleQuiet(window);
  }

  scheduleQuiet(window: W): void {
    clearTimeout(window.quiet);
    window.quiet = setTimeout(() => {
      if (this.current === window && window.inflight === 0) this.end(window, "settled");
    }, this.host.settleMs);
  }

  /** Ends `window` if it is the open one and reports it; false when it was not open. */
  end(window: W, reason: R | "settled" | "timeout" | "overlapped"): boolean {
    if (!this.close(window)) return false;
    this.host.ended(window, reason);
    return true;
  }

  /** Drops the open window without reporting it. */
  cancel(): void {
    if (this.current) this.close(this.current);
  }

  stop(): void {
    this.cancel();
    this.observer?.disconnect();
    this.observer = null;
  }

  private close(window: W): boolean {
    if (this.current !== window) return false;
    this.current = null;
    this.observer?.disconnect();
    clearTimeout(window.quiet);
    clearTimeout(window.hard);
    return true;
  }
}

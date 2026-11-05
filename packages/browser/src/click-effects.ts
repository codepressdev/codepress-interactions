/**
 * Click follow-through: what happened after a click until the page went quiet.
 * Everything here is inferred from timing (attribution "inferred"); requests
 * observed in the window are counted, never attached to the click as explicit.
 */
import type { PerfSignals, SignalCounters } from "./perf";
import type { ClickEndReason, ClickSettledData } from "./types";
import { clampMs, now } from "./util";

const DIALOGS = 'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
/** Elements inspected for a dialog per mutation callback, across all added subtrees. */
const DIALOG_SCAN_BUDGET = 256;
const MAX_COUNT = 1_000_000;

export interface ClickHost {
  root: Element;
  settleMs: number;
  timeoutMs: number;
  perf: PerfSignals;
  currentHash(): string | null;
  routeTemplate(): string | null;
  /** Snapshot after settling; resolves with its hash, or null when skipped. */
  snapshotAfter(): Promise<string | null>;
  emit(interactionId: string, data: ClickSettledData): void;
}

interface ClickWindow {
  id: string;
  control: Element;
  controlId: string;
  routeTemplate: string | null;
  t0: number;
  before: string | null;
  firstFeedback: number | null;
  lastEffect: number;
  inflight: number;
  mutations: number;
  requests: number;
  failed: number;
  errors: number;
  longTasks: number;
  layoutShift: number;
  routeChanged: boolean;
  dialogOpened: boolean;
  focusMoved: boolean;
  overlapped: boolean;
  quiet?: ReturnType<typeof setTimeout>;
  hard?: ReturnType<typeof setTimeout>;
}

const OBSERVE: MutationObserverInit = {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
  attributeFilter: [
    "class", "hidden", "open", "disabled", "aria-expanded", "aria-hidden",
    "aria-busy", "aria-selected", "aria-checked", "aria-pressed", "aria-modal",
  ],
};

export class ClickEffects {
  private current: ClickWindow | null = null;
  private observer?: MutationObserver;
  private removals: (() => void)[] = [];
  private active = false;
  /** Settled clicks whose after-snapshot is still being taken. */
  private awaitingAfter = new Set<() => void>();

  constructor(private host: ClickHost) {}

  start(): void {
    this.active = true;
    this.observer = new MutationObserver((records) => {
      try {
        const click = this.current;
        if (!click) return;
        click.mutations = Math.min(MAX_COUNT, click.mutations + records.length);
        // Dialog detection inspects a bounded number of records per callback.
        let budget = DIALOG_SCAN_BUDGET;
        for (let i = 0; i < records.length && i < 32 && !click.dialogOpened; i++) {
          const record = records[i];
          if (record.type === "attributes") {
            const target = record.target as Element;
            if (
              (record.attributeName === "open" && target.matches?.("dialog[open]")) ||
              (record.attributeName === "aria-modal" && target.matches?.(DIALOGS))
            )
              click.dialogOpened = true;
          }
          for (let j = 0; j < record.addedNodes.length && j < 16 && !click.dialogOpened; j++) {
            const node = record.addedNodes[j];
            if (node instanceof Element) budget = this.scanForDialog(click, node, budget);
          }
        }
        this.effect(click, true);
      } catch {
        /* Never affect the page. */
      }
    });
    const onFocus = (event: Event) => {
      const click = this.current;
      if (!click || !(event.target instanceof Node)) return;
      if (event.target === click.control || click.control.contains(event.target)) return;
      click.focusMoved = true;
      this.effect(click, true);
    };
    const onToggle = (event: Event) => {
      const click = this.current;
      if (!click) return;
      if ((event as Event & { newState?: string }).newState === "open") {
        click.dialogOpened = true;
        this.effect(click, true);
      }
    };
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("toggle", onToggle, true);
    this.removals.push(
      () => document.removeEventListener("focusin", onFocus, true),
      () => document.removeEventListener("toggle", onToggle, true),
    );
    this.removals.push(
      this.host.perf.subscribe((delta: Partial<SignalCounters>) => {
        const click = this.current;
        if (!click) return;
        click.errors += delta.uncaughtErrorCount ?? 0;
        click.longTasks += delta.longTaskCount ?? 0;
        click.layoutShift += delta.layoutShiftScore ?? 0;
      }),
    );
  }

  /** Starts following a click. A click still open is closed as overlapped. */
  begin(id: string, controlId: string, control: Element): void {
    if (!this.active) return;
    const previous = this.current;
    if (previous) this.finish(previous, "overlapped");
    const t0 = now();
    const click: ClickWindow = {
      id,
      control,
      controlId,
      routeTemplate: this.host.routeTemplate(),
      t0,
      before: this.host.currentHash(),
      firstFeedback: null,
      lastEffect: t0,
      inflight: 0,
      mutations: 0,
      requests: 0,
      failed: 0,
      errors: 0,
      longTasks: 0,
      layoutShift: 0,
      routeChanged: false,
      dialogOpened: false,
      focusMoved: false,
      overlapped: !!previous,
    };
    this.current = click;
    // Observed only while a click is open: idle pages pay nothing.
    this.observer?.observe(this.host.root, OBSERVE);
    click.hard = setTimeout(() => this.finish(click, "timeout"), this.host.timeoutMs);
    this.scheduleQuiet(click);
  }

  /** Counts a request started now; returns its completion callback. */
  requestStarted(): (failed: boolean) => void {
    const click = this.current;
    if (!click) return () => {};
    click.requests = Math.min(MAX_COUNT, click.requests + 1);
    click.inflight++;
    click.lastEffect = now();
    clearTimeout(click.quiet);
    let done = false;
    return (failed) => {
      if (done) return;
      done = true;
      if (this.current !== click) return;
      click.inflight--;
      if (failed) click.failed++;
      this.effect(click, false);
    };
  }

  routeChanged(): void {
    const click = this.current;
    if (!click) return;
    click.routeChanged = true;
    this.effect(click, true);
  }

  /** Page is going away: report the open click as incomplete, synchronously. */
  pageHidden(): void {
    if (this.current) this.finish(this.current, "page_hidden");
    // Settled clicks still waiting for their after-snapshot are reported now,
    // without an after hash, so page unload cannot lose them.
    for (const report of this.awaitingAfter) report();
  }

  stop(): void {
    this.active = false;
    this.awaitingAfter.clear();
    if (this.current) {
      clearTimeout(this.current.quiet);
      clearTimeout(this.current.hard);
      this.current = null;
    }
    this.observer?.disconnect();
    for (const remove of this.removals) remove();
    this.removals = [];
  }

  /** Looks for a dialog in an added subtree, visiting at most `budget` elements. */
  private scanForDialog(click: ClickWindow, node: Element, budget: number): number {
    const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    for (let current: Node | null = node; current && budget > 0; current = walker.nextNode()) {
      budget--;
      if ((current as Element).matches(DIALOGS)) {
        click.dialogOpened = true;
        break;
      }
    }
    return budget;
  }

  private effect(click: ClickWindow, feedback: boolean): void {
    const at = now();
    if (feedback && click.firstFeedback === null) click.firstFeedback = at - click.t0;
    click.lastEffect = at;
    if (click.inflight === 0) this.scheduleQuiet(click);
  }

  private scheduleQuiet(click: ClickWindow): void {
    clearTimeout(click.quiet);
    click.quiet = setTimeout(() => {
      if (this.current === click && click.inflight === 0) this.finish(click, "settled");
    }, this.host.settleMs);
  }

  private finish(click: ClickWindow, reason: ClickEndReason): void {
    if (this.current !== click) return;
    this.current = null;
    this.observer?.disconnect();
    clearTimeout(click.quiet);
    clearTimeout(click.hard);
    const end = reason === "settled" ? click.lastEffect : now();
    const available = this.host.perf.available;
    const data: ClickSettledData = {
      action: "click",
      control_id: click.controlId,
      route_template: click.routeTemplate,
      first_feedback_ms:
        click.firstFeedback === null ? null : clampMs(click.firstFeedback),
      settle_ms: clampMs(end - click.t0),
      mutation_count: click.mutations,
      request_count: click.requests,
      request_failed_count: click.failed,
      error_count: Math.min(MAX_COUNT, click.errors),
      long_task_count: available.long_task ? Math.min(MAX_COUNT, click.longTasks) : null,
      layout_shift_score: available.layout_shift
        ? Math.round(click.layoutShift * 10000) / 10000
        : null,
      route_changed: click.routeChanged,
      dialog_opened: click.dialogOpened,
      focus_moved: click.focusMoved,
      overlapped: click.overlapped || reason === "overlapped",
      incomplete: reason === "timeout" || reason === "page_hidden",
      end_reason: reason,
      before_sha256: click.before,
      after_sha256: null,
    };
    if (reason !== "settled") {
      this.host.emit(click.id, data);
      return;
    }
    let reported = false;
    const report = (hash: string | null) => {
      if (reported) return;
      reported = true;
      this.awaitingAfter.delete(flush);
      if (!this.active) return;
      data.after_sha256 = hash;
      this.host.emit(click.id, data);
    };
    const flush = () => report(null);
    this.awaitingAfter.add(flush);
    this.host
      .snapshotAfter()
      .catch(() => null)
      .then(report, flush);
  }
}

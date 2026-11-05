/**
 * Click follow-through: what happened after a click until the page went quiet.
 * Everything here is inferred from timing (attribution "inferred"); requests
 * observed in the window are counted, never attached to the click as explicit.
 */
import type { PerfSignals, SignalCounters } from "./perf";
import { INTERACTIVE } from "./snapshot";
import type { ClickEndReason, ClickSettledData } from "./types";
import { clampMs, now } from "./util";

const DIALOGS = 'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
/** Elements inspected for a dialog per mutation callback, across all added subtrees. */
const DIALOG_SCAN_BUDGET = 256;
const MAX_COUNT = 1_000_000;
/** Text entry and pickers: focusing one is the click's visible effect (a caret or a picker). */
const FIELD =
  'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]):not([type="checkbox"]):not([type="radio"]):not([type="hidden"]),textarea,select,[contenteditable=""],[contenteditable="true"]';
/** Inputs after the click itself: what they cause belongs to them, not to the click. */
const USER_INPUT = ["pointerdown", "mousedown", "touchstart", "keydown"] as const;

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
  /** The clicked element (or its nearest ancestor) is a control, not just a container. */
  target: Element | null;
  /** The form field a click on a label activates. */
  labelled: Element | null;
  valueChanged: boolean;
  fieldFocused: boolean;
  newContext: boolean;
  /** The click's own press, or the click while open, changed the text selection or caret. */
  selectionChanged: boolean;
  /** A later pointer or key input happened while this click was open. */
  laterInput: boolean;
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
  /** The text selection just before the last pointer press's default action. */
  private pressSelection: SelectionMark | null = null;

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
      // Focus after a later click or key press is that input's doing (F1).
      if (!click || click.laterInput || !(event.target instanceof Node)) return;
      if (isField(event.target) && this.ownField(click, event.target)) {
        click.fieldFocused = true;
        return;
      }
      if (event.target === click.control || click.control.contains(event.target)) return;
      click.focusMoved = true;
      this.effect(click, true);
    };
    const onValue = (event: Event) => {
      const click = this.current;
      if (!click || click.laterInput || !(event.target instanceof Node)) return;
      if (!this.ownField(click, event.target)) return;
      click.valueChanged = true;
      this.effect(click, true);
    };
    const onInput = (event: Event) => {
      if (event.type === "pointerdown" || event.type === "mousedown") this.pressSelection = selectionMark();
      const click = this.current;
      if (click) click.laterInput = true;
    };
    // A press places the caret or selects a word or line in its default
    // action, before its click event; `begin` compares the selection with the
    // one before the press (selectionchange events are coalesced and arrive
    // late). A change while the click is open (the page selecting text) counts too.
    const onSelection = () => {
      const click = this.current;
      if (click && !click.laterInput) click.selectionChanged = true;
    };
    document.addEventListener("selectionchange", onSelection, true);
    this.removals.push(() => document.removeEventListener("selectionchange", onSelection, true));
    for (const type of USER_INPUT) {
      document.addEventListener(type, onInput, { capture: true, passive: true });
      this.removals.push(() => document.removeEventListener(type, onInput, { capture: true }));
    }
    for (const type of ["input", "change"]) {
      document.addEventListener(type, onValue, true);
      this.removals.push(() => document.removeEventListener(type, onValue, true));
    }
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
  begin(id: string, controlId: string, control: Element, event?: Event): void {
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
      target: null,
      labelled: null,
      valueChanged: false,
      fieldFocused: false,
      newContext: false,
      // A mouse click (detail > 0) whose own press changed the selection.
      selectionChanged:
        ((event as MouseEvent | undefined)?.detail ?? 0) > 0 &&
        !!this.pressSelection &&
        !sameSelection(this.pressSelection, selectionMark()),
      laterInput: false,
    };
    try {
      describeTarget(click, event, this.host.root);
    } catch {
      /* Unknown target: reported as not interactive. */
    }
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

  /** A new tab or window was opened (window.open) while a click was open. */
  newContext(): void {
    const click = this.current;
    if (click && !click.laterInput) click.newContext = true;
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

  /** Is `node` the clicked field, inside the clicked control, or the field its label activates? */
  private ownField(click: ClickWindow, node: Node): boolean {
    return (
      node === click.target ||
      node === click.labelled ||
      node === click.control ||
      click.control.contains(node) ||
      (!!click.target && click.target.contains(node))
    );
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
      target_interactive: !!click.target,
      value_changed: click.valueChanged,
      field_focused: click.fieldFocused,
      new_context: click.newContext,
      selection_changed: click.selectionChanged,
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

const isField = (node: Node): node is Element => node instanceof Element && node.matches(FIELD);

/** Where the selection is: node references and offsets only, never its text. */
interface SelectionMark {
  anchor: Node | null;
  anchorOffset: number;
  focus: Node | null;
  focusOffset: number;
}

function selectionMark(): SelectionMark | null {
  try {
    const selection = document.getSelection();
    if (!selection) return null;
    return {
      anchor: selection.anchorNode,
      anchorOffset: selection.anchorOffset,
      focus: selection.focusNode,
      focusOffset: selection.focusOffset,
    };
  } catch {
    return null;
  }
}

const sameSelection = (a: SelectionMark, b: SelectionMark | null): boolean =>
  !!b && a.anchor === b.anchor && a.anchorOffset === b.anchorOffset && a.focus === b.focus && a.focusOffset === b.focusOffset;

/** Records what was clicked: the nearest control, a label's field, and browser-handled effects. */
function describeTarget(click: ClickWindow, event: Event | undefined, root: Element): void {
  const origin = event?.target instanceof Element ? event.target : click.control;
  const target = origin.closest(`${INTERACTIVE},label`);
  if (!target || !root.contains(target)) return;
  if ((target as HTMLButtonElement).disabled || target.closest("fieldset:disabled")) return;
  click.target = target;
  if (target instanceof HTMLLabelElement) click.labelled = target.control;
  const field = isField(target) ? target : click.labelled && isField(click.labelled) ? click.labelled : null;
  // The press focused the field before the click event: its caret or picker is the effect.
  if (field && document.activeElement === field) click.fieldFocused = true;
  const link = target.closest("a[href]");
  const mouse = event as MouseEvent | undefined;
  if (
    link &&
    (!["", "_self", "_parent", "_top"].includes((link.getAttribute("target") ?? "").toLowerCase()) ||
      link.hasAttribute("download") ||
      mouse?.metaKey ||
      mouse?.ctrlKey ||
      mouse?.shiftKey)
  )
    click.newContext = true;
}

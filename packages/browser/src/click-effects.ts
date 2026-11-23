/**
 * Click follow-through: what happened after a click until the page went quiet.
 * Everything here is inferred from timing (attribution "inferred"); requests
 * observed in the window are counted, never attached to the click as explicit.
 */
import type { EffectContracts, EffectWatch } from "./effect-contract";
import { DIALOGS, Follower, observeOptions, scanAdded, type FollowWindow } from "./follow";
import type { PerfSignals, SignalCounters } from "./perf";
import { INTERACTIVE } from "./snapshot";
import { STATE } from "./format";
import { attributeOn, GROUP, groupOf, linksHereIn, markedIn, STATE_ATTRIBUTES, stateBits, statefulIn } from "./state";
import type { ClickEndReason, ClickSettledData } from "./types";
import { clampMs, now } from "./util";

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
  /** Effect contracts in the markup (`data-interaction-removes` and the like); absent when the check is off. */
  effects?: EffectContracts;
}

interface ClickWindow extends FollowWindow {
  id: string;
  control: Element;
  controlId: string;
  routeTemplate: string | null;
  before: string | null;
  firstFeedback: number | null;
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
  /** The clicked control's effect contract, when it declares one. */
  effect: EffectWatch | null;
  /** The clicked control's (or target's) state bits when the click began. */
  clickedBefore: number;
  /** The control's nearest group, its position among groups, and its marked items when the click began. */
  group: Element | null;
  groupIndex: number;
  markedBefore: number | null;
  /** Elements added or removed while the click was open: whether each was in the page when it began. */
  moved: Map<Element, boolean>;
  /**
   * Per element and state attribute (from the observer's old values): the value
   * before the first change, and whether a later change saw it on or off differently.
   */
  attributeTrack: Map<Element, Map<string, { value: string | null; first: boolean; moved: boolean }>>;
}

/** Bits a click's state comparison looks at: everything but links_here, which moves with the route. */
const CLAIMED = ~STATE.links_here;
const STATE_ATTRIBUTE_SET = new Set<string>(STATE_ATTRIBUTES);

const isDialog = (element: Element): boolean => element.matches(DIALOGS);

export class ClickEffects {
  private follow: Follower<ClickWindow, "page_hidden">;
  private removals: (() => void)[] = [];
  private active = false;
  /** Settled clicks whose after-snapshot is still being taken. */
  private awaitingAfter = new Set<() => void>();
  /** The text selection just before the last pointer press's default action. */
  private pressSelection: SelectionMark | null = null;

  constructor(private host: ClickHost) {
    this.follow = new Follower<ClickWindow, "page_hidden">({
      root: host.root,
      // State attributes with their old values, to see a change that reverted before settling.
      observe: { ...observeOptions(["aria-current", "aria-invalid", "aria-disabled", "checked"]), attributeOldValue: true },
      settleMs: host.settleMs,
      timeoutMs: host.timeoutMs,
      records: (click, records) => {
        click.mutations = Math.min(MAX_COUNT, click.mutations + records.length);
        // Dialog detection inspects a bounded number of records per callback.
        for (let i = 0; i < records.length && i < 32 && !click.dialogOpened; i++) {
          const record = records[i];
          if (record.type !== "attributes") continue;
          const target = record.target as Element;
          if (
            (record.attributeName === "open" && target.matches?.("dialog[open]")) ||
            (record.attributeName === "aria-modal" && target.matches?.(DIALOGS))
          )
            click.dialogOpened = true;
        }
        if (!click.dialogOpened && scanAdded(records, isDialog)) click.dialogOpened = true;
        trackState(click, records);
        if (click.effect) this.host.effects?.records(click.effect, records);
        this.effect(click, true);
      },
      ended: (click, reason) => this.finish(click, reason),
    });
  }

  private get current(): ClickWindow | null {
    return this.follow.current;
  }

  /** The open click's interaction ID: a request started now belongs to it (inferred). */
  openInteractionId(): string | null {
    return this.current?.id ?? null;
  }

  start(): void {
    this.active = true;
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
    if (previous) this.follow.end(previous, "overlapped");
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
      effect: null,
      clickedBefore: 0,
      moved: new Map(),
      group: null,
      groupIndex: -1,
      markedBefore: null,
      attributeTrack: new Map(),
    };
    try {
      describeTarget(click, event, this.host.root);
    } catch {
      /* Unknown target: reported as not interactive. */
    }
    try {
      stateBegin(click, this.host.root);
    } catch {
      /* State that cannot be read is not compared. */
    }
    try {
      click.effect = this.host.effects?.begin(control, event?.target) ?? null;
    } catch {
      /* A contract that cannot be read is not checked. */
    }
    // Observed only while a click is open: idle pages pay nothing.
    this.follow.open(click);
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
    if (this.current) this.follow.end(this.current, "page_hidden");
    // Settled clicks still waiting for their after-snapshot are reported now,
    // without an after hash, so page unload cannot lose them.
    for (const report of this.awaitingAfter) report();
  }

  stop(): void {
    this.active = false;
    this.awaitingAfter.clear();
    this.follow.stop();
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

  private effect(click: ClickWindow, feedback: boolean): void {
    const at = now();
    if (feedback && click.firstFeedback === null) click.firstFeedback = at - click.t0;
    this.follow.effect(click, at);
  }

  /** Reports a click the follower ended. */
  private finish(click: ClickWindow, reason: ClickEndReason): void {
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
    try {
      Object.assign(data, stateEnd(click, this.host.root));
    } catch {
      /* State that cannot be read is left out. */
    }
    if (click.effect) {
      try {
        this.host.effects?.finish(click.effect, data, reason, click.id);
      } catch {
        /* A check failing must never affect capture. */
      }
    }
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

/** Most elements a click follows for state: changed attributes, and added or removed subtrees. */
const MAX_TRACKED = 1000;

/**
 * Records what a click's state comparison needs from the observer: each state
 * attribute's value before its first change, and the subtrees added or
 * removed, with whether each was in the page when the click began (its first
 * record says). Nothing is scanned on the click path itself.
 */
function trackState(click: ClickWindow, records: MutationRecord[]): void {
  for (let i = 0; i < records.length && i < 256; i++) {
    const record = records[i];
    if (record.type === "childList") {
      const note = (nodes: NodeList, present: boolean) => {
        for (let j = 0; j < nodes.length && j < 64; j++) {
          const node = nodes[j];
          if (node instanceof Element && !click.moved.has(node) && click.moved.size < MAX_TRACKED)
            click.moved.set(node, present);
        }
      };
      note(record.removedNodes, true);
      note(record.addedNodes, false);
      continue;
    }
    const name = record.attributeName;
    if (record.type !== "attributes" || !name || !STATE_ATTRIBUTE_SET.has(name)) continue;
    const target = record.target as Element;
    let byName = click.attributeTrack.get(target);
    if (!byName) {
      if (click.attributeTrack.size >= MAX_TRACKED) continue;
      click.attributeTrack.set(target, (byName = new Map()));
    }
    const on = attributeOn(name, record.oldValue);
    const seen = byName.get(name);
    if (!seen) byName.set(name, { value: record.oldValue, first: on, moved: false });
    // A later record's old value is the value an earlier change set.
    else if (on !== seen.first) seen.moved = true;
  }
}

/** Reads what a click's state is compared against: the clicked control and its group only. */
function stateBegin(click: ClickWindow, root: Element): void {
  const clicked = click.target ?? click.control;
  click.clickedBefore = stateBits(clicked, null) & CLAIMED;
  const group = groupOf(clicked);
  if (group && root.contains(group)) {
    click.group = group;
    click.groupIndex = Array.prototype.indexOf.call(root.querySelectorAll(GROUP), group);
    click.markedBefore = markedIn(group);
  }
}

/** State fields of ui.click.settled (1.5.0): counts and booleans only. */
function stateEnd(click: ClickWindow, root: Element): Partial<ClickSettledData> {
  const clicked = click.target ?? click.control;
  const inPage = (element: Element) => element.isConnected && root.contains(element);
  // Was it in the page when the click began? An element under an added or removed subtree takes that subtree's answer.
  const presentAtBegin = (element: Element): boolean => {
    for (let at: Element | null = element, steps = 0; at && steps < 256; at = at.parentElement, steps++) {
      const present = click.moved.get(at);
      if (present !== undefined) return present;
    }
    return inPage(element);
  };
  const before = (element: Element): number => {
    if (element === clicked) return click.clickedBefore;
    if (!presentAtBegin(element)) return 0;
    const changed = click.attributeTrack.get(element);
    const read = changed
      ? (name: string) => (changed.has(name) ? changed.get(name)!.value : element.getAttribute(name))
      : undefined;
    return stateBits(element, null, undefined, read) & CLAIMED;
  };
  const after = (element: Element): number => (inPage(element) ? stateBits(element, null) & CLAIMED : 0);
  const candidates = new Set<Element>(click.attributeTrack.keys());
  for (const node of click.moved.keys())
    for (const element of statefulIn(node, MAX_TRACKED)) {
      if (candidates.size >= 4 * MAX_TRACKED) break;
      candidates.add(element);
    }
  candidates.add(clicked);
  let changes = 0;
  for (const element of candidates) if (before(element) !== after(element)) changes++;
  let reverted = false;
  for (const [element, byName] of click.attributeTrack)
    for (const [name, seen] of byName)
      if (seen.moved && attributeOn(name, element.getAttribute(name)) === seen.first) reverted = true;
  const out: Partial<ClickSettledData> = {
    state_changes: Math.min(MAX_COUNT, changes),
    clicked_state_changed: after(clicked) !== click.clickedBefore,
    state_reverted: reverted,
  };
  if (click.markedBefore !== null) {
    // A group replaced while the click was open is found again by its position among groups.
    let group: Element | null = click.group;
    if (!group || !inPage(group))
      group = click.groupIndex >= 0 ? root.querySelectorAll(GROUP)[click.groupIndex] ?? null : null;
    out.marked_before = click.markedBefore;
    if (group) out.marked_after = markedIn(group);
  }
  const links = linksHereIn(root);
  out.links_here_after = links.links;
  out.links_here_marked_after = links.marked;
  return out;
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

/**
 * Effect contracts: a control declares in its markup what a click must leave
 * behind, and click follow-through checks it at settle and again on the next
 * page load in the same tab.
 *
 * - `data-interaction-removes`: empty for the nearest ancestor
 *   `[data-interaction-item]`, else a space-separated list of test IDs.
 * - `data-interaction-adds="<test id> …"`.
 * - `data-interaction-sets="<test id>:<state> …"`, `<state>` one of `checked`,
 *   `pressed`, `expanded`, `selected` or `data-state=<literal>`.
 * - `data-interaction-saves="<field test id> …"`.
 *
 * Test IDs, item keys, state literals and field values are compared in the
 * page and never recorded. What waits for the next load is kept in
 * `sessionStorage` as salted SHA-256 hashes (the salt is made per page load),
 * counts and a deadline; nothing of it is sent.
 */
import { EFFECTS, effectFailed, type EffectKind, type EffectObservation } from "./detect/effect";
import { sha256HexSync } from "./detect/fingerprint";
import type { ClickEndReason, ClickSettledData } from "./types";

export const EFFECT_MARKERS =
  "[data-interaction-removes],[data-interaction-adds],[data-interaction-sets],[data-interaction-saves]";
/** The `sessionStorage` key holding expectations for the next page load. */
export const EFFECT_STORE_KEY = "codepress-interactions:effects";
/** Expectations kept for the next load, newest last. */
const MAX_PENDING = 16;
/** How long an expectation waits for a load of the same page. */
export const EFFECT_PENDING_MS = 10 * 60_000;
const MAX_TARGETS = 16;
const MAX_ATTRIBUTE = 1024;
/** Elements whose IDs are hashed on the next load, per kind. */
const MAX_SCAN = 5000;
/** Recounts of removal targets while one click is open. */
const MAX_RECOUNTS = 100;
const FIELDS = "input,textarea,select,[contenteditable=''],[contenteditable='true']";

const STATES = ["checked", "pressed", "expanded", "selected"] as const;
/** 1 checked, 2 pressed, 3 expanded, 4 selected, 5 data-state. */
type StateKind = 1 | 2 | 3 | 4 | 5;
interface State {
  kind: StateKind;
  /** The `data-state` literal (kind 5). Memory only. */
  literal: string | null;
}

type Target = { kind: "item"; key: string; node: Element } | { kind: "id"; id: string };

/** One open click's contract. Holds raw IDs and values in memory only. */
export interface EffectWatch {
  effect: EffectKind;
  targets: Target[];
  /** Matching elements per target at the click. */
  before: number[];
  /** Per target: it matched fewer elements than at the click at some point while the click was open. */
  dipped: boolean[];
  recounts: number;
  /** sets: the state per target. */
  states: State[];
  /** saves: each found field's ID and its value at the click. */
  fields: { id: string; value: string }[];
}

/** An expectation for the next load, as stored. Hashes, counts and booleans only. */
interface Pending {
  v: 1;
  /** The salt of the load that made it. */
  s: string;
  /** Its number within that load. */
  i: number;
  /** Hash of the page path. */
  p: string;
  /** Deadline, epoch ms. */
  d: number;
  /** control_id, the same value the click's events carry. */
  c: string;
  e: EffectKind;
  /** removes, adds, sets: [hash of the target, matches at the click]. */
  t?: [string, number][];
  /** sets: [state kind, hash of the data-state literal or null], per target. */
  k?: [StateKind, string | null][];
  /** saves: [hash of the field ID, hash of its value at the click]. */
  f?: [string, string][];
  /** What was measured at the click. */
  m: {
    expected: number;
    present_at_settle: boolean | null;
    vanished_then_returned: boolean | null;
    request_count: number;
    request_failed_count: number;
    first_feedback_ms: number | null;
    settle_ms: number;
  };
}

export interface EffectHost {
  root: Element;
  /** Quiet time (no DOM change, no observed request in flight) before a reload's expectation can fail. */
  settleMs: number;
  route(): string | null;
  snapshotHash(): string | null;
  emit(observation: EffectObservation): void;
}

/** A double-quoted CSS attribute value. */
const quoted = (value: string): string => `"${value.replace(/["\\]/g, "\\$&").replace(/\n/g, "\\a ")}"`;
const words = (value: string): string[] => value.split(/\s+/).filter(Boolean).slice(0, MAX_TARGETS);
/** Present: in the DOM and not under a `hidden` attribute. */
const present = (element: Element): boolean => !element.closest("[hidden]");

function randomSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const hash = (salt: string, kind: string, value: string): string =>
  sha256HexSync(`${salt}\u0000${kind}\u0000${value}`).slice(0, 32);

function storage(): Storage | null {
  try {
    const store = window.sessionStorage;
    return store ?? null;
  } catch {
    return null;
  }
}

function readPending(): Pending[] {
  try {
    const raw = storage()?.getItem(EFFECT_STORE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is Pending => !!entry && typeof entry === "object" && (entry as Pending).v === 1)
      : [];
  } catch {
    return [];
  }
}

function writePending(entries: Pending[]): void {
  try {
    const store = storage();
    if (!store) return;
    if (entries.length) store.setItem(EFFECT_STORE_KEY, JSON.stringify(entries.slice(-MAX_PENDING)));
    else store.removeItem(EFFECT_STORE_KEY);
  } catch {
    /* Full or blocked storage: no reload check. */
  }
}

/** The text field, select or editable region a test ID names: the element itself or the first one inside it. */
function fieldOf(element: Element): Element | null {
  return element.matches(FIELDS) ? element : element.querySelector(FIELDS);
}

/** A field's value, in memory only; null for password fields, which are never read. */
function valueOf(field: Element): string | null {
  if (field instanceof HTMLInputElement) {
    if (field.type === "password") return null;
    if (field.type === "checkbox" || field.type === "radio") return field.checked ? "\u0001on" : "\u0001off";
    return field.value;
  }
  if (field instanceof HTMLTextAreaElement) return field.value;
  if (field instanceof HTMLSelectElement) return Array.from(field.selectedOptions, (option) => option.value).join("\n");
  return field.textContent ?? "";
}

function stateHeld(element: Element, state: State, literalHash?: (value: string) => string): boolean {
  if (state.kind === 5) {
    const value = element.getAttribute("data-state");
    if (value === null) return false;
    return literalHash ? literalHash(value) === state.literal : value === state.literal;
  }
  const attribute = `aria-${STATES[state.kind - 1]}`;
  const aria = element.getAttribute(attribute);
  if (aria === null && state.kind === 1 && element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio"))
    return element.checked;
  return aria === "true";
}

function parseState(value: string): State | null {
  const index = (STATES as readonly string[]).indexOf(value);
  if (index >= 0) return { kind: (index + 1) as StateKind, literal: null };
  if (value.startsWith("data-state=")) return { kind: 5, literal: value.slice("data-state=".length) };
  return null;
}

export class EffectContracts {
  /** Made per page load; stored with each expectation so the next load can hash with it. Never sent. */
  private readonly salt = randomSalt();
  /** Numbers this load's expectations, so one can be removed from storage by identity. */
  private sequence = 0;
  /** Expectations from earlier loads of this page, not decided yet. */
  private waiting: Pending[];
  private watching = false;
  private stopped = false;
  private observer?: MutationObserver;
  private quietTimer?: ReturnType<typeof setTimeout>;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private inflight = 0;

  constructor(private host: EffectHost) {
    this.waiting = this.load();
  }

  /** Elements under the root with an ID attribute equal to `id`, as written. */
  private byTestId(id: string): Element[] {
    const value = quoted(id);
    return Array.from(this.host.root.querySelectorAll(`[data-testid=${value}],[data-interaction-id=${value}]`));
  }

  private matching(target: Target): Element[] {
    if (target.kind === "id") return this.byTestId(target.id).filter(present);
    if (!target.key) {
      const node = target.node;
      return node.isConnected && this.host.root.contains(node) && present(node) ? [node] : [];
    }
    // By key, never by node: a row re-rendered as a new element is still the same item.
    return Array.from(this.host.root.querySelectorAll(`[data-interaction-item=${quoted(target.key)}]`)).filter(present);
  }

  /**
   * Reads the contract of a click on `control` that started at `origin`. The
   * marker is on the control or on an element inside it. Null without one.
   */
  begin(control: Element, origin: EventTarget | null | undefined): EffectWatch | null {
    const start = origin instanceof Element ? origin : control;
    const marked = start.closest(EFFECT_MARKERS);
    if (!marked || !(marked === control || control.contains(marked))) return null;
    const attribute = (name: string) => {
      const value = marked.getAttribute(name);
      return value === null ? null : value.slice(0, MAX_ATTRIBUTE);
    };
    const watch: EffectWatch = { effect: EFFECTS.removes, targets: [], before: [], dipped: [], recounts: 0, states: [], fields: [] };
    const removes = attribute("data-interaction-removes");
    const adds = attribute("data-interaction-adds");
    const sets = attribute("data-interaction-sets");
    const saves = attribute("data-interaction-saves");
    if (removes !== null) {
      watch.effect = EFFECTS.removes;
      if (removes.trim()) watch.targets = words(removes).map((id) => ({ kind: "id", id }));
      else {
        const item = marked.closest("[data-interaction-item]");
        if (!item) return null;
        watch.targets = [{ kind: "item", key: item.getAttribute("data-interaction-item") ?? "", node: item }];
      }
    } else if (adds !== null) {
      watch.effect = EFFECTS.adds;
      watch.targets = words(adds).map((id) => ({ kind: "id", id }));
    } else if (sets !== null) {
      watch.effect = EFFECTS.sets;
      for (const entry of words(sets)) {
        const match = /^(.+):(checked|pressed|expanded|selected|data-state=.*)$/.exec(entry);
        const state = match ? parseState(match[2]) : null;
        if (!match || !state) continue;
        watch.targets.push({ kind: "id", id: match[1] });
        watch.states.push(state);
      }
    } else if (saves !== null) {
      watch.effect = EFFECTS.saves;
      for (const id of words(saves)) {
        const element = this.byTestId(id)[0];
        const field = element ? fieldOf(element) : null;
        const value = field ? valueOf(field) : null;
        if (value !== null) watch.fields.push({ id, value });
      }
      return watch.fields.length ? watch : null;
    }
    if (!watch.targets.length) return null;
    watch.before = watch.targets.map((target) => this.matching(target).length);
    watch.dipped = watch.targets.map(() => false);
    // Removing what is not there cannot be judged.
    if (watch.effect === EFFECTS.removes) {
      const keep = watch.before.map((count) => count > 0);
      watch.targets = watch.targets.filter((_, i) => keep[i]);
      watch.before = watch.before.filter((_, i) => keep[i]);
      watch.dipped = watch.dipped.filter((_, i) => keep[i]);
      if (!watch.targets.length) return null;
    }
    return watch;
  }

  /** Mutations while the click is open: a removal target that leaves and comes back is noticed. */
  records(watch: EffectWatch, records: readonly MutationRecord[]): void {
    if (watch.effect !== EFFECTS.removes || watch.recounts >= MAX_RECOUNTS) return;
    let relevant = false;
    for (const record of records)
      if (record.removedNodes.length || (record.type === "attributes" && record.attributeName === "hidden")) {
        relevant = true;
        break;
      }
    if (!relevant) return;
    watch.recounts++;
    watch.targets.forEach((target, i) => {
      if (!watch.dipped[i] && this.matching(target).length < watch.before[i]) watch.dipped[i] = true;
    });
  }

  /**
   * The click ended. A settled window that did not navigate, overlap or open a
   * dialog is judged now; when its effect held, or the window was cut short by
   * the page going away, an expectation waits for the next load.
   */
  finish(watch: EffectWatch, data: ClickSettledData, reason: ClickEndReason, interactionId: string): void {
    if (data.overlapped || data.route_changed || data.dialog_opened) return;
    const clicked = {
      request_count: data.request_count,
      request_failed_count: data.request_failed_count,
      first_feedback_ms: data.first_feedback_ms,
      settle_ms: data.settle_ms,
    };
    if (reason === "page_hidden") {
      this.keep(watch, data.control_id, { ...clicked, present_at_settle: null, vanished_then_returned: null });
      return;
    }
    if (reason !== "settled" || data.incomplete) return;
    const observation = this.observe(watch, data.control_id, interactionId, clicked);
    if (!observation) return;
    if (effectFailed(observation)) this.host.emit(observation);
    else
      this.keep(watch, data.control_id, {
        ...clicked,
        present_at_settle: observation.present_at_settle,
        vanished_then_returned: observation.vanished_then_returned,
      });
  }

  private base(controlId: string, interactionId: string | null, effect: EffectKind): EffectObservation {
    return {
      control_id: controlId,
      route_template: this.host.route(),
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight,
      snapshot_sha256: this.host.snapshotHash(),
      interaction_id: interactionId,
      effect,
      expected_removed: null,
      expected_added: null,
      state_held: null,
      fields_saved: null,
      fields_reverted: null,
      present_at_settle: null,
      vanished_then_returned: null,
      present_after_reload: null,
      matches: null,
      request_count: null,
      request_failed_count: null,
      first_feedback_ms: null,
      settle_ms: null,
      dialog_opened: false,
    };
  }

  /** The settle judgment; null when nothing could be judged (no named element was found). */
  private observe(
    watch: EffectWatch,
    controlId: string,
    interactionId: string,
    clicked: Pick<EffectObservation, "request_count" | "request_failed_count" | "first_feedback_ms" | "settle_ms">,
  ): EffectObservation | null {
    const observation = { ...this.base(controlId, interactionId, watch.effect), ...clicked };
    if (watch.effect === EFFECTS.saves) {
      let found = 0;
      let reverted = 0;
      for (const { id, value } of watch.fields) {
        const element = this.byTestId(id)[0];
        const field = element ? fieldOf(element) : null;
        const now = field ? valueOf(field) : null;
        if (now === null) continue;
        found++;
        if (now !== value) reverted++;
      }
      if (!found) return null;
      observation.fields_saved = watch.fields.length;
      observation.fields_reverted = reverted;
      observation.matches = found;
      return observation;
    }
    const after = watch.targets.map((target) => this.matching(target));
    observation.matches = after.reduce((sum, elements) => sum + elements.length, 0);
    if (watch.effect === EFFECTS.sets) {
      let judged = 0;
      let held = true;
      after.forEach((elements, i) => {
        if (!elements.length) return;
        judged++;
        if (!elements.every((element) => stateHeld(element, watch.states[i]))) held = false;
      });
      if (!judged) return null;
      observation.state_held = held;
      return observation;
    }
    if (watch.effect === EFFECTS.removes) {
      observation.expected_removed = watch.targets.length;
      // Missing from the DOM counts as removed (a virtualized list may simply not render it).
      const stayed = after.map((elements, i) => elements.length >= watch.before[i]);
      observation.present_at_settle = stayed.some(Boolean);
      observation.vanished_then_returned = stayed.some((still, i) => still && watch.dipped[i]);
      return observation;
    }
    observation.expected_added = watch.targets.length;
    observation.present_at_settle = after.every((elements, i) => elements.length > watch.before[i]);
    return observation;
  }

  /** Stores an expectation for the next load of this page. */
  private keep(watch: EffectWatch, controlId: string, measured: Omit<Pending["m"], "expected">): void {
    const store = storage();
    if (!store) return;
    const salt = this.salt;
    const entry: Pending = {
      v: 1,
      s: salt,
      i: ++this.sequence,
      p: hash(salt, "path", location.pathname),
      d: Date.now() + EFFECT_PENDING_MS,
      c: controlId,
      e: watch.effect,
      m: { ...measured, expected: 0 },
    };
    if (watch.effect === EFFECTS.saves) {
      entry.f = watch.fields.map(({ id, value }) => [hash(salt, "id", id), hash(salt, "value", value)]);
      entry.m.expected = entry.f.length;
    } else {
      const t: [string, number][] = [];
      const k: [StateKind, string | null][] = [];
      watch.targets.forEach((target, i) => {
        // An item without a key is known only by its node, which a reload replaces.
        if (target.kind === "item" && !target.key) return;
        t.push([target.kind === "item" ? hash(salt, "item", target.key) : hash(salt, "id", target.id), watch.before[i]]);
        const state = watch.states[i];
        if (state) k.push([state.kind, state.literal === null ? null : hash(salt, "state", state.literal)]);
      });
      if (!t.length) return;
      entry.t = t;
      if (watch.effect === EFFECTS.sets) entry.k = k;
      entry.m.expected = t.length;
    }
    const now = Date.now();
    writePending([...readPending().filter((pending) => pending.d > now), entry]);
  }

  /**
   * On the next load, an expectation is decided only on evidence:
   *
   * - It passes as soon as the effect is seen holding: the added target, the
   *   state or every saved value is there. An absent removal target is not
   *   evidence before the page is quiet (the list may not have loaded yet).
   * - It fails only when the effect still does not hold once the page has been
   *   quiet (no DOM change, no observed request in flight) for `settleMs`.
   * - Targets that never appear, or a page that never goes quiet, decide
   *   nothing: the expectation is dropped at its deadline with no finding.
   *
   * Looks happen after each settled snapshot from the first one on, and each
   * time the page goes quiet. Undecided expectations stay in storage, so a
   * further reload carries on with them.
   */
  settled(): void {
    if (!this.waiting.length || this.stopped) return;
    if (!this.watching) this.watchQuiet();
    this.evaluate(false);
  }

  /** An observed request started; returns its completion callback. Quiet waits for it. */
  requestStarted(): () => void {
    if (!this.waiting.length || this.stopped) return () => {};
    this.inflight++;
    clearTimeout(this.quietTimer);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.inflight = Math.max(0, this.inflight - 1);
      this.activity();
    };
  }

  stop(): void {
    this.stopped = true;
    this.unwatch();
  }

  /** The expectations an earlier load of this page in this tab left; expired ones are removed from storage. */
  private load(): Pending[] {
    try {
      const entries = readPending();
      if (!entries.length) return [];
      const now = Date.now();
      const live = entries.filter((entry) => typeof entry.d === "number" && entry.d > now && typeof entry.s === "string");
      if (live.length !== entries.length) writePending(live);
      return live.filter((entry) => entry.s !== this.salt && entry.p === hash(entry.s, "path", location.pathname));
    } catch {
      return [];
    }
  }

  private watchQuiet(): void {
    this.watching = true;
    this.observer = new MutationObserver(() => this.activity());
    this.observer.observe(this.host.root, { subtree: true, childList: true, attributes: true, characterData: true });
    this.activity();
    const deadline = Math.min(...this.waiting.map((entry) => entry.d));
    this.deadlineTimer = setTimeout(() => this.evaluate(false), Math.max(0, deadline - Date.now()) + 1);
  }

  private unwatch(): void {
    this.watching = false;
    this.observer?.disconnect();
    this.observer = undefined;
    clearTimeout(this.quietTimer);
    clearTimeout(this.deadlineTimer);
  }

  /** Something happened: the page is quiet again `settleMs` after the last change with no request in flight. */
  private activity(): void {
    if (!this.watching) return;
    clearTimeout(this.quietTimer);
    if (this.inflight > 0) return;
    this.quietTimer = setTimeout(() => this.evaluate(true), this.host.settleMs);
  }

  private evaluate(quiet: boolean): void {
    if (this.stopped) return;
    const now = Date.now();
    const indexes = new Map<string, Map<string, Element[]>>();
    const decided: Pending[] = [];
    for (const entry of this.waiting) {
      // Past its deadline: undecided means unknown, not failed.
      if (entry.d <= now) {
        decided.push(entry);
        continue;
      }
      let index = indexes.get(entry.s);
      if (!index) indexes.set(entry.s, (index = this.index(entry.s)));
      let judged: Judged;
      try {
        judged = this.judge(entry, index);
      } catch {
        // A malformed entry is dropped.
        decided.push(entry);
        continue;
      }
      if (judged.verdict === "held" && (quiet || judged.confirmed)) decided.push(entry);
      else if (judged.verdict === "failed" && quiet) {
        decided.push(entry);
        this.host.emit(judged.observation);
      }
    }
    if (!decided.length) return;
    this.waiting = this.waiting.filter((entry) => !decided.includes(entry));
    writePending(readPending().filter((entry) => !decided.some((done) => done.s === entry.s && done.i === entry.i)));
    if (!this.waiting.length) this.unwatch();
  }

  /** Elements under the root by hashed item key and hashed test ID, with one load's salt. */
  private index(salt: string): Map<string, Element[]> {
    const index = new Map<string, Element[]>();
    const hashes = new Map<string, string>();
    const add = (kind: string, value: string, element: Element) => {
      const key = `${kind}\u0000${value}`;
      let digest = hashes.get(key);
      if (digest === undefined) hashes.set(key, (digest = hash(salt, kind, value)));
      const list = index.get(digest);
      if (!list) index.set(digest, [element]);
      else if (list[list.length - 1] !== element) list.push(element);
    };
    const items = this.host.root.querySelectorAll("[data-interaction-item]");
    for (let i = 0; i < items.length && i < MAX_SCAN; i++) add("item", items[i].getAttribute("data-interaction-item") ?? "", items[i]);
    const ids = this.host.root.querySelectorAll("[data-testid],[data-interaction-id]");
    for (let i = 0; i < ids.length && i < MAX_SCAN; i++) {
      for (const name of ["data-interaction-id", "data-testid"]) {
        const value = ids[i].getAttribute(name);
        if (value) add("id", value, ids[i]);
      }
    }
    return index;
  }

  /** What the page shows now for one expectation. */
  private judge(entry: Pending, index: Map<string, Element[]>): Judged {
    const observation: EffectObservation = {
      ...this.base(entry.c, null, entry.e),
      request_count: entry.m.request_count,
      request_failed_count: entry.m.request_failed_count,
      first_feedback_ms: entry.m.first_feedback_ms,
      settle_ms: entry.m.settle_ms,
      present_at_settle: entry.m.present_at_settle,
      vanished_then_returned: entry.m.vanished_then_returned,
    };
    const unknown: Judged = { verdict: "unknown", confirmed: false, observation };
    const found = (digest: string) => (index.get(digest) ?? []).filter(present);
    if (entry.e === EFFECTS.saves) {
      if (!Array.isArray(entry.f) || !entry.f.length) return unknown;
      let seen = 0;
      let reverted = 0;
      for (const [id, saved] of entry.f) {
        const element = found(id)[0];
        const field = element ? fieldOf(element) : null;
        const value = field ? valueOf(field) : null;
        if (value === null) continue;
        seen++;
        if (hash(entry.s, "value", value) !== saved) reverted++;
      }
      observation.fields_saved = entry.f.length;
      observation.fields_reverted = reverted;
      observation.matches = seen;
      if (reverted > 0) return { verdict: "failed", confirmed: false, observation };
      return seen === entry.f.length ? { verdict: "held", confirmed: true, observation } : unknown;
    }
    if (!Array.isArray(entry.t) || !entry.t.length) return unknown;
    const after = entry.t.map(([digest]) => found(digest));
    observation.matches = after.reduce((sum, elements) => sum + elements.length, 0);
    if (entry.e === EFFECTS.sets) {
      if (!Array.isArray(entry.k)) return unknown;
      let judged = 0;
      let held = true;
      after.forEach((elements, i) => {
        const [kind, literal] = entry.k![i] ?? [];
        if (!elements.length || !kind) return;
        judged++;
        const state: State = { kind, literal: literal ?? null };
        if (!elements.every((element) => stateHeld(element, state, (value) => hash(entry.s, "state", value)))) held = false;
      });
      if (!held) {
        observation.state_held = false;
        return { verdict: "failed", confirmed: false, observation };
      }
      observation.state_held = true;
      return judged === entry.t.length ? { verdict: "held", confirmed: true, observation } : unknown;
    }
    if (entry.e === EFFECTS.removes) {
      observation.expected_removed = entry.t.length;
      observation.present_after_reload = after.some((elements, i) => elements.length >= entry.t![i][1]);
      // Absent counts as removed only once the page is quiet.
      return { verdict: observation.present_after_reload ? "failed" : "held", confirmed: false, observation };
    }
    if (entry.e !== EFFECTS.adds) return unknown;
    observation.expected_added = entry.t.length;
    observation.present_after_reload = after.every((elements, i) => elements.length > entry.t![i][1]);
    if (observation.present_after_reload) return { verdict: "held", confirmed: true, observation };
    // A target with no element at all has not been rendered: unknown, not lost.
    if (after.some((elements) => elements.length === 0)) return unknown;
    return { verdict: "failed", confirmed: false, observation };
  }
}

interface Judged {
  verdict: "held" | "failed" | "unknown";
  /** A hold seen before the page is quiet still counts (it is positive evidence). */
  confirmed: boolean;
  observation: EffectObservation;
}

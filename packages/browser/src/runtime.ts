import { ClickEffects } from "./click-effects";
import { checkEvents, checkSnapshot } from "./detect/index";
import type { TimelineEvent } from "./detect/timeline";
import { toFindingData, type Finding } from "./detect/types";
import type { SnapshotBody } from "./format";
import { PerfSignals } from "./perf";
import {
  callSink,
  createHttpSink,
  type InteractionSink,
  type SinkResult,
  type SinkSnapshot,
} from "./sink";
import {
  CHECK_EVERY,
  INTERACTIVE,
  encodeSnapshot,
  walkSnapshot,
  type SnapshotSummary,
} from "./snapshot";
import { SnapshotTriggers } from "./triggers";
import type {
  Batch,
  ClickSettledData,
  Diagnostics,
  EventType,
  EvidenceEvent,
  InteractionHandle,
  InteractionOptions,
  LegacyData,
  SnapshotEventData,
  SnapshotTrigger,
} from "./types";
import {
  VERSION,
  clampMs,
  defaultRouteTemplate,
  elementTestId,
  routeSegmentSet,
  numberOption,
  safeHeaderName,
  safeIdentifier,
  safeLabel,
  safeRelease,
  safeRoute,
  safeTraceId,
  sha256Hex,
  validInteractionId,
  RecentKeys,
  type TestIdFilter,
} from "./util";

const ATTRIBUTION = "explicit synchronous runAction only" as const;
const CONTROLS = "button,a,form,input[type=submit],[role=button]";
const MAX_SENT_HASHES = 1000;
const MAX_PENDING_SNAPSHOTS = 4;
/** Fingerprints remembered per page session; past this the least recently seen may be sent again. */
const MAX_FINDINGS = 2000;
/** Events kept for the click and stability checks. */
const MAX_TIMELINE = 500;
/** What a click counts as having hit, for grouping rage clicks. */
const TARGETS = `${INTERACTIVE},label`;
/**
 * HTML interactive content: a click on one of these inside a <label> is not
 * forwarded to the label's field. Focusable spans and ARIA roles still are.
 */
const LABEL_INTERACTIVE =
  "a[href],button,input:not([type=hidden]),select,textarea,label,details,embed,iframe,img[usemap],audio[controls],video[controls]";
/** Form-associated fields whose form owner can differ from their DOM ancestor form (the `form` attribute). */
const FORM_FIELDS = "input,select,textarea,button";

/**
 * The tracked control a click on `element` belongs to: the nearest control
 * above it, except that a field joined to a form with the `form` attribute
 * belongs to that form, wherever it sits in the DOM.
 */
function controlOf(element: Element | null): Element | null {
  if (!element) return null;
  const found = element.closest(CONTROLS);
  if (found && found.tagName !== "FORM") return found;
  const owner = element.matches(FORM_FIELDS) ? (element as HTMLInputElement).form : null;
  return owner ?? found;
}
const TIMELINE_TYPES = new Set(["interaction.started", "ui.click.settled", "ui.state.changed", "perf.summary", "ui.snapshot"]);

type EventData = EvidenceEvent["data"];
interface PendingSnapshot extends SinkSnapshot {
  attempts: number;
  nextAt: number;
}

export class Runtime {
  readonly root: Element;
  private queue: EvidenceEvent[] = [];
  private pending: {
    batch: Batch;
    serialized: string;
    attempts: number;
    nextAt: number;
  } | null = null;
  active = true;
  private references = 0;
  private sequence = 0;
  private sourceId = crypto.randomUUID();
  private context: string | null = null;
  private originalFetch = window.fetch;
  /** Above 0 while a sink call runs synchronously: its own requests are not the app's. */
  sinkDepth = 0;
  private sinkFetch: typeof fetch = (input, init) => this.originalFetch.call(window, input, init);
  private requestTarget = Object.getOwnPropertyDescriptor(Request.prototype, "url")!.get!;
  private requestHeaders = Object.getOwnPropertyDescriptor(Request.prototype, "headers")!.get!;
  private wrappedFetch?: typeof fetch;
  private observer?: MutationObserver;
  private timer?: ReturnType<typeof setInterval>;
  private sending: Promise<void> | null = null;
  private stopController = new AbortController();
  private removals: (() => void)[] = [];
  private allowed: Set<string>;
  private ingestBase: string | null;
  private sink: InteractionSink;
  private header: string | null;
  private readHeader: string;
  private release: string | null;
  private dropped = 0;
  private accepted = 0;
  private failed = 0;
  private lastError: string | null = null;
  private maxQueue: number;
  private maxBatch: number;
  private maxBytes: number;
  private retries: number;
  private timeoutMs: number;
  private perf = new PerfSignals();
  private clicks?: ClickEffects;
  private triggers?: SnapshotTriggers;
  private reportedSignals = false;
  // Snapshots
  private snapshotsEnabled: boolean;
  private snapshotChain: Promise<unknown> = Promise.resolve();
  private queuedSnapshot: Promise<SnapshotSummary | null> | null = null;
  private currentHash: string | null = null;
  private sentHashes = new Set<string>();
  private snapshotQueue: PendingSnapshot[] = [];
  private draining: Promise<void> | null = null;
  private uploading: PendingSnapshot | null = null;
  private routeWords?: ReadonlySet<string>;
  private snapshotStats = { taken: 0, uploaded: 0, deduplicated: 0, skipped: 0 };
  private lastSnapshot: SnapshotSummary | null = null;
  private walks = 0;
  // Findings
  private findingsEnabled: boolean;
  private sentFindings = new RecentKeys(MAX_FINDINGS);
  private timeline: TimelineEvent[] = [];
  private timelineScheduled = false;
  /** Per page session: the clicked element's opaque key, so rage clicks group by element. */
  private targetKeys = new WeakMap<Element, number>();
  private nextTargetKey = 1;
  /** The host's `testId` hook; undefined uses `defaultTestIdFilter`. */
  private readonly testIdFilter: TestIdFilter | undefined;

  constructor(
    private options: InteractionOptions,
    endpoint: URL | null,
    readonly signature: string,
    readonly identity: unknown[],
  ) {
    this.root = options.root ?? document.documentElement;
    this.ingestBase = endpoint ? endpoint.href.replace(/\/$/, "") : null;
    this.sink =
      options.sink ??
      createHttpSink(this.ingestBase!, options.projectKey!, this.originalFetch);
    this.allowed = new Set(
      (options.allowedApiOrigins ?? [location.origin]).map(
        (origin) => new URL(origin).origin,
      ),
    );
    this.maxQueue = numberOption(options.maxQueueEvents, 1000, 10000);
    this.maxBatch = numberOption(options.maxBatchEvents, 100, 200);
    this.maxBytes = numberOption(options.maxBatchBytes, 60000, 60000);
    this.retries = options.maxRetries === 0 ? 0 : numberOption(options.maxRetries, 3, 20);
    this.timeoutMs = numberOption(options.requestTimeoutMs, 10000, 120000);
    this.header =
      options.propagateHeader === false
        ? null
        : (safeHeaderName(options.propagateHeader) ?? "X-Interaction-Id");
    this.readHeader = this.header ?? "X-Interaction-Id";
    this.release = safeRelease(options.release);
    this.snapshotsEnabled =
      options.snapshots !== false &&
      typeof crypto !== "undefined" &&
      typeof crypto.subtle?.digest === "function";
    this.findingsEnabled = options.findings !== false;
    this.testIdFilter = typeof options.testId === "function" ? options.testId : undefined;
  }

  lease(): InteractionHandle {
    this.references++;
    let released = false;
    return {
      flush: () => (released ? Promise.resolve() : this.flush()),
      shutdown: () => {
        if (!released) {
          released = true;
          if (--this.references === 0) this.stop();
        }
      },
      getDiagnostics: () => this.diagnostics(),
      snapshot: () =>
        released ? Promise.resolve(null) : this.requestSnapshot("manual"),
      runAction: (name, callback) => {
        if (released || !this.active)
          return callback({
            interactionId: "",
            fetch: (...args) => window.fetch(...args),
          });
        const id = crypto.randomUUID();
        this.record("interaction.started", id, {
          action: safeIdentifier(name) ?? "custom_action",
        });
        const previous = this.context;
        this.context = id;
        try {
          return callback({
            interactionId: id,
            fetch: (input, init) => this.instrumentFetch(input, init, id),
          });
        } finally {
          this.context = previous;
        }
      },
    };
  }

  private diagnostics(): Diagnostics {
    return {
      enabled: this.active,
      queuedEvents: this.queue.length + (this.pending?.batch.events.length ?? 0),
      droppedEvents: this.dropped,
      acceptedBatches: this.accepted,
      failedBatches: this.failed,
      lastError: this.lastError,
      adapters: this.active
        ? [
            "dom",
            "navigation",
            "fetch",
            "xhr",
            ...(this.snapshotsEnabled ? ["snapshot"] : []),
            "click_effects",
            "performance",
          ]
        : [],
      attribution: ATTRIBUTION,
      snapshots: { ...this.snapshotStats, last: this.lastSnapshot },
      signals: { ...this.perf.available },
    };
  }

  private route(): string | null {
    try {
      const url = new URL(location.href);
      const template = this.options.routeTemplate
        ? this.options.routeTemplate(url)
        : defaultRouteTemplate(url, (this.routeWords ??= routeSegmentSet(this.options.routeSegments)));
      return safeRoute(template);
    } catch {
      return null;
    }
  }

  private record(
    type: EventType,
    id: string | null,
    data: EventData,
    attribution?: EvidenceEvent["attribution"],
  ): void {
    if (!this.active) return;
    try {
      if (this.queue.length + (this.pending?.batch.events.length ?? 0) >= this.maxQueue) {
        this.dropped++;
        return;
      }
      const event: EvidenceEvent = {
        event_id: crypto.randomUUID(),
        schema_version: 2,
        interaction_id: id,
        operation_id: null,
        source: "browser",
        source_instance_id: this.sourceId,
        sequence: ++this.sequence,
        occurred_at: new Date().toISOString(),
        type,
        attribution: attribution ?? (id ? "explicit" : "unknown"),
        data,
      };
      this.queue.push(event);
      if (this.findingsEnabled && TIMELINE_TYPES.has(type)) {
        this.timeline.push(event as TimelineEvent);
        if (this.timeline.length > MAX_TIMELINE) this.timeline.splice(0, this.timeline.length - MAX_TIMELINE);
        if (type === "ui.click.settled" || type === "perf.summary") this.scheduleTimelineChecks();
      }
    } catch {
      this.dropped++;
    }
  }

  start(): void {
    const listen = (
      target: EventTarget,
      type: string,
      listener: EventListener,
      capture = true,
    ) => {
      const guarded: EventListener = (event) => {
        try {
          listener(event);
        } catch {
          /* Host event dispatch must remain unaffected. */
        }
      };
      target.addEventListener(type, guarded, capture);
      this.removals.push(() => target.removeEventListener(type, guarded, capture));
    };
    this.perf.start();
    this.removals.push(() => this.perf.stop());
    this.triggers = this.snapshotsEnabled
      ? new SnapshotTriggers({
          routeSettleMs: numberOption(this.options.routeSettleMs, 1000, 60000),
          resizeSettleMs: numberOption(this.options.resizeSettleMs, 500, 60000),
          visibleSettleMs: numberOption(this.options.visibleSettleMs, 300, 60000),
          run: (trigger) => {
            void this.requestSnapshot(trigger);
          },
        })
      : undefined;
    this.clicks = new ClickEffects({
      root: this.root,
      settleMs: numberOption(this.options.clickSettleMs, 500, 60000),
      timeoutMs: numberOption(this.options.clickTimeoutMs, 10000, 120000),
      perf: this.perf,
      currentHash: () => this.currentHash,
      routeTemplate: () => this.route(),
      snapshotAfter: () =>
        this.snapshotsEnabled
          ? this.requestSnapshot("click").then((summary) => summary?.sha256 ?? null)
          : Promise.resolve(null),
      emit: (id, data: ClickSettledData) =>
        this.record("ui.click.settled", id, data, "inferred"),
    });
    this.clicks.start();
    this.removals.push(() => this.clicks?.stop());

    // A click on a <label> makes the browser click its field in the same task.
    // The label click is recorded as a click on the field's control, and that
    // second click is skipped: one user click, one start, on the control it
    // operates. Any real input (a pointer or key press) ends the window, so a
    // user's next click always counts.
    let labelControl: Element | null = null;
    const endLabelWindow = () => {
      labelControl = null;
    };
    for (const type of ["pointerdown", "keydown"]) {
      document.addEventListener(type, endLabelWindow, { capture: true, passive: true });
      this.removals.push(() => document.removeEventListener(type, endLabelWindow, { capture: true }));
    }
    const control = (event: Event) => {
      const clicked = event.target instanceof Element ? event.target : null;
      let forwarded: Element | null = null;
      let label: Element | null = null;
      if (event.type === "click" && clicked) {
        if (labelControl && clicked === labelControl) {
          labelControl = null;
          return;
        }
        label = clicked.closest("label");
        forwarded = (label as HTMLLabelElement | null)?.control ?? null;
        // The browser forwards nothing for a click on the field itself, on other
        // interactive content inside the label (a link), or to a disabled field.
        const inner = clicked.closest(LABEL_INTERACTIVE);
        if (
          forwarded &&
          (forwarded.contains(clicked) ||
            (inner && inner !== label && label!.contains(inner)) ||
            forwarded.matches(":disabled"))
        )
          forwarded = null;
      }
      // A label click belongs to its field's control (a field can join another
      // form through the `form` attribute); only a field with none falls back
      // to the label's own control.
      const fieldControl = forwarded ? controlOf(forwarded) : null;
      const target = fieldControl ?? controlOf(clicked);
      if (
        !target ||
        !this.root.contains(target) ||
        target.closest("[data-interactions-exclude]")
      )
        return;
      const explicit =
        elementTestId(target, this.testIdFilter);
      // Non-unique structural hint: at most five ancestor tags, never a sibling scan.
      const path: string[] = [];
      for (
        let node: Element | null = target;
        node && node !== this.root && path.length < 5;
        node = node.parentElement
      )
        path.unshift(node.tagName.toLowerCase());
      const id = crypto.randomUUID();
      // The protocol bounds control_id at 128; the end of the path is nearest the control.
      const controlId = explicit ?? path.join("/").slice(-128);
      this.record("interaction.started", id, {
        action: event.type,
        control_id: controlId,
        ...(event.type === "click" && clicked
          ? { target_key: this.targetKey(target, forwarded && label ? label : clicked) }
          : {}),
      });
      if (event.type === "click") this.clicks?.begin(id, controlId, target, event);
      if (forwarded && fieldControl) {
        // Skip the click the browser is about to forward to the field.
        const field = forwarded;
        labelControl = field;
        setTimeout(() => {
          if (labelControl === field) labelControl = null;
        }, 0);
      }
    };
    listen(document, "click", control);
    listen(document, "submit", control);
    const navigation = () => {
      this.record("ui.state.changed", null, { feedback_type: "navigation" });
      this.onRoute();
    };
    listen(window, "popstate", navigation);
    listen(window, "hashchange", () => this.onRoute());
    listen(window, "pagehide", (event) => {
      this.clicks?.pageHidden();
      this.recordPerf();
      // A page kept in the back-forward cache comes back: its findings still
      // wait for a viewport. Only a page that is really going away sends them as they are.
      if (!(event as PageTransitionEvent).persisted) this.runTimelineChecks(true);
      void this.flush(true);
    });
    listen(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") this.clicks?.pageHidden();
    });
    this.startMutationEvidence();
    this.wrappedFetch = (input, init) => this.instrumentFetch(input, init, this.context);
    window.fetch = this.wrappedFetch;
    this.removals.push(() => {
      if (window.fetch === this.wrappedFetch) window.fetch = this.originalFetch;
    });
    for (const name of ["pushState", "replaceState"] as const) {
      const original = history[name];
      const runtime = this;
      const wrapped: History[typeof name] = function (this: History, ...args) {
        const result = original.apply(this, args);
        try {
          runtime.record("ui.state.changed", null, { feedback_type: "navigation" });
          runtime.onRoute();
        } catch {
          /* Navigation must remain unaffected. */
        }
        return result;
      };
      history[name] = wrapped;
      this.removals.push(() => {
        if (history[name] === wrapped) history[name] = original;
      });
    }
    this.patchXHR();
    this.patchWindowOpen();
    this.timer = setInterval(
      () => {
        void this.flush();
      },
      numberOption(this.options.flushIntervalMs, 5000, 3600000),
    );
    this.triggers?.start();
    this.removals.push(() => this.triggers?.stop());
  }

  private onRoute(): void {
    this.clicks?.routeChanged();
    this.triggers?.routeChanged();
  }

  private startMutationEvidence(): void {
    const observerLimit = numberOption(this.options.maxMutationRecords, 50, 1000);
    this.observer = new MutationObserver((records) => {
      let remaining = observerLimit;
      let truncated = false;
      let count = 0;
      let ranHook = false;
      const take = () => {
        if (remaining > 0) {
          remaining--;
          return true;
        }
        truncated = true;
        return false;
      };
      // Ancestor privacy checks also consume the callback budget. An exhausted
      // check cannot establish that a node is public, so it emits no evidence.
      const publicPath = (node: Node): boolean => {
        for (let ancestor: Node | null = node; ancestor; ancestor = ancestor.parentNode) {
          if (!take()) return false;
          if (
            ancestor instanceof Element &&
            ancestor.hasAttribute("data-interactions-exclude")
          )
            return false;
        }
        return true;
      };
      const indicators = (node: Node, phase: "appeared" | "removed") => {
        if (!publicPath(node)) return;
        const pending = [node];
        let first = true;
        while (pending.length) {
          const candidate = pending.pop()!;
          const root = first;
          first = false;
          // publicPath already inspected the root. Every subsequent node,
          // including excluded and non-element nodes, needs its own unit.
          if (!root && !take()) return;
          if (!root && candidate.nextSibling) pending.push(candidate.nextSibling);
          if (candidate instanceof Element) {
            if (!root && candidate.hasAttribute("data-interactions-exclude")) continue;
            if (
              candidate.matches(
                'progress,[role="progressbar"],[role="status"],[aria-busy="true"]',
              )
            ) {
              ranHook = this.testIdFilter !== undefined;
              this.record("ui.state.changed", null, {
                feedback_type: candidate.matches('progress,[role="progressbar"]')
                  ? "progress_indicator"
                  : candidate.matches('[aria-busy="true"]')
                    ? "busy"
                    : "status_region",
                phase,
                control_id: elementTestId(candidate, this.testIdFilter),
              });
            }
          }
          // Only save a sibling and descend one edge at a time. Filtered walkers
          // may scan arbitrarily many rejected nodes inside a single nextNode().
          if (candidate.firstChild) pending.push(candidate.firstChild);
        }
      };
      for (const record of records) {
        if (!take()) break;
        const node = record.target;
        if (!publicPath(node)) {
          if (truncated) break;
          continue;
        }
        const target = node instanceof Element ? node : node.parentElement;
        if (!target) continue;
        count++;
        if (record.type === "attributes") {
          const name = record.attributeName;
          if (name === "aria-busy" || name === "disabled") {
            ranHook = this.testIdFilter !== undefined;
            this.record("ui.state.changed", null, {
              feedback_type: name === "aria-busy" ? "busy" : "disabled",
              phase: (
                name === "aria-busy"
                  ? target.getAttribute(name) === "true"
                  : target.hasAttribute(name)
              )
                ? "active"
                : "inactive",
              control_id: elementTestId(target, this.testIdFilter),
            });
          }
        }
        for (const [nodes, phase] of [
          [record.addedNodes, "appeared"],
          [record.removedNodes, "removed"],
        ] as const) {
          for (const node of nodes) {
            indicators(node, phase);
            if (truncated) break;
          }
          if (truncated) break;
        }
        if (truncated) break;
      }
      if (count)
        this.record("ui.state.changed", null, {
          feedback_type: "structural_change",
          count,
        });
      // At least one observation was omitted. Counting the rest would itself
      // exceed the work bound, so this is a lower bound, not a skipped-node total.
      if (truncated) this.dropped++;
      // This callback is synchronous, so whatever is pending now was written
      // during it: by the hook. Delivering that would run the hook again, and
      // a hook that writes an observed attribute would never yield to the page.
      if (ranHook) this.observer?.takeRecords();
    });
    this.observer.observe(this.root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-busy", "aria-expanded", "hidden", "role"],
    });
  }

  private inSink<T>(call: () => T): T {
    this.sinkDepth++;
    try {
      return call();
    } finally {
      this.sinkDepth--;
    }
  }

  private requestUrl(input: string): URL | null {
    try {
      const url = new URL(input, document.baseURI);
      const signed = Array.from(url.searchParams.keys()).some((key) =>
        /^(x-amz-|x-goog-|signature$|token$|sig$)/i.test(key),
      );
      const ingest =
        this.ingestBase !== null &&
        (url.href === this.ingestBase || url.href.startsWith(this.ingestBase + "/"));
      return !signed && this.allowed.has(url.origin) && !ingest ? url : null;
    } catch {
      return null;
    }
  }

  private label(url: URL, init: RequestInit | undefined): string | undefined {
    if (!this.options.requestLabel) return undefined;
    try {
      return safeLabel(this.options.requestLabel(url, init));
    } catch {
      return undefined;
    }
  }

  private instrumentFetch(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    id: string | null,
  ): Promise<Response> {
    if (!this.active || this.sinkDepth) return this.originalFetch.call(window, input, init);
    // Brand-check via native Request slots, which work across realms and ignore
    // expando properties. Resolve other inputs once and send the same URL we
    // checked: inspecting one representation and sending another leaks headers.
    let target: string;
    let inheritedHeaders: Headers | undefined;
    try {
      target = this.requestTarget.call(input) as string;
      inheritedHeaders = this.requestHeaders.call(input) as Headers;
    } catch {
      try {
        target = new URL(String(input), document.baseURI).href;
        input = target;
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const url = this.requestUrl(target);
    if (!url) return this.originalFetch.call(window, input, init);
    let modified = init;
    try {
      const headers = new Headers(init?.headers ?? inheritedHeaders);
      if (headers.has(this.readHeader))
        id = validInteractionId(headers.get(this.readHeader));
      else if (id && this.header) headers.set(this.header, id);
      modified = { ...init, headers };
    } catch {
      return this.originalFetch.call(window, input, init);
    }
    const requestLabel = this.label(url, init);
    const started = performance.now();
    this.record("request.started", id, { request_label: requestLabel });
    const done = this.clicks?.requestStarted() ?? (() => {});
    let request: Promise<Response>;
    try {
      request = this.originalFetch.call(window, input, modified);
    } catch (error) {
      done(true);
      this.record("request.completed", id, { outcome: "error", request_label: requestLabel });
      throw error;
    }
    return request.then(
      (response) => {
        try {
          let traceId: string | undefined;
          try {
            traceId = safeTraceId(response.headers.get("X-Trace-Id"));
          } catch {
            /* Unreadable cross-origin header. */
          }
          done(!response.ok);
          this.record("request.completed", id, {
            outcome: response.ok ? "completed" : "error",
            phase: `http_${response.status}`,
            duration_ms: clampMs(performance.now() - started),
            trace_id: traceId,
            request_label: requestLabel,
          });
        } catch {
          /* The host's response is returned regardless. */
        }
        return response;
      },
      (error) => {
        try {
          done(true);
          this.record("request.completed", id, {
            outcome: "error",
            duration_ms: clampMs(performance.now() - started),
            request_label: requestLabel,
          });
        } catch {
          /* The host's error is rethrown regardless. */
        }
        throw error;
      },
    );
  }

  /** Counts window.open during a click as opening a new tab (no DOM change is the expected effect). */
  private patchWindowOpen(): void {
    const original = window.open;
    if (typeof original !== "function") return;
    const runtime = this;
    const wrapped = function (this: Window, ...args: Parameters<Window["open"]>) {
      try {
        runtime.clicks?.newContext();
      } catch {
        /* Opening the window must remain unaffected. */
      }
      return original.apply(this, args);
    } as Window["open"];
    window.open = wrapped;
    this.removals.push(() => {
      if (window.open === wrapped) window.open = original;
    });
  }

  /**
   * An opaque per-session number for what was clicked: the nearest control or
   * label at or above the click inside the tracked control, else the clicked
   * element. Never sent as structure; only equal or not.
   */
  private targetKey(control: Element, clicked: Element): number {
    let element = clicked.closest(TARGETS);
    // A label outside its field's control keys as the label itself.
    if (!element || !(control.contains(element) || element === clicked)) element = clicked;
    let key = this.targetKeys.get(element);
    if (key === undefined) {
      // Keys only need to differ within a rage window, so wrapping is harmless.
      if (this.nextTargetKey > 1000000) this.nextTargetKey = 1;
      key = this.nextTargetKey++;
      this.targetKeys.set(element, key);
    }
    return key;
  }

  // ---- Findings --------------------------------------------------------

  /**
   * Sends each new fingerprint once per page session. With `defer`, a finding
   * whose place has no viewport yet (it happened before the first snapshot) is
   * held back: a later run, once a snapshot has filled in its viewport, sends it
   * with the right width band and fingerprint.
   */
  private emitFindings(findings: Finding[], defer = false): void {
    this.sentFindings.beginRun();
    for (const finding of findings) {
      if (!this.active) return;
      if (defer && !(finding.viewport_width > 0)) continue;
      // Seen again: refreshed, not resent. Full: more new findings in one run
      // than the memory holds; this one waits for a later run.
      if (this.sentFindings.admit(finding.fingerprint) !== "new") continue;
      this.record(
        "ui.finding",
        finding.interaction_id,
        toFindingData(finding),
        finding.interaction_id ? "inferred" : "unknown",
      );
    }
  }

  /**
   * `final` (the page is going away for good) sends findings that still have no
   * viewport rather than lose them; so does a session without snapshots, which
   * never gets one.
   */
  private runTimelineChecks(final = false): void {
    if (!this.findingsEnabled || !this.active || !this.timeline.length) return;
    try {
      this.emitFindings(
        checkEvents(this.timeline, { ...this.options.detect, now: Date.now() }),
        !final && this.snapshotsEnabled,
      );
    } catch {
      /* A check failing must never affect capture. */
    }
  }

  private scheduleTimelineChecks(): void {
    if (this.timelineScheduled) return;
    this.timelineScheduled = true;
    void idle().then(() => {
      this.timelineScheduled = false;
      this.runTimelineChecks();
    });
  }

  private runSnapshotChecks(body: SnapshotBody, sha256: string): void {
    if (!this.findingsEnabled) return;
    void idle().then(() => {
      if (!this.active) return;
      try {
        this.emitFindings(checkSnapshot(body, { ...this.options.detect, sha256 }));
      } catch {
        /* A check failing must never affect capture. */
      }
    });
  }

  private patchXHR(): void {
    const prototype = XMLHttpRequest.prototype;
    const originalOpen = prototype.open;
    const originalSend = prototype.send;
    const originalHeader = prototype.setRequestHeader;
    const requests = new WeakMap<
      XMLHttpRequest,
      { url: string; interactionHeader: string | null }
    >();
    const runtime = this;
    const open = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest["open"]>) {
      // Too few arguments: let native open throw exactly as it would without us.
      if (args.length < 2) return originalOpen.apply(this, args);
      let target = String(args[1]);
      try {
        target = new URL(target, document.baseURI).href;
      } catch {
        // Let native open report invalid URLs with its own exception behavior.
      }
      args[1] = target;
      const result = originalOpen.apply(this, args);
      requests.set(this, { url: target, interactionHeader: null });
      return result;
    } as XMLHttpRequest["open"];
    const header = function (this: XMLHttpRequest, name: string, value: string) {
      const result = originalHeader.call(this, name, value);
      if (name.toLowerCase() === runtime.readHeader.toLowerCase()) {
        const entry = requests.get(this);
        if (entry)
          entry.interactionHeader =
            entry.interactionHeader === null ? value : `${entry.interactionHeader}, ${value}`;
      }
      return result;
    };
    const send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const entry = requests.get(this);
      const url = runtime.active && entry && !runtime.sinkDepth ? runtime.requestUrl(entry.url) : null;
      if (entry && url) {
        try {
          const id =
            entry.interactionHeader !== null
              ? validInteractionId(entry.interactionHeader)
              : runtime.context;
          const started = performance.now();
          try {
            if (id && entry.interactionHeader === null && runtime.header)
              originalHeader.call(this, runtime.header, id);
          } catch {
            /* Keep host request usable. */
          }
          const requestLabel = runtime.label(url, undefined);
          runtime.record("request.started", id, { request_label: requestLabel });
          const done = runtime.clicks?.requestStarted() ?? (() => {});
          this.addEventListener(
            "loadend",
            () => {
              try {
                const ok = this.status >= 200 && this.status < 400;
                done(!ok);
                runtime.record("request.completed", id, {
                  outcome: ok ? "completed" : "error",
                  phase: `http_${this.status}`,
                  duration_ms: clampMs(performance.now() - started),
                  trace_id: xhrTraceId(this),
                  request_label: requestLabel,
                });
              } catch {
                /* ignore */
              }
            },
            { once: true },
          );
        } catch {
          /* Keep host request usable. */
        }
      }
      return originalSend.call(this, body);
    };
    prototype.open = open;
    prototype.send = send;
    prototype.setRequestHeader = header;
    this.removals.push(() => {
      if (prototype.open === open) prototype.open = originalOpen;
      if (prototype.send === send) prototype.send = originalSend;
      if (prototype.setRequestHeader === header) prototype.setRequestHeader = originalHeader;
    });
  }

  // ---- Snapshots -------------------------------------------------------

  /** Queues one snapshot behind any running walk; concurrent requests share the queued one. */
  requestSnapshot(trigger: SnapshotTrigger): Promise<SnapshotSummary | null> {
    if (!this.active || !this.snapshotsEnabled) return Promise.resolve(null);
    if (this.queuedSnapshot) return this.queuedSnapshot;
    const run = this.snapshotChain
      .then(() => {
        this.queuedSnapshot = null;
        return this.takeSnapshot(trigger);
      })
      .catch(() => null);
    this.queuedSnapshot = run;
    this.snapshotChain = run;
    return run;
  }

  private async takeSnapshot(trigger: SnapshotTrigger): Promise<SnapshotSummary | null> {
    const maxWalks = numberOption(this.options.maxSnapshotsPerSession, 100, 10000);
    if (!this.active || document.visibilityState === "hidden" || this.walks >= maxWalks) {
      this.snapshotStats.skipped++;
      return null;
    }
    this.walks++;
    const routeTemplate = this.route();
    const result = await walkSnapshot({
      root: this.root,
      maxElements: numberOption(this.options.maxElements, 5000, 50000),
      maxSliceMs: numberOption(this.options.maxSliceMs, 6, 50),
      ignoreSelector: validSelector(this.options.ignoreSelector),
      routeTemplate,
      shouldAbort: () => !this.active || document.visibilityState === "hidden",
      theme: typeof this.options.theme === "function" ? this.options.theme : undefined,
      testId: this.testIdFilter,
    });
    if (!result || !this.active) {
      this.snapshotStats.skipped++;
      return null;
    }
    const { body, serialized, bytes } = encodeSnapshot(
      result.body,
      numberOption(this.options.maxSnapshotBytes, 1_500_000, 10_000_000),
    );
    const sha256 = await sha256Hex(serialized);
    if (!this.active) return null;
    this.snapshotStats.taken++;
    this.currentHash = sha256;
    const deduplicated = this.sentHashes.has(sha256);
    const data: SnapshotEventData = {
      sha256,
      trigger,
      route_template: routeTemplate,
      viewport_width: body.viewport.width,
      viewport_height: body.viewport.height,
      element_count: body.element_count,
      truncated: body.truncated,
      torn: body.torn,
      bytes,
      walk_ms: clampMs(result.walkMs),
      slices: result.slices,
      max_slice_ms: clampMs(result.maxSliceMs),
      theme: body.viewport.theme ?? "unknown",
    };
    const summary: SnapshotSummary = {
      ...data,
      slice_ms: result.sliceMs,
      slice_elements: result.sliceElements,
      check_every: CHECK_EVERY,
      deduplicated,
    };
    this.lastSnapshot = summary;
    if (deduplicated) {
      this.snapshotStats.deduplicated++;
      return summary;
    }
    if (this.sentHashes.size >= MAX_SENT_HASHES) {
      this.sentHashes.delete(this.sentHashes.values().next().value!);
    }
    this.sentHashes.add(sha256);
    this.record("ui.snapshot", null, data);
    this.runSnapshotChecks(body, sha256);
    // The first screen also reports which performance signals this browser has.
    if (!this.reportedSignals) this.recordPerf(true);
    if (this.snapshotQueue.length >= MAX_PENDING_SNAPSHOTS) {
      // Drop the oldest body that is not being uploaded right now, and forget its
      // hash so the same screen can be uploaded again later.
      const index = this.snapshotQueue[0] === this.uploading ? 1 : 0;
      const [dropped] = this.snapshotQueue.splice(index, 1);
      if (dropped) this.sentHashes.delete(dropped.sha256);
      this.snapshotStats.skipped++;
    }
    this.snapshotQueue.push({ sha256, body, serialized, attempts: 0, nextAt: 0 });
    void this.drainSnapshots();
    return summary;
  }

  private drainSnapshots(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      while (this.active && this.snapshotQueue.length) {
        const item = this.snapshotQueue[0];
        if (Date.now() < item.nextAt) return;
        this.uploading = item;
        const result = await callSink(
          (context) =>
            this.inSink(() =>
              this.sink.sendSnapshot(
                { sha256: item.sha256, body: item.body, serialized: item.serialized },
                { ...context, fetch: this.sinkFetch },
              ),
            ),
          this.timeoutMs,
          false,
          this.stopController.signal,
        );
        this.uploading = null;
        if (!this.active) return;
        if (result === "denied") {
          this.deny();
          return;
        }
        // Remove by identity: the queue may have changed while the upload ran.
        const remove = () => {
          const index = this.snapshotQueue.indexOf(item);
          if (index >= 0) this.snapshotQueue.splice(index, 1);
        };
        if (result === "accepted") {
          this.snapshotStats.uploaded++;
          remove();
        } else if (result === "rejected") {
          // The service refused this body; sending it again would not help.
          this.snapshotStats.skipped++;
          remove();
        } else if (item.attempts++ >= this.retries) {
          // Out of retries: the same screen may be uploaded again later.
          this.snapshotStats.skipped++;
          this.sentHashes.delete(item.sha256);
          remove();
        } else {
          item.nextAt =
            Date.now() +
            numberOption(this.options.retryBaseMs, 1000, 3600000) * 2 ** (item.attempts - 1);
          return;
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        this.draining = null;
      });
    return this.draining;
  }

  // ---- Transport -------------------------------------------------------

  /** Records a perf summary when anything happened; `force` reports availability once. */
  private recordPerf(force = false): void {
    const summary = this.perf.takeSummary(force && !this.reportedSignals);
    if (summary) {
      this.reportedSignals = true;
      this.record("perf.summary", null, summary);
    }
  }

  flush(keepalive = false): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.sending) return this.sending;
    this.recordPerf();
    this.runTimelineChecks();
    this.sending = this.send(keepalive)
      .catch(() => {
        this.lastError = "transport_error";
      })
      .then(() => (keepalive ? undefined : this.drainSnapshots()))
      .finally(() => {
        this.sending = null;
      });
    return this.sending;
  }

  private async send(keepalive: boolean): Promise<void> {
    if (!this.pending && this.queue.length) {
      const batch: Batch = {
        batch_id: crypto.randomUUID(),
        schema_version: 2,
        sdk_version: VERSION,
        release: this.release,
        events: [],
      };
      const encoder = new TextEncoder();
      while (this.queue.length && batch.events.length < this.maxBatch) {
        batch.events.push(this.queue[0]);
        if (encoder.encode(JSON.stringify(batch)).byteLength > this.maxBytes) {
          batch.events.pop();
          if (!batch.events.length) {
            this.queue.shift();
            this.dropped++;
            continue;
          }
          break;
        }
        this.queue.shift();
      }
      if (batch.events.length)
        this.pending = {
          batch,
          serialized: JSON.stringify(batch),
          attempts: 0,
          nextAt: 0,
        };
    }
    const pending = this.pending;
    if (!pending || Date.now() < pending.nextAt) return;
    const result: SinkResult = await callSink(
      (context) =>
        this.inSink(() =>
          this.sink.sendBatch(pending.batch, pending.serialized, { ...context, fetch: this.sinkFetch }),
        ),
      this.timeoutMs,
      keepalive,
      this.stopController.signal,
    );
    if (!this.active) return;
    if (result === "accepted") {
      this.accepted++;
      this.pending = null;
      this.lastError = null;
      return;
    }
    if (result === "denied") {
      this.deny();
      return;
    }
    if (result === "rejected") {
      this.failed++;
      this.dropped += pending.batch.events.length;
      this.pending = null;
      this.lastError = "batch_rejected";
      return;
    }
    this.lastError = "transport_error";
    if (pending.attempts++ >= this.retries) {
      this.failed++;
      this.dropped += pending.batch.events.length;
      this.pending = null;
    } else
      pending.nextAt =
        Date.now() +
        numberOption(this.options.retryBaseMs, 1000, 3600000) * 2 ** (pending.attempts - 1);
  }

  private deny(): void {
    this.lastError = "admission_denied";
    this.stop();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.dropped += this.queue.length + (this.pending?.batch.events.length ?? 0);
    this.queue = [];
    this.pending = null;
    this.snapshotQueue = [];
    this.timeline = [];
    this.stopController.abort();
    clearInterval(this.timer);
    this.observer?.disconnect();
    for (const remove of this.removals.reverse()) {
      try {
        remove();
      } catch {
        /* Other instrumentation may freeze prototypes. */
      }
    }
    this.removals = [];
    onStop?.(this);
  }
}

let onStop: ((runtime: Runtime) => void) | undefined;
export const setStopHook = (hook: (runtime: Runtime) => void): void => {
  onStop = hook;
};

const idle = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 1000 });
    else setTimeout(resolve, 0);
  });

function validSelector(selector: string | undefined): string {
  if (!selector) return "";
  try {
    document.createDocumentFragment().querySelector(selector);
    return selector;
  } catch {
    return "";
  }
}

function xhrTraceId(request: XMLHttpRequest): string | undefined {
  try {
    // getAllResponseHeaders lists only readable headers and never logs a refusal.
    const match = /^x-trace-id:\s*(.+)$/im.exec(request.getAllResponseHeaders());
    return safeTraceId(match?.[1]?.trim());
  } catch {
    return undefined;
  }
}

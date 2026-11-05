import { ClickEffects } from "./click-effects";
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
  numberOption,
  safeHeaderName,
  safeIdentifier,
  safeLabel,
  safeRelease,
  safeRoute,
  safeTraceId,
  sha256Hex,
  validInteractionId,
} from "./util";

const ATTRIBUTION = "explicit synchronous runAction only" as const;
const CONTROLS = "button,a,form,input[type=submit],[role=button]";
const MAX_SENT_HASHES = 1000;
const MAX_PENDING_SNAPSHOTS = 4;

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
  private snapshotStats = { taken: 0, uploaded: 0, deduplicated: 0, skipped: 0 };
  private lastSnapshot: SnapshotSummary | null = null;
  private walks = 0;

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
        : defaultRouteTemplate(url);
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
      this.queue.push({
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
      });
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

    const control = (event: Event) => {
      const target =
        event.target instanceof Element ? event.target.closest(CONTROLS) : null;
      if (
        !target ||
        !this.root.contains(target) ||
        target.closest("[data-interactions-exclude]")
      )
        return;
      const explicit =
        safeIdentifier(target.getAttribute("data-interaction-id")) ??
        safeIdentifier(target.getAttribute("data-testid"));
      // Non-unique structural hint: at most five ancestor tags, never a sibling scan.
      const path: string[] = [];
      for (
        let node: Element | null = target;
        node && node !== this.root && path.length < 5;
        node = node.parentElement
      )
        path.unshift(node.tagName.toLowerCase());
      const id = crypto.randomUUID();
      const controlId = explicit ?? path.join("/");
      this.record("interaction.started", id, {
        action: event.type,
        control_id: controlId,
      });
      if (event.type === "click") this.clicks?.begin(id, controlId, target);
    };
    listen(document, "click", control);
    listen(document, "submit", control);
    const navigation = () => {
      this.record("ui.state.changed", null, { feedback_type: "navigation" });
      this.onRoute();
    };
    listen(window, "popstate", navigation);
    listen(window, "hashchange", () => this.onRoute());
    listen(window, "pagehide", () => {
      this.clicks?.pageHidden();
      this.recordPerf();
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
              this.record("ui.state.changed", null, {
                feedback_type: candidate.matches('progress,[role="progressbar"]')
                  ? "progress_indicator"
                  : candidate.matches('[aria-busy="true"]')
                    ? "busy"
                    : "status_region",
                phase,
                control_id:
                  safeIdentifier(candidate.getAttribute("data-interaction-id")) ??
                  safeIdentifier(candidate.getAttribute("data-testid")),
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
            this.record("ui.state.changed", null, {
              feedback_type: name === "aria-busy" ? "busy" : "disabled",
              phase: (
                name === "aria-busy"
                  ? target.getAttribute(name) === "true"
                  : target.hasAttribute(name)
              )
                ? "active"
                : "inactive",
              control_id:
                safeIdentifier(target.getAttribute("data-interaction-id")) ??
                safeIdentifier(target.getAttribute("data-testid")),
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
    });
    this.observer.observe(this.root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-busy", "aria-expanded", "hidden", "role"],
    });
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
    if (!this.active) return this.originalFetch.call(window, input, init);
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
      const url = runtime.active && entry ? runtime.requestUrl(entry.url) : null;
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
            this.sink.sendSnapshot(
              { sha256: item.sha256, body: item.body, serialized: item.serialized },
              context,
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
      (context) => this.sink.sendBatch(pending.batch, pending.serialized, context),
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

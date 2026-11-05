/** Capture evidence asynchronously. No raw DOM text, HTML, input values or URLs are emitted. */
import { Runtime, setStopHook } from "./runtime";
import type { InteractionHandle, InteractionOptions } from "./types";

export type {
  ActionContext,
  Batch,
  ClickSettledData,
  Diagnostics,
  EvidenceEvent,
  InteractionHandle,
  InteractionOptions,
  PerfSummaryData,
  SignalName,
  SnapshotEventData,
  SnapshotTrigger,
} from "./types";
export type {
  InteractionSink,
  MemorySink,
  SinkContext,
  SinkResult,
  SinkSnapshot,
} from "./sink";
export { createHttpSink, createMemorySink } from "./sink";
export type { DetectOptions, ElementRef, Evidence, FindingData } from "./detect/types";
export type { SnapshotBody, SnapshotSummary } from "./snapshot";
export { FLAGS, HIT_POINTS, POSITIONS } from "./snapshot";
export { VERSION, defaultRouteTemplate } from "./util";

const registryKey = Symbol.for("@codepress/interactions-browser/v1");
type RegistryWindow = Window & { [registryKey]?: Runtime };

setStopHook((runtime) => {
  const host = window as RegistryWindow;
  if (host[registryKey] === runtime) delete host[registryKey];
});

function noop(): InteractionHandle {
  return {
    flush: async () => {},
    shutdown() {},
    snapshot: async () => null,
    getDiagnostics: () => ({
      enabled: false,
      queuedEvents: 0,
      droppedEvents: 0,
      acceptedBatches: 0,
      failedBatches: 0,
      lastError: null,
      adapters: [],
      attribution: "explicit synchronous runAction only",
      snapshots: { taken: 0, uploaded: 0, deduplicated: 0, skipped: 0, last: null },
      signals: {
        layout_shift: false,
        event_timing: false,
        long_task: false,
        image_error: false,
        uncaught_error: false,
      },
    }),
    runAction: (_name, callback) =>
      callback({
        interactionId: "",
        fetch: (...args) => globalThis.fetch(...args),
      }),
  };
}

/** Repeated identical initialization shares instrumentation through independent leases. */
export function initInteractions(options: InteractionOptions): InteractionHandle {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    options.enabled === false
  )
    return noop();
  try {
    let endpoint: URL | null = null;
    if (!options.sink) {
      if (!options.endpoint || !options.projectKey) return noop();
      endpoint = new URL(options.endpoint, window.location.href);
      if (
        !["https:", "http:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      )
        return noop();
    } else if (
      typeof options.sink.sendBatch !== "function" ||
      typeof options.sink.sendSnapshot !== "function"
    )
      return noop();
    const host = window as RegistryWindow;
    // Functions and objects are compared by identity; everything else by value.
    const identity = [
      options.root ?? document.documentElement,
      options.sink,
      options.routeTemplate,
      options.requestLabel,
    ];
    const signature = JSON.stringify({
      ...options,
      root: undefined,
      sink: undefined,
      endpoint: endpoint?.href,
    });
    const existing = host[registryKey];
    if (existing) {
      if (
        existing.signature !== signature ||
        existing.identity.some((value, index) => value !== identity[index])
      )
        return noop();
      return existing.lease();
    }
    const runtime = new Runtime(options, endpoint, signature, identity);
    host[registryKey] = runtime;
    try {
      runtime.start();
    } catch {
      runtime.stop();
      return noop();
    }
    return runtime.lease();
  } catch {
    return noop();
  }
}

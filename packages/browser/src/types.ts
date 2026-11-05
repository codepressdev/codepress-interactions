import type { DetectOptions, FindingData } from "./detect/types";
import type { Theme } from "./format";
import type { InteractionSink } from "./sink";
import type { SnapshotSummary } from "./snapshot";

/** Capture evidence asynchronously. No raw DOM text, HTML, input values or URLs are emitted. */
export interface InteractionOptions {
  /** Public project key. Required with `endpoint`; ignored by a custom `sink`. */
  projectKey?: string;
  /** Full service base URL (without /v2/batches). Use this or `sink`. */
  endpoint?: string;
  /** Destination for batches and snapshot bodies instead of `endpoint`. */
  sink?: InteractionSink;
  /** Local diagnostic label; tenant/environment authority comes from the key. */
  environment?: string;
  /** Application release label, e.g. a version or commit. Bounded token, sent per batch. */
  release?: string;
  enabled?: boolean;
  allowedApiOrigins?: string[];
  flushIntervalMs?: number;
  retryBaseMs?: number;
  maxRetries?: number;
  maxQueueEvents?: number;
  maxBatchEvents?: number;
  maxBatchBytes?: number;
  maxMutationRecords?: number;
  requestTimeoutMs?: number;
  /** Explicitly scoped observation root; defaults to document.documentElement. */
  root?: Element;
  /**
   * Maps the current location to a bounded route label. Default: the path with
   * every segment replaced by `:id` unless it is listed in `routeSegments`; never
   * the query or hash.
   */
  routeTemplate?: (location: URL) => string | null | undefined;
  /**
   * Static lowercase path words the default route template may keep, for example
   * `["orders", "items", "settings"]` (pattern `[a-z][a-z_-]*`, at most 32
   * characters, 256 words). Default: none, so every segment is `:id`.
   */
  routeSegments?: string[];
  /** Bounded static label for an observed request. Default: no label. */
  requestLabel?: (url: URL, init: RequestInit | undefined) => string | null | undefined;
  /** Correlation header added to allowed-origin requests. `false` disables it. Default `X-Interaction-Id`. */
  propagateHeader?: string | false;
  /** Capture screen snapshots. Default true. */
  snapshots?: boolean;
  /** Elements per snapshot before it is marked `truncated`. Default 5000 (max 50000). */
  maxElements?: number;
  /** Main-thread time per walk slice before yielding. Default 6 ms (max 50). */
  maxSliceMs?: number;
  /** Uncompressed body size cap; larger bodies drop trailing elements and are `truncated`. Default 1,500,000. */
  maxSnapshotBytes?: number;
  /** Snapshot walks per page session. Default 100. */
  maxSnapshotsPerSession?: number;
  /** DOM quiet time after a route change before a snapshot. Default 1000 ms. */
  routeSettleMs?: number;
  /** Quiet time after a click's last effect before it counts as settled. Default 500 ms. */
  clickSettleMs?: number;
  /** Longest a click is followed before it is reported `incomplete`. Default 10000 ms. */
  clickTimeoutMs?: number;
  /** Quiet time after the last resize before a snapshot. Default 500 ms. */
  resizeSettleMs?: number;
  /** Delay after the tab becomes visible again before a snapshot. Default 300 ms. */
  visibleSettleMs?: number;
  /** Subtrees recorded as one box flagged `ignored`, never descended. Always includes `[data-layout-ignore]` and `[data-interactions-exclude]`. */
  ignoreSelector?: string;
  /** Run the checks in idle time and send `ui.finding` events, once per fingerprint per page session. Default true. */
  findings?: boolean;
  /** Check thresholds (see `@codepress/interactions-browser/detect`). */
  detect?: Omit<DetectOptions, "now">;
  /**
   * The theme actually showing, for apps with their own theme toggle; read at
   * every snapshot. Anything other than "light", "dark" or "unknown" (or a throw)
   * is recorded as "unknown". Default: the user's `prefers-color-scheme`.
   */
  theme?: () => Theme;
}

export interface Diagnostics {
  enabled: boolean;
  queuedEvents: number;
  droppedEvents: number;
  acceptedBatches: number;
  failedBatches: number;
  lastError: string | null;
  adapters: string[];
  attribution: "explicit synchronous runAction only";
  snapshots: {
    taken: number;
    uploaded: number;
    deduplicated: number;
    skipped: number;
    last: SnapshotSummary | null;
  };
  /** Performance signal availability; missing browser APIs are reported `false`. */
  signals: Record<SignalName, boolean>;
}

export interface ActionContext {
  interactionId: string;
  /** Carries this action through an async callback without global async context. */
  fetch: typeof fetch;
}

export interface InteractionHandle {
  flush(): Promise<void>;
  shutdown(): void;
  getDiagnostics(): Diagnostics;
  runAction<T>(name: string, callback: (context: ActionContext) => T): T;
  /** Takes a snapshot now (trigger `manual`). Resolves null when skipped. */
  snapshot(): Promise<SnapshotSummary | null>;
}

export type SignalName =
  | "layout_shift"
  | "event_timing"
  | "long_task"
  | "image_error"
  | "uncaught_error";

export type LegacyEventType =
  | "interaction.started"
  | "ui.state.changed"
  | "request.started"
  | "request.completed"
  | "capture.interrupted"
  | "capture.events_dropped";

export type EventType =
  | LegacyEventType
  | "ui.snapshot"
  | "ui.click.settled"
  | "ui.finding"
  | "perf.summary";

export type LegacyData = Partial<{
  phase: string;
  action: string;
  control_id: string;
  feedback_type: string;
  outcome: "pending" | "completed" | "error" | "abandoned";
  duration_ms: number;
  count: number;
  trace_id: string;
  route_template: string;
  request_label: string;
  /** Click starts: opaque per-session key of the element clicked (0.3.0). */
  target_key: number;
}>;

export type SnapshotTrigger = "route" | "click" | "resize" | "visible" | "manual";

export interface SnapshotEventData {
  sha256: string;
  trigger: SnapshotTrigger;
  route_template: string | null;
  viewport_width: number;
  viewport_height: number;
  element_count: number;
  truncated: boolean;
  torn: boolean;
  bytes: number;
  walk_ms: number;
  slices: number;
  max_slice_ms: number;
  /** Color scheme on screen, as in the body's `viewport.theme`. Absent before 0.3.0. */
  theme?: Theme;
}

export type ClickEndReason =
  | "settled"
  | "overlapped"
  | "timeout"
  | "page_hidden";

export interface ClickSettledData {
  action: "click";
  control_id: string;
  route_template: string | null;
  first_feedback_ms: number | null;
  settle_ms: number;
  mutation_count: number;
  request_count: number;
  request_failed_count: number;
  error_count: number;
  long_task_count: number | null;
  layout_shift_score: number | null;
  route_changed: boolean;
  dialog_opened: boolean;
  focus_moved: boolean;
  /** The click landed on a control (button, link, field, label, summary, control role or tabindex), not only inside a container. */
  target_interactive?: boolean;
  /** An input or change event fired on the clicked field (checkbox, radio, select…). */
  value_changed?: boolean;
  /** The click put focus in a text field, select or editable region: the caret or picker is the effect. */
  field_focused?: boolean;
  /** The click opened a new tab or window (link target, modifier key, download or window.open). */
  new_context?: boolean;
  /** The click changed the text selection or moved the caret (1.0.0). */
  selection_changed?: boolean;
  overlapped: boolean;
  incomplete: boolean;
  end_reason: ClickEndReason;
  before_sha256: string | null;
  after_sha256: string | null;
}

export interface PerfSummaryData {
  window_ms: number;
  layout_shift_score: number | null;
  layout_shift_count: number | null;
  long_task_count: number | null;
  long_task_ms: number | null;
  event_timing_count: number | null;
  event_timing_max_ms: number | null;
  image_error_count: number | null;
  uncaught_error_count: number | null;
  unavailable: SignalName[];
}

export interface EvidenceEvent {
  event_id: string;
  schema_version: 2;
  interaction_id: string | null;
  operation_id: null;
  source: "browser";
  source_instance_id: string;
  sequence: number;
  occurred_at: string;
  type: EventType;
  attribution: "explicit" | "inferred" | "unknown";
  data: LegacyData | SnapshotEventData | ClickSettledData | PerfSummaryData | FindingData;
}

export interface Batch {
  batch_id: string;
  schema_version: 2;
  sdk_version: string;
  release: string | null;
  events: EvidenceEvent[];
}

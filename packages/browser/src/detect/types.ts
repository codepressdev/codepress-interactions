/** Finding types and options. Pure data: nothing here touches the DOM. */

/** Short check names, in their default report order within a priority tier. */
export const CHECK_NAMES = [
  "overlap",
  "spill",
  "page_h_scroll",
  "offscreen_control",
  "small_tap_target",
  "clipped_text",
  "dead_click",
  "rage_click",
  "slow_feedback",
  "silent_failure",
  "error_after_click",
  "stuck_busy",
  "layout_shift",
  "slow_input",
  "broken_image",
  "no_focus_indicator",
] as const;

export type CheckName = (typeof CHECK_NAMES)[number];

/** Wire identifiers (`ui.finding` `data.check`). */
export const CHECK_IDS: Record<CheckName, string> = {
  overlap: "layout.overlap",
  spill: "layout.spill",
  page_h_scroll: "layout.page_h_scroll",
  offscreen_control: "layout.offscreen_control",
  small_tap_target: "layout.small_tap_target",
  clipped_text: "layout.clipped_text",
  dead_click: "click.dead_click",
  rage_click: "click.rage_click",
  slow_feedback: "click.slow_feedback",
  silent_failure: "click.silent_failure",
  error_after_click: "click.error_after_click",
  stuck_busy: "stability.stuck_busy",
  layout_shift: "stability.layout_shift",
  slow_input: "stability.slow_input",
  broken_image: "stability.broken_image",
  no_focus_indicator: "a11y.no_focus_indicator",
};

/** Bumped when a check's meaning changes, so old and new findings are not mixed. */
export const CHECK_VERSION = 1;

/** Measured facts only: numbers, booleans or null (unknown). Never a verdict or text. */
export type Evidence = Record<string, number | boolean | null>;

/** One element of a snapshot, as a finding refers to it. */
export interface ElementRef {
  /** Row in the snapshot's element columns; -1 when not in the snapshot. */
  index: number;
  tag: string;
  role: string | null;
  test_id: string | null;
  /**
   * The identity the fingerprint uses: the test ID, or else a structural path of
   * tags from the nearest ancestor with a test ID (`#anchor/div/button`) or from
   * the root. A structural path is not unique: siblings with the same tags share it.
   */
  stable_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  position: string;
  z_index: number | null;
}

/** `ui.finding` event data, exactly as sent. */
export interface FindingData {
  check: string;
  check_version: number;
  fingerprint: string;
  route_template: string | null;
  snapshot_sha256: string | null;
  viewport_width: number;
  viewport_height: number;
  /** The element the finding is about; null when the evidence has no element (click and performance findings without a snapshot). */
  subject: ElementRef | null;
  /** The second element: what covers the subject, its clipping container, and so on. */
  other: ElementRef | null;
  /** The clicked control's identifier, for click findings. */
  control_id: string | null;
  evidence: Evidence;
}

/** A finding as checks return it: the wire data plus its short name and the click it came from. */
export interface Finding extends FindingData {
  type: CheckName;
  /** The click's interaction ID for click findings; null otherwise. Sent as the event's interaction_id. */
  interaction_id: string | null;
}

/** Thresholds and switches. Every default is documented in the package README. */
export interface DetectOptions {
  /** Checks to run. Default: all of them. */
  checks?: readonly CheckName[];
  /** Overlap: the intersection must be wider and taller than this. Default 0.5 px (sub-pixel rounding does not count). */
  overlapMinPx?: number;
  /** Spill, offscreen control, clipped text and horizontal scroll: crossing by more than this. Default 1 px. */
  tolerancePx?: number;
  /** Small tap target: controls narrower or shorter than this. Default 24 px (WCAG 2.2 target size minimum). */
  minTapTargetPx?: number;
  /** Small tap target runs only for touch input. Default: the snapshot's `viewport.coarse_pointer`. */
  touch?: boolean;
  /** Viewport width breakpoints for the fingerprint's band. Default [480, 768, 1024, 1440]. */
  viewportBands?: readonly number[];
  /** Slow feedback: first feedback at or after this many ms. Default 1000. */
  slowFeedbackMs?: number;
  /** Rage click: at least this many clicks on one control... Default 3. */
  rageClickCount?: number;
  /** ...within this many ms. Default 1000. */
  rageClickWindowMs?: number;
  /** Stuck busy: a busy or progress indicator still showing after this many ms. Default 10000. */
  stuckBusyMs?: number;
  /** Layout shift: a summary window's shift score at or above this. Default 0.1. */
  layoutShiftScore?: number;
  /** Slow input: slowest event timing at or above this many ms. Default 200. */
  slowInputMs?: number;
  /** Stuck busy is measured up to this time (epoch ms). Default: the last event's time. */
  now?: number;
}

export interface ResolvedOptions {
  checks: ReadonlySet<CheckName>;
  overlapMinPx: number;
  tolerancePx: number;
  minTapTargetPx: number;
  touch: boolean | undefined;
  viewportBands: readonly number[];
  slowFeedbackMs: number;
  rageClickCount: number;
  rageClickWindowMs: number;
  stuckBusyMs: number;
  layoutShiftScore: number;
  slowInputMs: number;
  now: number | undefined;
}

const num = (value: unknown, fallback: number, min = 0): number =>
  typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;

export function resolveOptions(options: DetectOptions = {}): ResolvedOptions {
  const bands = Array.isArray(options.viewportBands)
    ? options.viewportBands.filter((b) => typeof b === "number" && Number.isFinite(b) && b > 0).sort((a, b) => a - b)
    : [480, 768, 1024, 1440];
  return {
    checks: new Set(
      Array.isArray(options.checks)
        ? options.checks.filter((name) => (CHECK_NAMES as readonly string[]).includes(name))
        : CHECK_NAMES,
    ),
    overlapMinPx: num(options.overlapMinPx, 0.5),
    tolerancePx: num(options.tolerancePx, 1),
    minTapTargetPx: num(options.minTapTargetPx, 24),
    touch: typeof options.touch === "boolean" ? options.touch : undefined,
    viewportBands: bands,
    slowFeedbackMs: num(options.slowFeedbackMs, 1000),
    rageClickCount: Math.max(2, Math.floor(num(options.rageClickCount, 3))),
    rageClickWindowMs: num(options.rageClickWindowMs, 1000),
    stuckBusyMs: num(options.stuckBusyMs, 10000),
    layoutShiftScore: num(options.layoutShiftScore, 0.1),
    slowInputMs: num(options.slowInputMs, 200),
    now: typeof options.now === "number" && Number.isFinite(options.now) ? options.now : undefined,
  };
}

/** Strips the local fields: what goes in a `ui.finding` event's data. */
export function toFindingData(finding: Finding): FindingData {
  const { type: _type, interaction_id: _id, ...data } = finding;
  return data;
}

/** Keeps evidence inside the wire bounds: finite numbers within ±1e9, at most 32 keys. */
export function boundEvidence(evidence: Evidence): Evidence {
  const out: Evidence = {};
  for (const [key, value] of Object.entries(evidence).slice(0, 32))
    out[key] =
      typeof value === "number"
        ? Number.isFinite(value)
          ? Math.max(-1e9, Math.min(1e9, value))
          : null
        : value;
  return out;
}

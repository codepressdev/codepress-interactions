/**
 * Motion checks over observed CSS animation and transition runs: animations
 * that move layout, never finish, loop out of sight, jank, or ignore the
 * user's reduced-motion preference. A run is plain measured data (the SDK
 * builds it from animation events; a test can build it by hand), so these are
 * pure functions like every other check.
 */
import { fingerprint, viewportBand } from "./fingerprint";
import {
  CHECK_IDS,
  CHECK_VERSION,
  type CheckName,
  type ElementRef,
  type Evidence,
  type Finding,
  type ResolvedOptions,
  boundEvidence,
} from "./types";

/** Long animation frames blocking the main thread longer than this are jank. */
export const JANK_BLOCKING_MS = 50;
/** Reduced motion: only runs longer than this… */
export const REDUCED_MOTION_MIN_MS = 200;
/** …on an element covering at least this share of the viewport count. */
export const REDUCED_MOTION_MIN_AREA = 0.1;

/**
 * One CSS animation or transition on one element, as observed. Holds numbers,
 * booleans and the element reference only: never an animation name, a
 * property name or value, or text.
 */
export interface MotionRun {
  /** The animated element (`index` -1: it is identified from the page, not a snapshot row). */
  subject: ElementRef;
  route_template: string | null;
  viewport_width: number;
  viewport_height: number;
  /** The latest snapshot when the run was observed, if any. */
  snapshot_sha256: string | null;
  /** A transition (true) or a keyframe animation (false). */
  transition: boolean;
  /** Time from the start event to the end or cancel event, or to the last look while it runs. */
  elapsed_ms: number;
  /** An end or cancel event was seen. */
  ended: boolean;
  /** Playing at the last look (not paused, idle or finished); null when unknown. */
  running: boolean | null;
  /** Declared active duration (delay excluded); null when infinite or unknown. */
  duration_ms: number | null;
  /** Repeats forever. */
  infinite: boolean;
  /** Animated layout properties (width, height, top, left, right, bottom, margin*, padding*, inset*). */
  layout_props: number;
  /** Animated transform, position (top, left, right, bottom, inset*) or opacity properties. */
  motion_props: number;
  /** The element's box area when first seen. */
  element_area_px: number;
  /** Visible at the last look; null when not looked at. */
  visible: boolean | null;
  /** Why not visible (each null when not looked at). */
  zero_box: boolean | null;
  outside_document: boolean | null;
  visibility_hidden: boolean | null;
  aria_hidden: boolean | null;
  transparent: boolean | null;
  /** `prefers-reduced-motion: reduce` matched when the run started. */
  reduced_motion: boolean;
  /** Long animation frames over JANK_BLOCKING_MS of blocking that overlapped the run. */
  long_frames: number;
  max_blocking_ms: number;
}

/** The checks over motion runs, in run order; at most one finding per fingerprint. */
export function motionFindings(runs: readonly MotionRun[], options: ResolvedOptions): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  const on = (name: CheckName) => options.checks.has(name);
  for (const run of runs) {
    if (!run || typeof run !== "object" || !run.subject) continue;
    const emit = (type: CheckName, evidence: Evidence) => {
      const print = fingerprint(
        type,
        run.route_template,
        viewportBand(run.viewport_width, options.viewportBands),
        [run.subject.stable_id, null],
      );
      if (seen.has(print)) return;
      seen.add(print);
      evidence.transition = run.transition === true;
      evidence.subject_structural_id = !run.subject.test_id;
      out.push({
        type,
        check: CHECK_IDS[type],
        check_version: CHECK_VERSION,
        fingerprint: print,
        route_template: run.route_template,
        snapshot_sha256: run.snapshot_sha256,
        viewport_width: Math.max(0, Math.round(run.viewport_width)),
        viewport_height: Math.max(0, Math.round(run.viewport_height)),
        subject: run.subject,
        other: null,
        control_id: null,
        interaction_id: null,
        evidence: boundEvidence(evidence),
      });
    };
    const elapsed = finite(run.elapsed_ms);
    const duration = run.infinite ? null : nullable(run.duration_ms);
    const area = finite(run.element_area_px);
    const playing = !run.ended && run.running !== false;

    if (on("layout_animation") && finite(run.layout_props) > 0)
      emit("layout_animation", {
        duration_ms: duration,
        layout_props: finite(run.layout_props),
        element_area_px: area,
        infinite: run.infinite === true,
      });

    if (on("stuck_animation") && !run.infinite && playing && elapsed >= options.stuckAnimationMs)
      emit("stuck_animation", {
        elapsed_ms: Math.round(elapsed),
        duration_ms: duration,
        element_area_px: area,
      });

    if (on("offscreen_loop") && run.infinite && playing && elapsed > options.offscreenLoopMs && run.visible === false)
      emit("offscreen_loop", {
        elapsed_ms: Math.round(elapsed),
        element_area_px: area,
        zero_box: run.zero_box,
        outside_document: run.outside_document,
        visibility_hidden: run.visibility_hidden,
        aria_hidden: run.aria_hidden,
        transparent: run.transparent,
      });

    if (on("janky_animation") && finite(run.long_frames) > 0 && run.visible === true)
      emit("janky_animation", {
        long_frames: finite(run.long_frames),
        max_blocking_ms: Math.round(finite(run.max_blocking_ms)),
        duration_ms: duration,
        infinite: run.infinite === true,
        element_area_px: area,
      });

    const viewportArea = finite(run.viewport_width) * finite(run.viewport_height);
    if (
      on("reduced_motion_ignored") &&
      run.reduced_motion &&
      finite(run.motion_props) > 0 &&
      (run.infinite || (duration !== null && duration > REDUCED_MOTION_MIN_MS)) &&
      viewportArea > 0 &&
      area >= REDUCED_MOTION_MIN_AREA * viewportArea
    )
      emit("reduced_motion_ignored", {
        duration_ms: duration,
        infinite: run.infinite === true,
        motion_props: finite(run.motion_props),
        element_area_px: area,
        viewport_area_ratio: Math.round((area / viewportArea) * 1000) / 1000,
      });
  }
  return out;
}

const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const nullable = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;

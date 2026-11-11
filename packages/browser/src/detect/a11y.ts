/**
 * Accessibility checks over what the browser SDK measured in the page. The
 * measurements themselves (computed styles) never leave the page; these checks
 * see only their outcome.
 */
import { fingerprint, viewportBand } from "./fingerprint";
import { CHECK_IDS, CHECK_VERSION, boundEvidence, resolveOptions, type DetectOptions, type Finding } from "./types";

/** One keyboard focus, as the SDK observed it. */
export interface FocusObservation {
  /** The focused element's identifier (test ID or tag path), as a click's `control_id`. */
  control_id: string;
  route_template: string | null;
  viewport_width: number;
  viewport_height: number;
  /** The screen showing when focus arrived, if a snapshot had been taken. */
  snapshot_sha256: string | null;
  /**
   * Whether the outline, box shadow, border colours or background colour of the
   * element or one of its `wrappers` differed between focused and unfocused, or
   * a transition or animation ran on them while focused.
   */
  indicator_changed: boolean;
  /** Ancestors compared along with the element (a wrapper styled with `:focus-within`). */
  wrappers: number;
}

/**
 * `a11y.no_focus_indicator`: keyboard focus reached an element and nothing
 * about it or its wrappers changed visibly. One finding, or none.
 */
export function focusIndicatorFindings(observation: FocusObservation, options: DetectOptions = {}): Finding[] {
  const resolved = resolveOptions(options);
  if (!resolved.checks.has("no_focus_indicator") || observation.indicator_changed !== false) return [];
  const controlId = observation.control_id;
  if (typeof controlId !== "string" || !controlId) return [];
  const width = Number.isFinite(observation.viewport_width) ? Math.max(0, Math.round(observation.viewport_width)) : 0;
  const height = Number.isFinite(observation.viewport_height) ? Math.max(0, Math.round(observation.viewport_height)) : 0;
  const route = observation.route_template ?? null;
  return [
    {
      type: "no_focus_indicator",
      check: CHECK_IDS.no_focus_indicator,
      check_version: CHECK_VERSION,
      fingerprint: fingerprint("no_focus_indicator", route, viewportBand(width, resolved.viewportBands), [controlId]),
      route_template: route,
      snapshot_sha256: observation.snapshot_sha256 ?? null,
      viewport_width: width,
      viewport_height: height,
      subject: null,
      other: null,
      control_id: controlId,
      interaction_id: null,
      evidence: boundEvidence({
        kind_focus: true,
        indicator_changed: false,
        wrappers_compared: Number.isFinite(observation.wrappers) ? observation.wrappers : null,
        structural_id: controlId.includes("/"),
      }),
    },
  ];
}

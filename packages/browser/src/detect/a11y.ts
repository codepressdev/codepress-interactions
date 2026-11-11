/**
 * Accessibility checks over what the browser SDK measured in the page. The
 * measurements themselves (computed styles, colours, labels and text) never
 * leave the page; these checks see only their outcome: a focus observation, and
 * the snapshot body's `contrast` and `unnamed_controls` tables (ratios, font
 * sizes and booleans).
 */
import { requiredRatio } from "../color";
import { FLAGS } from "../format";
import { fingerprint, viewportBand } from "./fingerprint";
import { emit, type Context } from "./layout";
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

// ---- Snapshot measurements: contrast and accessible names -------------------

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const rows = (columns: Record<string, unknown[]> | undefined, keys: string[]): number =>
  columns ? Math.min(...keys.map((key) => (Array.isArray(columns[key]) ? columns[key].length : 0))) : 0;

/** Text below the WCAG 1.4.3 minimum for its size: 4.5:1, or 3:1 for large text (24px, or 18.66px bold). */
export function lowContrast(ctx: Context): void {
  const { view, body } = ctx;
  const table = body.contrast;
  const n = rows(table as Record<string, unknown[]> | undefined, ["element", "ratio", "font_px", "bold"]);
  const dark = body.viewport?.theme === "dark";
  for (let i = 0; i < n; i++) {
    const row = table!.element[i];
    const ratio = num(table!.ratio[i]);
    const fontPx = num(table!.font_px[i]);
    if (!Number.isInteger(row) || row < 0 || row >= view.n || ratio === null || fontPx === null) continue;
    if (!view.shown(row) || view.has(row, FLAGS.aria_hidden)) continue;
    const bold = table!.bold[i] === true;
    const required = requiredRatio(fontPx, bold);
    if (ratio >= required) continue;
    emit(ctx, "low_contrast", row, null, {
      contrast_ratio: ratio,
      required_ratio: required,
      font_px: fontPx,
      bold,
      theme_dark: dark,
    });
  }
}

/** A shown control with no accessible name. */
export function unnamedControl(ctx: Context): void {
  const { view, body } = ctx;
  const table = body.unnamed_controls;
  const n = rows(table as Record<string, unknown[]> | undefined, ["element", "has_title", "icon_only"]);
  for (let i = 0; i < n; i++) {
    const row = table!.element[i];
    if (!Number.isInteger(row) || row < 0 || row >= view.n) continue;
    if (!view.shown(row) || view.has(row, FLAGS.aria_hidden)) continue;
    emit(ctx, "unnamed_control", row, null, {
      has_title: table!.has_title[i] === true,
      has_icon_only: table!.icon_only[i] === true,
    });
  }
}

/** One control hovered with the mouse and then given keyboard focus, as a sweep observed it. */
export interface HoverFocusObservation {
  /** The control's identifier (test ID or tag path), as a click's `control_id`. */
  control_id: string;
  route_template: string | null;
  viewport_width: number;
  viewport_height: number;
  /** The screen while hovered. */
  snapshot_sha256: string | null;
  /** Resting the mouse on the control opened an overlay (a tooltip, menu, popover or other positioned layer with content). */
  hover_overlay: boolean;
  /** Keyboard focus on the same control opened one. */
  focus_overlay: boolean;
  /** Keyboard focus reached the control at all; null when not tried. */
  focus_reached: boolean | null;
}

/**
 * `a11y.hover_only_content`: hovering a control opened an overlay and keyboard
 * focus on the same control did not, so keyboard users never see that content
 * (WCAG 1.4.13, 2.1.1). One finding, or none.
 */
export function hoverOnlyFindings(observation: HoverFocusObservation, options: DetectOptions = {}): Finding[] {
  const resolved = resolveOptions(options);
  if (!resolved.checks.has("hover_only_content")) return [];
  if (observation.hover_overlay !== true || observation.focus_overlay !== false) return [];
  const controlId = observation.control_id;
  if (typeof controlId !== "string" || !controlId) return [];
  const width = Number.isFinite(observation.viewport_width) ? Math.max(0, Math.round(observation.viewport_width)) : 0;
  const height = Number.isFinite(observation.viewport_height) ? Math.max(0, Math.round(observation.viewport_height)) : 0;
  const route = observation.route_template ?? null;
  return [
    {
      type: "hover_only_content",
      check: CHECK_IDS.hover_only_content,
      check_version: CHECK_VERSION,
      fingerprint: fingerprint("hover_only_content", route, viewportBand(width, resolved.viewportBands), [controlId]),
      route_template: route,
      snapshot_sha256: observation.snapshot_sha256 ?? null,
      viewport_width: width,
      viewport_height: height,
      subject: null,
      other: null,
      control_id: controlId,
      interaction_id: null,
      evidence: boundEvidence({
        hover_overlay: true,
        focus_overlay: false,
        focus_reached: typeof observation.focus_reached === "boolean" ? observation.focus_reached : null,
        structural_id: controlId.includes("/"),
      }),
    },
  ];
}

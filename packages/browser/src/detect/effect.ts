/**
 * `click.effect_not_applied`: a control declared in its markup what a click
 * must leave behind (an item removed or added, a state set, fields saved), and
 * the page did not keep it: at settle, or after a reload in the same tab. The
 * SDK measures the contract in the page; this builds the finding from those
 * measurements, so it is a pure function like every other check.
 */
import { fingerprint, viewportBand } from "./fingerprint";
import { CHECK_IDS, CHECK_VERSION, boundEvidence, resolveOptions, type DetectOptions, type Finding } from "./types";

/** What the control declared: `data-interaction-removes`, `-adds`, `-sets` or `-saves`. */
export const EFFECTS = { removes: 1, adds: 2, sets: 3, saves: 4 } as const;
export type EffectKind = (typeof EFFECTS)[keyof typeof EFFECTS];

/**
 * One judged click on a control with an effect contract. Counts and booleans
 * only: the contract's test IDs, item keys, states and field values stay in
 * the page. `null` means not measured (for example no reload yet).
 */
export interface EffectObservation {
  control_id: string;
  route_template: string | null;
  viewport_width: number;
  viewport_height: number;
  snapshot_sha256: string | null;
  /** The click's interaction ID when judged at settle; null when judged on a later page load. */
  interaction_id: string | null;
  /** 1 removes, 2 adds, 3 sets, 4 saves. */
  effect: EffectKind;
  /** Targets the control removes (items or test IDs found at the click). */
  expected_removed: number | null;
  /** Targets the control adds. */
  expected_added: number | null;
  /** Every named element showed the declared state. */
  state_held: boolean | null;
  /** Fields whose value was recorded at the click. */
  fields_saved: number | null;
  /** Of those, fields whose value later differed from it. */
  fields_reverted: number | null;
  /**
   * At settle: for removes, a target was still there; for adds, every target
   * had been added.
   */
  present_at_settle: boolean | null;
  /** Removes: a target left the page during the click and was back at settle. */
  vanished_then_returned: boolean | null;
  /** On the next load: for removes, a target was there again; for adds, every target was there. */
  present_after_reload: boolean | null;
  /** Elements matching the targets (or fields found) at the last look. */
  matches: number | null;
  request_count: number | null;
  request_failed_count: number | null;
  first_feedback_ms: number | null;
  settle_ms: number | null;
  dialog_opened: boolean;
}

const finiteOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const boolOrNull = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

/** The contract was broken: the declared effect did not happen, or did not last. */
export function effectFailed(observation: EffectObservation): boolean {
  switch (observation.effect) {
    case EFFECTS.removes:
      return (
        observation.present_at_settle === true ||
        observation.vanished_then_returned === true ||
        observation.present_after_reload === true
      );
    case EFFECTS.adds:
      return observation.present_at_settle === false || observation.present_after_reload === false;
    case EFFECTS.sets:
      return observation.state_held === false;
    case EFFECTS.saves:
      return (finiteOrNull(observation.fields_reverted) ?? 0) > 0;
    default:
      return false;
  }
}

/**
 * `click.effect_not_applied` for one observation, or nothing when the effect
 * held, the check is off, or a dialog opened (the marker belongs on the
 * dialog's confirm button). Fingerprint: check, route, viewport band and
 * `control_id`. `subject` is null.
 */
export function effectFindings(observation: EffectObservation, options: DetectOptions = {}): Finding[] {
  const resolved = resolveOptions(options);
  if (!resolved.checks.has("effect_not_applied") || !observation || observation.dialog_opened === true) return [];
  const controlId = observation.control_id;
  if (typeof controlId !== "string" || !controlId || !effectFailed(observation)) return [];
  const width = Number.isFinite(observation.viewport_width) ? Math.max(0, Math.round(observation.viewport_width)) : 0;
  const height = Number.isFinite(observation.viewport_height) ? Math.max(0, Math.round(observation.viewport_height)) : 0;
  const route = observation.route_template ?? null;
  return [
    {
      type: "effect_not_applied",
      check: CHECK_IDS.effect_not_applied,
      check_version: CHECK_VERSION,
      fingerprint: fingerprint("effect_not_applied", route, viewportBand(width, resolved.viewportBands), [controlId]),
      route_template: route,
      snapshot_sha256: observation.snapshot_sha256 ?? null,
      viewport_width: width,
      viewport_height: height,
      subject: null,
      other: null,
      control_id: controlId,
      interaction_id: observation.interaction_id ?? null,
      evidence: boundEvidence({
        effect: observation.effect,
        expected_removed: finiteOrNull(observation.expected_removed),
        expected_added: finiteOrNull(observation.expected_added),
        state_held: boolOrNull(observation.state_held),
        fields_saved: finiteOrNull(observation.fields_saved),
        fields_reverted: finiteOrNull(observation.fields_reverted),
        present_at_settle: boolOrNull(observation.present_at_settle),
        vanished_then_returned: boolOrNull(observation.vanished_then_returned),
        present_after_reload: boolOrNull(observation.present_after_reload),
        matches: finiteOrNull(observation.matches),
        request_count: finiteOrNull(observation.request_count),
        request_failed_count: finiteOrNull(observation.request_failed_count),
        first_feedback_ms: finiteOrNull(observation.first_feedback_ms),
        settle_ms: finiteOrNull(observation.settle_ms),
        // Always false: a click that opened a dialog is not judged.
        dialog_opened: false,
      }),
    },
  ];
}

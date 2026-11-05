/**
 * `@codepress/interactions-browser/detect`: checks that turn snapshots and
 * click events into findings. Pure functions over data: no `document`, no
 * `window`, the same results in a browser, in Node and in a test runner.
 *
 * A finding is a pointer, not a verdict: it says these facts were measured
 * here, with evidence. Deciding whether it is a bug is left to whoever reads it.
 */
import type { SnapshotBody } from "../format";
import { layoutFindings } from "./layout";
import { timelineFindings, type TimelineEvent } from "./timeline";
import { CHECK_NAMES, resolveOptions, type DetectOptions, type Finding } from "./types";

export { CHECK_IDS, CHECK_NAMES, CHECK_VERSION, toFindingData } from "./types";
export type { CheckName, DetectOptions, ElementRef, Evidence, Finding, FindingData } from "./types";
export type { TimelineEvent } from "./timeline";
export { fingerprint, sha256HexSync, viewportBand } from "./fingerprint";
export type { SnapshotBody } from "../format";

export interface SnapshotInput {
  body: SnapshotBody;
  /** The body's SHA-256, recorded on each finding. */
  sha256?: string | null;
}

/** Layout and image checks for one snapshot body, sorted. */
export function checkSnapshot(
  body: SnapshotBody,
  options: DetectOptions & { sha256?: string | null } = {},
): Finding[] {
  if (!body || typeof body !== "object" || !body.elements) return [];
  return sortFindings(layoutFindings(body, options.sha256 ?? null, resolveOptions(options)));
}

/**
 * Click and stability checks over a timeline of protocol v2 events (for example
 * every batch's `events`, concatenated in order), sorted. Pass `snapshots` to
 * attach the clicked element's box when its before-screen is known.
 */
export function checkEvents(
  events: readonly TimelineEvent[],
  options: DetectOptions & { snapshots?: readonly SnapshotInput[] } = {},
): Finding[] {
  const bodies = new Map<string, SnapshotBody>();
  for (const snapshot of options.snapshots ?? []) if (snapshot.sha256) bodies.set(snapshot.sha256, snapshot.body);
  return sortFindings(timelineFindings(Array.isArray(events) ? events : [], resolveOptions(options), bodies));
}

/** Every check over snapshots and a timeline together, sorted. */
export function detect(
  input: { snapshots?: readonly SnapshotInput[]; events?: readonly TimelineEvent[] },
  options: DetectOptions = {},
): Finding[] {
  const resolved = resolveOptions(options);
  const findings: Finding[] = [];
  for (const snapshot of input.snapshots ?? [])
    if (snapshot?.body?.elements) findings.push(...layoutFindings(snapshot.body, snapshot.sha256 ?? null, resolved));
  const bodies = new Map<string, SnapshotBody>();
  for (const snapshot of input.snapshots ?? []) if (snapshot?.sha256) bodies.set(snapshot.sha256, snapshot.body);
  findings.push(...timelineFindings(input.events ?? [], resolved, bodies));
  return sortFindings(findings);
}

/**
 * Priority tier, from measured evidence only:
 * 0: a control's hit test is blocked;
 * 1: text is covered or clipped;
 * 2: everything else;
 * 3: decorative: an element in the finding is a decorative layer (no text, no
 *    control, and `pointer-events: none` or `aria-hidden`), or none of its
 *    elements holds text or a control (image stacks, cropped images).
 * Earlier tiers win: a decorative layer that covers text is tier 1.
 */
export function findingTier(finding: Pick<Finding, "evidence">): 0 | 1 | 2 | 3 {
  const evidence = finding.evidence ?? {};
  for (const [key, value] of Object.entries(evidence))
    if (key.endsWith("blocked_points") && typeof value === "number" && value > 0) return 0;
  if (evidence.subject_text_covered === true || evidence.text_clipped === true) return 1;
  if (evidence.subject_decorative === true || evidence.other_decorative === true) return 3;
  const sides = ["subject_has_content", "other_has_content"].filter((key) => key in evidence);
  if (sides.length > 0 && sides.every((key) => evidence[key] === false)) return 3;
  return 2;
}

/**
 * Default order: blocked controls first, then covered text, then the rest, then
 * decorative findings (see `findingTier`); within a tier by check (in
 * `CHECK_NAMES` order), then as found. Never drops a finding.
 */
export function sortFindings<T extends Finding>(findings: readonly T[]): T[] {
  const order = (finding: T) => {
    const index = (CHECK_NAMES as readonly string[]).indexOf(finding.type);
    return index < 0 ? CHECK_NAMES.length : index;
  };
  return findings
    .map((finding, index) => ({ finding, index, tier: findingTier(finding), check: order(finding) }))
    .sort((a, b) => a.tier - b.tier || a.check - b.check || a.index - b.index)
    .map((entry) => entry.finding);
}

const label = (ref: Finding["subject"]): string => (ref ? ref.stable_id : "?");

/** One readable line per finding: check, elements, the evidence that ranks it, fingerprint. */
export function formatFinding(finding: Finding): string {
  const who = finding.subject
    ? `${label(finding.subject)}${finding.other ? ` × ${label(finding.other)}` : ""}`
    : (finding.control_id ?? "(page)");
  const facts = Object.entries(finding.evidence)
    .filter(([key, value]) => value !== null && value !== false && !key.endsWith("structural_id"))
    .map(([key, value]) => (value === true ? key : `${key}=${value}`))
    .join(" ");
  return `${finding.check} ${who} on ${finding.route_template ?? "?"} @${finding.viewport_width}x${finding.viewport_height}: ${facts} [${finding.fingerprint}]`;
}

/**
 * Click and stability checks over an event timeline (protocol v2 events in
 * the order they were recorded): dead, rage, slow and silently failing clicks,
 * errors after a click, stuck busy indicators, layout shifts and slow input.
 */
import type { SnapshotBody } from "../format";
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
import { SnapshotView } from "./view";

/** The parts of an event the checks read. Batches' `events` arrays fit as they are. */
export interface TimelineEvent {
  type: string;
  interaction_id?: string | null;
  occurred_at?: string;
  data?: Record<string, unknown> | null;
}

interface Place {
  route: string | null;
  width: number;
  height: number;
  sha256: string | null;
}

const bool = (value: unknown): boolean => value === true;
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const numOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
/** Control IDs without a test ID are tag paths (`main/form/button`). */
const structural = (controlId: string): boolean => controlId.includes("/");

export function timelineFindings(
  events: readonly TimelineEvent[],
  options: ResolvedOptions,
  snapshots?: ReadonlyMap<string, SnapshotBody>,
): Finding[] {
  const out: Finding[] = [];
  const on = (name: CheckName) => options.checks.has(name);
  const views = new Map<string, SnapshotView>();
  const place: Place = { route: null, width: 0, height: 0, sha256: null };
  const settled = new Map<string, Record<string, unknown>>();
  const starts: { id: string | null; control: string; target: number | null; at: number; place: Place }[] = [];
  const busy = new Map<string, { open: number; since: number; place: Place; control: string | null; progress: boolean }>();
  let last = -Infinity;
  // Places captured before any snapshot had a viewport; the next snapshot fills them in.
  let unplaced: Place[] = [];
  const snapshotPlace = (): Place => {
    const copy = { ...place };
    if (!(copy.width > 0)) unplaced.push(copy);
    return copy;
  };

  const subjectFor = (controlId: string, sha: string | null): ElementRef | null => {
    if (!sha || structural(controlId)) return null;
    const body = snapshots?.get(sha);
    if (!body) return null;
    let view = views.get(sha);
    if (!view) views.set(sha, (view = new SnapshotView(body)));
    const id = body.dictionaries?.test_id?.indexOf(controlId) ?? -1;
    if (id < 0) return null;
    const row = body.elements.test_id.indexOf(id);
    return row >= 0 && row < view.n ? view.ref(row) : null;
  };

  // Findings are built after the walk, once early places have their viewport.
  const later: (() => void)[] = [];
  const emit = (...args: Parameters<typeof build>) => later.push(() => build(...args));
  const build = (
    type: CheckName,
    at: Place,
    controlId: string | null,
    interactionId: string | null,
    evidence: Evidence,
    subject: ElementRef | null = null,
  ) => {
    if (controlId !== null) evidence.structural_id = structural(controlId);
    out.push({
      type,
      check: CHECK_IDS[type],
      check_version: CHECK_VERSION,
      fingerprint: fingerprint(type, at.route, viewportBand(at.width, options.viewportBands), [controlId]),
      route_template: at.route,
      snapshot_sha256: at.sha256,
      viewport_width: Math.max(0, Math.round(at.width)),
      viewport_height: Math.max(0, Math.round(at.height)),
      subject,
      other: null,
      control_id: controlId,
      interaction_id: interactionId,
      evidence: boundEvidence(evidence),
    });
  };

  for (const event of events) {
    if (!event || typeof event.type !== "string") continue;
    const data = (event.data ?? {}) as Record<string, unknown>;
    const time = Date.parse(event.occurred_at ?? "");
    if (Number.isFinite(time) && time > last) last = time;
    switch (event.type) {
      case "ui.snapshot": {
        place.width = count(data.viewport_width);
        place.height = count(data.viewport_height);
        place.route = str(data.route_template);
        place.sha256 = str(data.sha256);
        for (const early of unplaced) {
          early.width = place.width;
          early.height = place.height;
          early.route ??= place.route;
          early.sha256 ??= place.sha256;
        }
        unplaced = [];
        break;
      }
      case "interaction.started": {
        const control = str(data.control_id);
        if (data.action === "click" && control && Number.isFinite(time))
          starts.push({
            id: event.interaction_id ?? null,
            control,
            target: Number.isInteger(data.target_key) ? (data.target_key as number) : null,
            at: time,
            place: snapshotPlace(),
          });
        break;
      }
      case "ui.click.settled": {
        if (event.interaction_id) settled.set(event.interaction_id, data);
        const control = str(data.control_id);
        if (!control) break;
        if (data.route_template !== undefined) place.route = str(data.route_template);
        const sha = str(data.after_sha256) ?? str(data.before_sha256);
        const at = snapshotPlace();
        if (sha) at.sha256 = sha;
        const body = sha ? snapshots?.get(sha) : undefined;
        if (body) {
          at.width = body.viewport?.width ?? at.width;
          at.height = body.viewport?.height ?? at.height;
        }
        const subject = subjectFor(control, str(data.before_sha256) ?? sha);
        clickFindings(data, options, on, (type, evidence) =>
          emit(type, at, control, event.interaction_id ?? null, evidence, subject),
        );
        break;
      }
      case "ui.state.changed": {
        const kind = data.feedback_type;
        if (kind !== "busy" && kind !== "progress_indicator") break;
        const control = str(data.control_id);
        const key = `${kind}\u0000${control ?? ""}`;
        const phase = data.phase;
        const entry = busy.get(key);
        if (phase === "active" || phase === "appeared") {
          if (entry && entry.open > 0) entry.open++;
          else
            busy.set(key, {
              open: 1,
              since: Number.isFinite(time) ? time : NaN,
              place: snapshotPlace(),
              control,
              progress: kind === "progress_indicator",
            });
        } else if ((phase === "inactive" || phase === "removed") && entry) {
          entry.open = Math.max(0, entry.open - 1);
        }
        break;
      }
      case "perf.summary": {
        const here = snapshotPlace();
        const shift = numOrNull(data.layout_shift_score);
        if (on("layout_shift") && shift !== null && shift >= options.layoutShiftScore)
          emit("layout_shift", here, null, null, {
            layout_shift_score: shift,
            layout_shift_count: numOrNull(data.layout_shift_count),
            window_ms: numOrNull(data.window_ms),
          });
        const slowest = numOrNull(data.event_timing_max_ms);
        if (on("slow_input") && slowest !== null && slowest >= options.slowInputMs)
          emit("slow_input", here, null, null, {
            event_timing_max_ms: slowest,
            event_timing_count: numOrNull(data.event_timing_count),
            long_task_count: numOrNull(data.long_task_count),
            long_task_ms: numOrNull(data.long_task_ms),
          });
        break;
      }
    }
  }

  for (const run of later.splice(0)) run();

  if (on("rage_click")) {
    // Repeated clicks on one thing: the same clicked element within the same
    // control. Clicks on different fields of one form are not a burst. Events
    // without target_key (before 0.3.0) group by control alone.
    const byTarget = new Map<string, typeof starts>();
    for (const start of starts) {
      const key = `${start.control}\u0000${start.target ?? ""}`;
      const list = byTarget.get(key);
      if (list) list.push(start);
      else byTarget.set(key, [start]);
    }
    for (const list of byTarget.values()) {
      const control = list[0].control;
      list.sort((a, b) => a.at - b.at);
      for (let i = 0; i < list.length; ) {
        let j = i;
        while (j + 1 < list.length && list[j + 1].at - list[i].at <= options.rageClickWindowMs) j++;
        const burst = list.slice(i, j + 1);
        if (burst.length >= options.rageClickCount) {
          const data = burst.map((start) => (start.id ? settled.get(start.id) : undefined));
          const known = data.filter((d): d is Record<string, unknown> => !!d);
          const answered = known.filter((d) => d.first_feedback_ms !== null).length;
          // Rage is clicking again because nothing answered. A burst where every
          // click visibly answered (a stepper, a toggle) is not that; one still
          // settling is decided on a later run. No settled data at all (events
          // without click follow-through) cannot say, so it is reported.
          if (known.length && answered === known.length) {
            i = j + 1;
            continue;
          }
          const route = known.find((d) => d.route_template !== undefined);
          const at: Place = { ...burst[0].place, route: route ? str(route.route_template) : burst[0].place.route };
          build("rage_click", at, control, burst[burst.length - 1].id, {
            click_count: burst.length,
            span_ms: burst[burst.length - 1].at - burst[0].at,
            clicks_with_feedback: known.length ? answered : null,
            clicks_settled: known.length,
            target_interactive: known.length && known.every((d) => typeof d.target_interactive === "boolean")
              ? known.some((d) => d.target_interactive === true)
              : null,
          });
          i = j + 1;
        } else i++;
      }
    }
  }

  if (on("stuck_busy")) {
    const now = options.now ?? last;
    for (const entry of busy.values()) {
      if (entry.open <= 0 || !Number.isFinite(entry.since) || !Number.isFinite(now)) continue;
      const shown = now - entry.since;
      if (shown < options.stuckBusyMs) continue;
      build("stuck_busy", entry.place, entry.control, null, {
        busy_ms: Math.round(shown),
        open_count: entry.open,
        progress_indicator: entry.progress,
      });
    }
  }
  return out;
}

function clickFindings(
  d: Record<string, unknown>,
  options: ResolvedOptions,
  on: (name: CheckName) => boolean,
  emit: (type: CheckName, evidence: Evidence) => void,
): void {
  const firstFeedback = numOrNull(d.first_feedback_ms);
  const settle = count(d.settle_ms);
  const requests = count(d.request_count);
  const failed = count(d.request_failed_count);
  const mutations = count(d.mutation_count);
  const errors = count(d.error_count);
  // Only a window that ran to quiet says what the click did. A page that was
  // hidden (navigated away, new tab), timed out or was cut short by another
  // click tells us nothing about the missing effect.
  const complete = d.end_reason === "settled" && !bool(d.incomplete) && !bool(d.overlapped);
  const browserHandled = bool(d.new_context) || bool(d.field_focused);

  if (
    on("dead_click") &&
    complete &&
    // 0.2.0 events do not say whether a control was clicked: unknown is not dead.
    d.target_interactive === true &&
    firstFeedback === null &&
    mutations === 0 &&
    requests === 0 &&
    !bool(d.route_changed) &&
    !bool(d.dialog_opened) &&
    !bool(d.focus_moved) &&
    !bool(d.value_changed) &&
    !browserHandled
  )
    emit("dead_click", {
      settle_ms: settle,
      error_count: errors,
      long_task_count: numOrNull(d.long_task_count),
    });

  if (on("slow_feedback") && !browserHandled && (complete || d.end_reason === "timeout")) {
    const slow =
      firstFeedback !== null
        ? firstFeedback >= options.slowFeedbackMs
        : requests > 0 && settle >= options.slowFeedbackMs;
    if (slow)
      emit("slow_feedback", {
        first_feedback_ms: firstFeedback,
        settle_ms: settle,
        request_count: requests,
        long_task_count: numOrNull(d.long_task_count),
        incomplete: bool(d.incomplete),
      });
  }

  if (on("silent_failure") && failed > 0 && !bool(d.dialog_opened) && !bool(d.route_changed) && d.end_reason !== "page_hidden") {
    const before = str(d.before_sha256);
    const after = str(d.after_sha256);
    const unchanged = before && after ? before === after : null;
    if (mutations === 0 || unchanged === true)
      emit("silent_failure", {
        request_count: requests,
        request_failed_count: failed,
        mutation_count: mutations,
        screen_unchanged: unchanged,
        first_feedback_ms: firstFeedback,
      });
  }

  if (on("error_after_click") && errors > 0)
    emit("error_after_click", {
      error_count: errors,
      first_feedback_ms: firstFeedback,
      request_failed_count: failed,
      settle_ms: settle,
    });
}

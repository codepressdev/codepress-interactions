/**
 * Performance signals: layout shifts, event timing, long tasks, image load errors
 * and uncaught errors. Each is feature-detected; a missing API is reported as
 * unavailable rather than as zero. Only counts and durations are kept: error
 * messages, stacks, file names and image URLs are never read.
 */
import type { PerfSummaryData, SignalName } from "./types";
import { clampMs, now } from "./util";

export interface SignalCounters {
  layoutShiftScore: number;
  layoutShiftCount: number;
  longTaskCount: number;
  longTaskMs: number;
  eventTimingCount: number;
  eventTimingMaxMs: number;
  imageErrorCount: number;
  uncaughtErrorCount: number;
  hoversSilent: number;
  focusSilent: number;
}

export const emptyCounters = (): SignalCounters => ({
  layoutShiftScore: 0,
  layoutShiftCount: 0,
  longTaskCount: 0,
  longTaskMs: 0,
  eventTimingCount: 0,
  eventTimingMaxMs: 0,
  imageErrorCount: 0,
  uncaughtErrorCount: 0,
  hoversSilent: 0,
  focusSilent: 0,
});

const supported = (type: string): boolean =>
  typeof PerformanceObserver === "function" &&
  Array.isArray(PerformanceObserver.supportedEntryTypes) &&
  PerformanceObserver.supportedEntryTypes.includes(type);

export class PerfSignals {
  readonly available: Record<SignalName, boolean>;
  private totals = emptyCounters();
  private windowStart = now();
  private observers: PerformanceObserver[] = [];
  private removals: (() => void)[] = [];
  private listeners = new Set<(counters: Partial<SignalCounters>) => void>();

  constructor() {
    this.available = {
      layout_shift: supported("layout-shift"),
      event_timing: supported("event"),
      long_task: supported("longtask"),
      image_error: typeof document !== "undefined",
      uncaught_error: typeof window !== "undefined",
    };
  }

  /** Counts a hover or keyboard focus that changed nothing observable. */
  silent(kind: "pointer" | "focus"): void {
    this.add(kind === "pointer" ? { hoversSilent: 1 } : { focusSilent: 1 });
  }

  /** Subscribes to increments (used by click follow-through). */
  subscribe(listener: (counters: Partial<SignalCounters>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private add(delta: Partial<SignalCounters>): void {
    const totals = this.totals as unknown as Record<string, number>;
    for (const [key, value] of Object.entries(delta)) {
      if (key === "eventTimingMaxMs") totals[key] = Math.max(totals[key], value!);
      else totals[key] += value!;
    }
    for (const listener of this.listeners) {
      try {
        listener(delta);
      } catch {
        /* Never let one consumer break another. */
      }
    }
  }

  start(): void {
    const observe = (type: string, options: PerformanceObserverInit, handle: (entry: PerformanceEntry) => void) => {
      try {
        const observer = new PerformanceObserver((list) => {
          try {
            for (const entry of list.getEntries()) handle(entry);
          } catch {
            /* Observation must never affect the page. */
          }
        });
        observer.observe({ type, ...options });
        this.observers.push(observer);
      } catch {
        /* Reported as available by supportedEntryTypes but refused: ignore. */
      }
    };
    if (this.available.layout_shift)
      observe("layout-shift", {}, (entry) => {
        const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
        if (shift.hadRecentInput) return;
        this.add({ layoutShiftScore: shift.value, layoutShiftCount: 1 });
      });
    if (this.available.long_task)
      observe("longtask", {}, (entry) =>
        this.add({ longTaskCount: 1, longTaskMs: entry.duration }),
      );
    if (this.available.event_timing)
      observe("event", { durationThreshold: 40 } as PerformanceObserverInit, (entry) =>
        this.add({ eventTimingCount: 1, eventTimingMaxMs: entry.duration }),
      );
    const onError = (event: Event) => {
      try {
        if (event.target instanceof HTMLImageElement) this.add({ imageErrorCount: 1 });
        else if (event instanceof ErrorEvent) this.add({ uncaughtErrorCount: 1 });
      } catch {
        /* ignore */
      }
    };
    const onRejection = () => this.add({ uncaughtErrorCount: 1 });
    // Capture phase sees image load errors, which do not bubble. Passive: never
    // prevents default handling or reporting of the error.
    window.addEventListener("error", onError, true);
    window.addEventListener("unhandledrejection", onRejection);
    this.removals.push(
      () => window.removeEventListener("error", onError, true),
      () => window.removeEventListener("unhandledrejection", onRejection),
    );
  }

  /** Returns and resets the totals since the previous call, or null when nothing happened. */
  takeSummary(force = false): PerfSummaryData | null {
    const t = this.totals;
    const any =
      t.layoutShiftCount || t.longTaskCount || t.eventTimingCount ||
      t.imageErrorCount || t.uncaughtErrorCount || t.hoversSilent || t.focusSilent;
    if (!any && !force) return null;
    const a = this.available;
    const at = now();
    const summary: PerfSummaryData = {
      window_ms: clampMs(at - this.windowStart),
      layout_shift_score: a.layout_shift ? Math.round(t.layoutShiftScore * 10000) / 10000 : null,
      layout_shift_count: a.layout_shift ? t.layoutShiftCount : null,
      long_task_count: a.long_task ? t.longTaskCount : null,
      long_task_ms: a.long_task ? clampMs(t.longTaskMs) : null,
      event_timing_count: a.event_timing ? t.eventTimingCount : null,
      event_timing_max_ms: a.event_timing ? clampMs(t.eventTimingMaxMs) : null,
      image_error_count: a.image_error ? t.imageErrorCount : null,
      uncaught_error_count: a.uncaught_error ? t.uncaughtErrorCount : null,
      unavailable: (Object.keys(a) as SignalName[]).filter((name) => !a[name]),
      hovers_silent: Math.min(1_000_000, t.hoversSilent),
      focus_silent: Math.min(1_000_000, t.focusSilent),
    };
    this.totals = emptyCounters();
    this.windowStart = at;
    return summary;
  }

  stop(): void {
    for (const observer of this.observers) observer.disconnect();
    this.observers = [];
    for (const remove of this.removals) remove();
    this.removals = [];
    this.listeners.clear();
  }
}

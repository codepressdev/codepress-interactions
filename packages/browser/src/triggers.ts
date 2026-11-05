/**
 * When to take snapshots: route settled (including the first load), resize
 * settled and tab visible again. Click-settled snapshots are requested by click
 * follow-through. Nothing runs while the tab is hidden.
 */
import type { SnapshotTrigger } from "./types";

export interface TriggerHost {
  routeSettleMs: number;
  resizeSettleMs: number;
  visibleSettleMs: number;
  run(trigger: SnapshotTrigger): void;
}

export class SnapshotTriggers {
  private routeTimer?: ReturnType<typeof setTimeout>;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private visibleTimer?: ReturnType<typeof setTimeout>;
  private removals: (() => void)[] = [];

  constructor(private host: TriggerHost) {}

  start(): void {
    const onResize = () => {
      clearTimeout(this.resizeTimer);
      if (hidden()) return;
      this.resizeTimer = setTimeout(() => this.fire("resize"), this.host.resizeSettleMs);
    };
    const onVisibility = () => {
      if (hidden()) {
        this.cancel();
        return;
      }
      clearTimeout(this.visibleTimer);
      this.visibleTimer = setTimeout(() => this.fire("visible"), this.host.visibleSettleMs);
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    this.removals.push(
      () => window.removeEventListener("resize", onResize),
      () => document.removeEventListener("visibilitychange", onVisibility),
    );
    // The first screen is a settled route.
    this.routeChanged();
  }

  /** A route changed: snapshot after routeSettleMs without another route change. */
  routeChanged(): void {
    clearTimeout(this.routeTimer);
    if (hidden()) return;
    this.routeTimer = setTimeout(() => this.fire("route"), this.host.routeSettleMs);
  }

  private fire(trigger: SnapshotTrigger): void {
    if (hidden()) return;
    try {
      this.host.run(trigger);
    } catch {
      /* Never affect the page. */
    }
  }

  private cancel(): void {
    clearTimeout(this.routeTimer);
    clearTimeout(this.resizeTimer);
    clearTimeout(this.visibleTimer);
  }

  stop(): void {
    this.cancel();
    for (const remove of this.removals) remove();
    this.removals = [];
  }
}

const hidden = (): boolean => document.visibilityState === "hidden";

/**
 * Motion observation: CSS animations and transitions, from their bubbling
 * events on `document` (capture phase), long animation frames where the
 * browser reports them, and a sweep that only runs while something animates.
 * Each run becomes a `MotionRun` (numbers and booleans only) for the pure
 * checks in `detect/motion.ts`. Animation names, property names and values
 * are read to match events to animations and are never stored in a run or sent.
 */
import { motionFindings, JANK_BLOCKING_MS, type MotionRun } from "./detect/motion";
import type { CheckName, ElementRef, Finding, ResolvedOptions } from "./detect/types";
import { POSITIONS } from "./format";
import { roleOf, tagOf } from "./snapshot";
import { elementTestId, type TestIdFilter } from "./util";

export const MOTION_EVENTS = [
  "animationstart",
  "animationend",
  "animationcancel",
  "transitionrun",
  "transitionend",
  "transitioncancel",
] as const;

/** Runs followed at once; starts past this are counted in `recentMotion` only. */
const MAX_RUNS = 256;
/** Runs resolved per animation frame; the rest wait for the next frame. */
const MAX_RESOLVE = 128;
/** Visibility looks (layout reads) per sweep. */
const MAX_LOOKS = 200;
/** A loop seen visible is looked at again after its interval doubles, up to this many loop windows. */
const MAX_BACKOFF = 16;
/** Infinite runs followed by event; more are left to the sweep, which finds them with `document.getAnimations()`. */
const MAX_LOOPS = 64;
/** Ended runs kept for long animation frames reported after they ended. */
const MAX_ENDED = 64;
/** Starts remembered for `recentMotion`. */
const MAX_RECENT = 128;
/** Findings per motion check per page session. */
const MAX_PER_CHECK = 50;
/** Ancestors checked for `opacity: 0`. */
const MAX_OPACITY_DEPTH = 32;
/** Structural paths stop after this many tags (as in snapshot `stable_id`). */
const PATH_DEPTH = 8;
/** Loops followed without events (found by discovery or past MAX_LOOPS). */
const MAX_KNOWN = 1024;
/** The sweep never runs more often than this. */
const MIN_SWEEP_MS = 100;

const MOTION_CHECKS: readonly CheckName[] = [
  "layout_animation",
  "stuck_animation",
  "offscreen_loop",
  "janky_animation",
  "reduced_motion_ignored",
];

const LAYOUT_PROPS = /^(width|height|top|left|right|bottom|margin(-.*)?|padding(-.*)?|inset(-.*)?)$/;
const MOTION_PROPS = /^(transform|translate|rotate|scale|offset-.*|top|left|right|bottom|inset(-.*)?|opacity)$/;
/** Keyframe keys that are not animated properties. */
const KEYFRAME_META = new Set(["offset", "computedOffset", "easing", "composite"]);

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const r2 = (value: number): number => {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
};

interface Run {
  el: Element;
  transition: boolean;
  /** In memory only, to match end events and animations: never stored in a MotionRun. */
  name: string;
  pseudo: string;
  start: number;
  endedAt: number | null;
  anim: Animation | null;
  resolved: boolean;
  duration: number | null;
  infinite: boolean;
  layout: number;
  motion: number;
  opacity: boolean;
  reduced: boolean;
  ref: ElementRef | null;
  area: number;
  longFrames: number;
  maxBlocking: number;
  /** Infinite runs: when visibility is looked at next, and the interval (doubled each time it is visible). */
  nextLook: number;
  lookEvery: number;
  /** Long frames already looked at for jank. */
  framesLooked: number;
}

interface Look {
  visible: boolean;
  zero_box: boolean;
  outside_document: boolean;
  visibility_hidden: boolean;
  aria_hidden: boolean;
  transparent: boolean;
}

/** An infinite animation the sweep found: facts read once, and when to look again. */
interface Loop {
  el: Element;
  stable: string;
  opacity: boolean;
  nextLook: number;
  lookEvery: number;
}

export interface MotionDeps {
  root: Element;
  testId?: TestIdFilter;
  options: ResolvedOptions;
  route(): string | null;
  snapshotHash(): string | null;
  emit(findings: Finding[]): void;
}

export interface RecentMotion {
  animations: number;
  transitions: number;
}

const supported = (type: string): boolean =>
  typeof PerformanceObserver === "function" &&
  Array.isArray(PerformanceObserver.supportedEntryTypes) &&
  PerformanceObserver.supportedEntryTypes.includes(type);

export class MotionTracker {
  /** `long-animation-frame` entries are reported (janky_animation needs them). */
  readonly longFrames = supported("long-animation-frame");
  private runs: Run[] = [];
  private ended: Run[] = [];
  private pending: Run[] = [];
  private recent: { el: Element; transition: boolean; at: number }[] = [];
  /** Check, route and stable ID of every finding sent (at most MAX_PER_CHECK per check). */
  private reported = new Set<string>();
  private perCheck = new Map<CheckName, number>();
  /** Infinite animations found by the sweep rather than by an event, with what was learned once about each. */
  private loops = new WeakMap<Animation, Loop | null>();
  /** How often the sweep looks for loops no event announced: doubles while it finds none. */
  private discoverEvery = 0;
  /** When the sweep next calls `document.getAnimations()`. */
  private discoverAt = 0;
  /** Loops found by discovery or past the follow limit, looked at when due. */
  private known: { anim: Animation; loop: Loop }[] = [];
  private observing = false;
  private frame = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerAt = Infinity;
  private reducedQuery: MediaQueryList | null = null;
  private observer: PerformanceObserver | null = null;
  private removals: (() => void)[] = [];
  private active = false;
  private readonly on: (name: CheckName) => boolean;
  /** Some motion check is on: runs are followed (otherwise only `recentMotion` is kept). */
  private readonly follow: boolean;
  private readonly sweeps: boolean;

  constructor(private deps: MotionDeps) {
    this.on = (name) => deps.options.checks.has(name);
    this.follow = MOTION_CHECKS.some(this.on);
    this.sweeps = this.on("stuck_animation") || this.on("offscreen_loop") || this.on("janky_animation");
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    const listener = (event: Event) => {
      try {
        this.onEvent(event);
      } catch {
        /* Observation must never affect the page. */
      }
    };
    for (const type of MOTION_EVENTS) {
      document.addEventListener(type, listener, { capture: true, passive: true });
      this.removals.push(() => document.removeEventListener(type, listener, { capture: true }));
    }
    if (!this.follow) return;
    try {
      this.reducedQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    } catch {
      this.reducedQuery = null;
    }
    if (this.longFrames && this.on("janky_animation")) {
      try {
        this.observer = new PerformanceObserver((list) => {
          try {
            for (const entry of list.getEntries()) this.onLongFrame(entry);
          } catch {
            /* ignore */
          }
        });
        this.observer.observe({ type: "long-animation-frame" });
      } catch {
        this.observer = null;
      }
    }
    // Animations already running at start (or started without events, by the
    // Web Animations API) are found by a first sweep, once a loop could be due.
    if (this.on("offscreen_loop")) this.schedule(performance.now() + this.deps.options.offscreenLoopMs + 1);
  }

  stop(): void {
    this.active = false;
    for (const remove of this.removals.splice(0)) remove();
    this.observer?.disconnect();
    this.observer = null;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = Infinity;
    this.runs = [];
    this.ended = [];
    this.pending = [];
    this.recent = [];
    this.known = [];
  }

  /**
   * Animations and transitions that started on `element` or inside it at or
   * after `sinceMs` (a `performance.now()` time). Remembers the last 128
   * starts. For hover and focus follow-through.
   */
  recentMotion(element: Element, sinceMs: number): RecentMotion {
    const out = { animations: 0, transitions: 0 };
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const start = this.recent[i];
      if (start.at < sinceMs) break;
      if (start.el === element || element.contains(start.el)) {
        if (start.transition) out.transitions++;
        else out.animations++;
      }
    }
    return out;
  }

  // ---- Events ------------------------------------------------------------

  private onEvent(event: Event): void {
    if (!this.active) return;
    const el = event.target;
    if (!(el instanceof Element) || !this.deps.root.contains(el)) return;
    const transition = event.type.startsWith("transition");
    const at = performance.now();
    const begins = event.type === "animationstart" || event.type === "transitionrun";
    if (begins) {
      this.recent.push({ el, transition, at });
      if (this.recent.length > MAX_RECENT) this.recent.splice(0, this.recent.length - MAX_RECENT);
    }
    if (!this.follow || el.closest("[data-interactions-exclude]")) return;
    const name = transition ? (event as TransitionEvent).propertyName : (event as AnimationEvent).animationName;
    const pseudo = (event as AnimationEvent).pseudoElement ?? "";
    if (begins) {
      if (this.runs.length >= MAX_RUNS) {
        // Past the follow limit: the next discovery finds it if it loops.
        this.rediscover();
        return;
      }
      const run: Run = {
        el,
        transition,
        name,
        pseudo,
        start: at,
        endedAt: null,
        anim: null,
        resolved: false,
        duration: null,
        infinite: false,
        layout: 0,
        motion: 0,
        opacity: false,
        reduced: this.reducedQuery?.matches === true,
        ref: null,
        area: 0,
        longFrames: 0,
        maxBlocking: 0,
        nextLook: 0,
        lookEvery: 0,
        framesLooked: 0,
      };
      this.runs.push(run);
      this.pending.push(run);
      this.requestFrame();
      return;
    }
    const run = this.runs.find(
      (r) => r.el === el && r.endedAt === null && r.transition === transition && r.name === name && r.pseudo === pseudo,
    );
    if (!run) return;
    run.endedAt = at;
    // A transition's elapsed time at its end is its duration; a run that ends
    // before it is resolved has no animation left to read it from.
    if (!run.resolved && event.type === "transitionend")
      run.duration = Math.round((event as TransitionEvent).elapsedTime * 1000);
    if (run.resolved) this.finish(run);
  }

  private requestFrame(): void {
    if (this.frame) return;
    const next = () => {
      this.frame = 0;
      try {
        this.resolvePending();
      } catch {
        /* ignore */
      }
    };
    this.frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(next) : (setTimeout(next, 16) as unknown as number);
  }

  /** Reads each new run's animation, keyframes and box: one batch per frame, one box read per element. */
  private resolvePending(): void {
    if (!this.active) return;
    const batch = this.pending.splice(0, MAX_RESOLVE);
    if (this.pending.length) this.requestFrame();
    const animations = new Map<Element, Animation[]>();
    const boxes = new Map<Element, DOMRect | null>();
    for (const run of batch) {
      const el = run.el;
      let list = animations.get(el);
      if (!list) {
        list = el.isConnected && typeof el.getAnimations === "function" ? el.getAnimations({ subtree: true }) : [];
        animations.set(el, list);
      }
      const anim =
        list.find((a) => {
          const effect = a.effect as KeyframeEffect | null;
          if (!effect || effect.target !== el || (effect.pseudoElement ?? "") !== run.pseudo) return false;
          return run.transition
            ? (a as CSSTransition).transitionProperty === run.name
            : (a as CSSAnimation).animationName === run.name;
        }) ?? null;
      let props: string[] = [];
      if (run.transition) props = [run.name];
      if (anim) {
        run.anim = anim;
        const effect = anim.effect as KeyframeEffect;
        const timing = effect.getComputedTiming();
        run.infinite = timing.iterations === Infinity;
        const active = Number(timing.activeDuration);
        run.duration = run.infinite || !Number.isFinite(active) ? null : Math.round(active);
        if (!run.transition) {
          const keys = new Set<string>();
          for (const frame of effect.getKeyframes())
            for (const key of Object.keys(frame)) if (!KEYFRAME_META.has(key)) keys.add(kebab(key));
          props = [...keys];
        }
      }
      for (const prop of props) {
        if (LAYOUT_PROPS.test(prop)) run.layout++;
        if (MOTION_PROPS.test(prop)) run.motion++;
        if (prop === "opacity") run.opacity = true;
      }
      if (!boxes.has(el)) boxes.set(el, el.isConnected ? el.getBoundingClientRect() : null);
      const box = boxes.get(el) ?? null;
      run.ref = this.elementRef(el, box);
      run.area = box ? Math.round(Math.max(0, box.width) * Math.max(0, box.height)) : 0;
      run.resolved = true;
      this.evaluate(run, null);
      if (run.endedAt !== null) this.finish(run);
      else if (run.infinite && this.runs.filter((r) => r.infinite).length > MAX_LOOPS) {
        this.runs.splice(this.runs.indexOf(run), 1);
        this.adopt(run);
      }
      else if (this.sweeps) {
        if (run.infinite) {
          run.lookEvery = this.deps.options.offscreenLoopMs;
          run.nextLook = run.start + run.lookEvery + 1;
        }
        this.schedule(run.infinite ? run.nextLook : run.start + this.deps.options.stuckAnimationMs);
      }
    }
  }

  /** An ended run: reported for jank if long frames overlapped it, then kept briefly for late frames. */
  private finish(run: Run): void {
    const index = this.runs.indexOf(run);
    if (index >= 0) this.runs.splice(index, 1);
    if (run.longFrames > 0) this.evaluate(run, this.look(run));
    this.ended.push(run);
    if (this.ended.length > MAX_ENDED) this.ended.splice(0, this.ended.length - MAX_ENDED);
  }

  private onLongFrame(entry: PerformanceEntry): void {
    const blocking = (entry as PerformanceEntry & { blockingDuration?: number }).blockingDuration;
    if (!this.active || typeof blocking !== "number" || !(blocking > JANK_BLOCKING_MS)) return;
    const from = entry.startTime;
    const to = entry.startTime + entry.duration;
    let hit = false;
    for (const list of [this.runs, this.ended])
      for (const run of list) {
        if (run.start > to || (run.endedAt !== null && run.endedAt < from)) continue;
        run.longFrames = Math.min(run.longFrames + 1, 1e6);
        run.maxBlocking = Math.max(run.maxBlocking, blocking);
        if (run.endedAt !== null && run.resolved) this.evaluate(run, this.look(run));
        else hit = true;
      }
    if (hit) this.schedule(performance.now());
  }

  // ---- Sweep -------------------------------------------------------------

  /** An infinite run past the follow limit becomes a known loop, so no discovery is needed for it. */
  private adopt(run: Run): void {
    if (!run.anim || this.loops.has(run.anim)) return;
    const loop = this.loopOf(run.anim);
    this.loops.set(run.anim, loop);
    if (!loop || this.known.length >= MAX_KNOWN) return;
    loop.nextLook = run.start + loop.lookEvery + 1;
    this.known.push({ anim: run.anim, loop });
    this.schedule(loop.nextLook);
  }

  /** Discover again within a loop window (an animation started that no run follows). */
  private rediscover(): void {
    if (!this.on("offscreen_loop")) return;
    const at = performance.now() + this.deps.options.offscreenLoopMs;
    if (this.discoverAt > at) {
      this.discoverAt = at;
      this.discoverEvery = 0;
    }
    this.schedule(this.discoverAt);
  }

  private schedule(at: number): void {
    if (!this.active || !this.sweeps) return;
    const when = Math.max(at, performance.now() + 0);
    if (this.timer !== undefined && this.timerAt <= when) return;
    clearTimeout(this.timer);
    this.timerAt = when;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerAt = Infinity;
      try {
        this.sweep();
      } catch {
        /* ignore */
      }
    }, Math.max(0, when - performance.now()));
  }

  private sweep(): void {
    if (!this.active) return;
    const now = performance.now();
    const { stuckAnimationMs } = this.deps.options;
    const route = this.deps.route();
    const lookForLoops = this.on("offscreen_loop") && (this.perCheck.get("offscreen_loop") ?? 0) < MAX_PER_CHECK;
    let budget = MAX_LOOKS;
    let next = Infinity;
    let loops = false;
    const later = (at: number) => {
      next = Math.min(next, at);
    };
    for (const run of [...this.runs]) {
      if (!run.resolved || !run.ref) continue;
      // Removed with its element (no cancel event reaches the document) or finished unseen.
      const state = run.anim?.playState;
      if (!run.el.isConnected || state === "finished" || state === "idle") {
        this.runs.splice(this.runs.indexOf(run), 1);
        continue;
      }
      const elapsed = now - run.start;
      const jank = run.longFrames > run.framesLooked;
      if (run.infinite) {
        loops = true;
        const due = lookForLoops && now >= run.nextLook && !this.done(run.ref.stable_id, "offscreen_loop", route);
        if (!due && !jank) {
          if (lookForLoops && run.nextLook > now) later(run.nextLook);
          continue;
        }
        if (budget <= 0) {
          later(now + 5 * MIN_SWEEP_MS);
          continue;
        }
        budget--;
        run.framesLooked = run.longFrames;
        this.evaluate(run, this.look(run), now);
        if (due) {
          run.lookEvery = this.backoff(run.lookEvery);
          run.nextLook = now + run.lookEvery;
          later(run.nextLook);
        }
      } else if (elapsed >= stuckAnimationMs || jank) {
        let look: Look | null = null;
        if (jank && budget > 0) {
          budget--;
          run.framesLooked = run.longFrames;
          look = this.look(run);
        }
        this.evaluate(run, look, now);
        // Past its deadline a run has been judged: stop following it, so a run
        // that never ends (or stays paused) does not hold a place for good.
        if (elapsed >= stuckAnimationMs && !(jank && !look)) this.runs.splice(this.runs.indexOf(run), 1);
        else if (elapsed < stuckAnimationMs) later(run.start + stuckAnimationMs);
        else later(now + MIN_SWEEP_MS);
      } else later(run.start + stuckAnimationMs);
    }
    if (lookForLoops) {
      loops = this.sweepUntracked(now, budget, route, later) || loops;
      // While something loops, discovery stays scheduled (sweepUntracked spaces it out).
      if (loops || this.known.length) later(Math.max(now + MIN_SWEEP_MS, this.discoverAt));
    }
    // A page with no animation schedules nothing.
    if (Number.isFinite(next)) this.schedule(Math.max(next, now + MIN_SWEEP_MS));
  }

  /**
   * Infinite animations no followed run covers: started before the SDK, by the
   * Web Animations API, or past the follow limit. `document.getAnimations()`
   * costs time in proportion to every animation on the page, so it runs only
   * to discover loops (a loop window after start or after a new one appeared,
   * then less and less often); looks visit the known loops that are due.
   */
  private sweepUntracked(
    now: number,
    budget: number,
    route: string | null,
    later: (at: number) => void,
  ): boolean {
    const { offscreenLoopMs } = this.deps.options;
    if (now >= this.discoverAt && typeof document.getAnimations === "function") {
      const tracked = new Set(this.runs.map((run) => run.anim));
      let fresh = false;
      for (const anim of document.getAnimations()) {
        if (tracked.has(anim) || this.loops.has(anim)) continue;
        fresh = true;
        const loop = this.loopOf(anim);
        this.loops.set(anim, loop);
        if (loop && this.known.length < MAX_KNOWN) this.known.push({ anim, loop });
      }
      this.discoverEvery = fresh || !this.discoverEvery ? offscreenLoopMs : this.backoff(this.discoverEvery);
      this.discoverAt = now + this.discoverEvery;
    }
    for (let i = this.known.length - 1; i >= 0; i--) {
      const { anim, loop } = this.known[i];
      if (now < loop.nextLook) {
        later(loop.nextLook);
        continue;
      }
      const state = anim.playState;
      if (state === "idle" || state === "finished" || !loop.el.isConnected) {
        this.known.splice(i, 1);
        continue;
      }
      const current = Number(anim.currentTime);
      if (state !== "running" || !Number.isFinite(current)) {
        loop.nextLook = now + loop.lookEvery;
        later(loop.nextLook);
        continue;
      }
      if (current <= offscreenLoopMs) {
        loop.nextLook = now + offscreenLoopMs - current + 1;
        later(loop.nextLook);
        continue;
      }
      if (this.done(loop.stable, "offscreen_loop", route)) {
        this.known.splice(i, 1);
        continue;
      }
      if (budget <= 0) {
        loop.nextLook = now + 5 * MIN_SWEEP_MS;
        later(loop.nextLook);
        continue;
      }
      budget--;
      loop.nextLook = now + loop.lookEvery;
      loop.lookEvery = this.backoff(loop.lookEvery);
      later(loop.nextLook);
      const box = loop.el.getBoundingClientRect();
      const run: Run = {
        el: loop.el,
        transition: false,
        name: "",
        pseudo: (anim.effect as KeyframeEffect | null)?.pseudoElement ?? "",
        start: now - current,
        endedAt: null,
        anim,
        resolved: true,
        duration: null,
        infinite: true,
        layout: 0,
        motion: 0,
        opacity: loop.opacity,
        reduced: false,
        ref: this.elementRef(loop.el, box),
        area: Math.round(Math.max(0, box.width) * Math.max(0, box.height)),
        longFrames: 0,
        maxBlocking: 0,
        nextLook: 0,
        lookEvery: 0,
        framesLooked: 0,
      };
      this.evaluate(run, this.look(run), now, ["offscreen_loop"]);
    }
    return this.known.length > 0;
  }

  /** What does not change about an infinite animation, read once; null when it is not one to follow. */
  private loopOf(anim: Animation): Loop | null {
    const effect = anim.effect as KeyframeEffect | null;
    const el = effect?.target;
    if (
      !effect ||
      !(el instanceof Element) ||
      !this.deps.root.contains(el) ||
      effect.getComputedTiming().iterations !== Infinity ||
      el.closest("[data-interactions-exclude]")
    )
      return null;
    return {
      el,
      stable: this.stableId(el),
      opacity: effect.getKeyframes().some((frame) => "opacity" in frame),
      nextLook: 0,
      lookEvery: this.deps.options.offscreenLoopMs,
    };
  }

  private backoff(every: number): number {
    return Math.min(every * 2, this.deps.options.offscreenLoopMs * MAX_BACKOFF);
  }

  // ---- Measuring and reporting -----------------------------------------------

  /** Why the run's element may not be visible. Layout reads: only from the sweep or for a janky run. */
  private look(run: Run): Look {
    const el = run.el;
    const detached = !el.isConnected;
    const box = detached ? null : el.getBoundingClientRect();
    const zero = !box || box.width <= 0 || box.height <= 0;
    const doc = document.documentElement;
    const outside =
      detached ||
      (!!box &&
        (box.right + scrollX <= 0 ||
          box.bottom + scrollY <= 0 ||
          box.left + scrollX >= Math.max(doc.scrollWidth, doc.clientWidth) ||
          box.top + scrollY >= Math.max(doc.scrollHeight, doc.clientHeight)));
    const style = detached ? null : getComputedStyle(el);
    const hidden = !!style && style.visibility !== "visible";
    const aria = !!el.closest('[aria-hidden="true"]');
    let transparent = false;
    // The element's own opacity is not looked at while it animates opacity (a fade).
    let at: Element | null = run.opacity ? el.parentElement : el;
    for (let depth = 0; at && !detached && depth < MAX_OPACITY_DEPTH; depth++, at = at.parentElement)
      if (getComputedStyle(at).opacity === "0") {
        transparent = true;
        break;
      }
    return {
      visible: !(zero || outside || hidden || aria || transparent),
      zero_box: zero,
      outside_document: outside,
      visibility_hidden: hidden,
      aria_hidden: aria,
      transparent,
    };
  }

  private done(stableId: string, check: CheckName, route: string | null): boolean {
    return this.reported.has(`${check}\u0000${route ?? ""}\u0000${stableId}`);
  }

  /** Runs the pure checks on one run and sends what is new: one finding per check, element and route. */
  private evaluate(run: Run, look: Look | null, now = performance.now(), only?: CheckName[]): void {
    if (!run.ref || !this.active) return;
    const route = this.deps.route();
    const motionRun: MotionRun = {
      subject: run.ref,
      route_template: route,
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight,
      snapshot_sha256: this.deps.snapshotHash(),
      transition: run.transition,
      elapsed_ms: (run.endedAt ?? now) - run.start,
      ended: run.endedAt !== null,
      running: run.anim ? run.anim.playState === "running" : null,
      duration_ms: run.duration,
      infinite: run.infinite,
      layout_props: run.layout,
      motion_props: run.motion,
      element_area_px: run.area,
      visible: look ? look.visible : null,
      zero_box: look ? look.zero_box : null,
      outside_document: look ? look.outside_document : null,
      visibility_hidden: look ? look.visibility_hidden : null,
      aria_hidden: look ? look.aria_hidden : null,
      transparent: look ? look.transparent : null,
      reduced_motion: run.reduced,
      long_frames: run.longFrames,
      max_blocking_ms: run.maxBlocking,
    };
    const findings = motionFindings([motionRun], this.deps.options).filter((finding) => {
      if (only && !only.includes(finding.type)) return false;
      const count = this.perCheck.get(finding.type) ?? 0;
      if (count >= MAX_PER_CHECK) return false;
      const key = `${finding.type}\u0000${route ?? ""}\u0000${finding.subject?.stable_id ?? ""}`;
      if (this.reported.has(key)) return false;
      this.reported.add(key);
      this.perCheck.set(finding.type, count + 1);
      return true;
    });
    if (findings.length) this.deps.emit(findings);
  }

  /** Test ID, else a structural path from the nearest ancestor with one, as in a snapshot's `stable_id`. */
  private stableId(el: Element): string {
    const filter = this.deps.testId;
    const own = elementTestId(el, filter);
    if (own) return own;
    const tags: string[] = [];
    let anchor: string | null = null;
    let at: Element | null = el;
    while (at && tags.length < PATH_DEPTH) {
      const id = at === el ? undefined : elementTestId(at, filter);
      if (id) {
        anchor = `#${id}`;
        break;
      }
      tags.unshift(tagOf(at));
      at = at === this.deps.root ? null : (at.parentElement ?? ((at.parentNode as ShadowRoot | null)?.host ?? null));
    }
    const prefix = anchor ?? (at ? "*" : null);
    return (prefix ? [prefix, ...tags] : tags).join("/");
  }

  /** The element as a finding names it: as in a snapshot, but not a row of one (`index` -1). */
  private elementRef(el: Element, box: DOMRect | null): ElementRef {
    const own = elementTestId(el, this.deps.testId) ?? null;
    const stable = own ?? this.stableId(el);
    let position = 0;
    let z: number | null = null;
    try {
      const style = getComputedStyle(el);
      position = Math.max(0, POSITIONS.indexOf(style.position as (typeof POSITIONS)[number]));
      const parsed = style.zIndex === "auto" ? null : parseInt(style.zIndex, 10);
      z = parsed === null || !Number.isFinite(parsed) ? null : Math.max(-2147483648, Math.min(2147483647, parsed));
    } catch {
      /* detached */
    }
    return {
      index: -1,
      tag: tagOf(el),
      role: roleOf(el),
      test_id: own,
      stable_id: stable,
      x: box ? r2(box.left) : 0,
      y: box ? r2(box.top) : 0,
      width: box ? r2(Math.max(0, box.width)) : 0,
      height: box ? r2(Math.max(0, box.height)) : 0,
      position: POSITIONS[position],
      z_index: z,
    };
  }
}

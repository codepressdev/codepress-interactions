/**
 * The snapshot walker as a page script, for test runners that inject it into a
 * page (see @codepress/interactions-playwright). Defines
 * `globalThis.__codepressInteractions.walk(options)`, which resolves with a
 * snapshot body, `.defaultTestIdFilter` for a `testId` hook running in the page,
 * `.hook(source)`, which rebuilds a test runner's `testId` function from its
 * source, and `.sweep(setup)`, which starts the in-page half of a hover and
 * focus sweep (sweep.ts). Bundled to a string at build time as `PAGE_SCRIPT`.
 */
import { walkSnapshot } from "./snapshot";
import { Sweep, type SweepSetup } from "./sweep";
import { defaultRouteTemplate, defaultTestIdFilter, safeRoute, type TestIdFilter } from "./util";

export interface PageWalkOptions {
  /** CSS selector of the walk root. Default: the document element. */
  root?: string;
  maxElements?: number;
  ignoreSelector?: string;
  /** Route template to record. Default: the default template of the current URL with `routeSegments`. */
  routeTemplate?: string | null;
  routeSegments?: string[];
  /** Theme to record. Default: prefers-color-scheme (Playwright's `colorScheme` / `emulateMedia`). */
  theme?: string;
  /** Test ID filter; replaces the default (`defaultTestIdFilter`). Must be a function created in the page. */
  testId?: TestIdFilter;
}

async function walk(options: PageWalkOptions = {}) {
  const root = options.root ? document.querySelector(options.root) : document.documentElement;
  if (!root) throw new Error(`No element matches ${options.root}`);
  const route =
    options.routeTemplate !== undefined
      ? safeRoute(options.routeTemplate)
      : defaultRouteTemplate(new URL(location.href), options.routeSegments ?? []);
  const result = await walkSnapshot({
    root,
    maxElements: Math.min(Math.max(1, Math.floor(options.maxElements ?? 50000)), 50000),
    // One slice: a test page is walked in one go, so it is never torn.
    maxSliceMs: Number.MAX_SAFE_INTEGER,
    ignoreSelector: options.ignoreSelector ?? "",
    routeTemplate: route,
    shouldAbort: () => false,
    theme: options.theme === undefined ? undefined : () => options.theme,
    testId: typeof options.testId === "function" ? options.testId : undefined,
  });
  if (!result) throw new Error("snapshot walk was abandoned");
  return result.body;
}

/** Rebuilds a function from its source (an arrow, a function expression or method shorthand); throws when that is impossible. */
function hook(source: string): TestIdFilter {
  let filter: unknown;
  try {
    filter = (0, eval)(`(${source})`);
  } catch {
    try {
      // Method shorthand (`testId(value) { … }`) is not an expression on its own.
      filter = Object.values((0, eval)(`({${source}})`) as object)[0];
    } catch {
      // Bound and native functions have no source to rebuild.
    }
  }
  if (typeof filter !== "function")
    throw new Error("testId must be a self-contained function: bound and native functions cannot run in the page");
  return filter as TestIdFilter;
}

let current: Sweep | null = null;

/** Starts a sweep, stopping any earlier one in this page. */
function sweep(setup: SweepSetup): Sweep {
  current?.stop();
  current = new Sweep(setup);
  return current;
}

(globalThis as unknown as { __codepressInteractions?: unknown }).__codepressInteractions = {
  walk,
  defaultTestIdFilter,
  hook,
  sweep,
};

/**
 * The snapshot walker as a page script, for test runners that inject it into a
 * page (see @codepress/interactions-playwright). Defines
 * `globalThis.__codepressInteractions.walk(options)`, which resolves with a
 * snapshot body. Bundled to a string at build time as `PAGE_SCRIPT`.
 */
import { walkSnapshot } from "./snapshot";
import { defaultRouteTemplate, safeRoute } from "./util";

export interface PageWalkOptions {
  /** CSS selector of the walk root. Default: the document element. */
  root?: string;
  maxElements?: number;
  ignoreSelector?: string;
  /** Route template to record. Default: the default template of the current URL with `routeSegments`. */
  routeTemplate?: string | null;
  routeSegments?: string[];
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
  });
  if (!result) throw new Error("snapshot walk was abandoned");
  return result.body;
}

(globalThis as unknown as { __codepressInteractions?: unknown }).__codepressInteractions = { walk };

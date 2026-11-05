/**
 * Playwright helpers for the CodePress Interactions UI checks: capture a
 * snapshot of the current page, list what the checks find, or fail a test
 * when they find anything.
 */
import { createHash } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import {
  checkEvents,
  checkSnapshot,
  formatFinding,
  sortFindings,
  type DetectOptions,
  type Finding,
  type SnapshotBody,
  type TimelineEvent,
} from "@codepress/interactions-browser/detect";
import { PAGE_SCRIPT } from "@codepress/interactions-browser/page-script";

export type { CheckName, DetectOptions, Evidence, Finding, SnapshotBody, TimelineEvent } from "@codepress/interactions-browser/detect";
export { formatFinding, sortFindings } from "@codepress/interactions-browser/detect";

export interface CaptureOptions {
  /** CSS selector of the subtree to walk. Default: the whole document. */
  root?: string;
  /** Extra selector for subtrees recorded as one ignored box. `[data-layout-ignore]` always applies. */
  ignore?: string;
  /** Route template to record, e.g. `/projects/:id`. Default: the SDK's default template of the URL, every segment `:id` unless listed in `routeSegments`. */
  route?: string | null;
  /** Literal path segments kept in the default route template. */
  routeSegments?: string[];
  /** Element limit. Default 50000. */
  maxElements?: number;
  /** Theme to record when the app has its own toggle. Default: the page's prefers-color-scheme (`colorScheme` in the Playwright config, or `page.emulateMedia`). */
  theme?: "light" | "dark" | "unknown";
}

export interface Snapshot {
  body: SnapshotBody;
  /** SHA-256 of the serialized body, as the browser SDK computes it. */
  sha256: string;
}

export interface FindIssuesOptions extends CaptureOptions, DetectOptions {
  /** Fingerprints to leave out: known findings accepted for now. */
  ignoreFingerprints?: readonly string[];
  /** Protocol v2 events (for example from a sink) to run the click and stability checks over too. */
  events?: readonly TimelineEvent[];
}

interface Walker {
  walk(options: unknown): Promise<SnapshotBody>;
}

/** Walks the page with the SDK's snapshot walker in one pass (never torn). */
export async function captureSnapshot(page: Page, options: CaptureOptions = {}): Promise<Snapshot> {
  const args = {
    script: PAGE_SCRIPT,
    options: {
      root: options.root,
      ignoreSelector: options.ignore,
      routeTemplate: options.route,
      routeSegments: options.routeSegments,
      maxElements: options.maxElements,
      theme: options.theme,
    },
  };
  const body = await page.evaluate(async ({ script, options }) => {
    const scope = globalThis as unknown as { __codepressInteractions?: Walker };
    // Indirect eval runs the bundled walker in the page's global scope.
    if (!scope.__codepressInteractions) (0, eval)(script);
    return scope.__codepressInteractions!.walk(options);
  }, args);
  const sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { body, sha256 };
}

/** Runs the checks on the page as it is now, sorted with blocked controls first. */
export async function findIssues(page: Page, options: FindIssuesOptions = {}): Promise<Finding[]> {
  const { body, sha256 } = await captureSnapshot(page, options);
  const findings = checkSnapshot(body, { ...options, sha256 });
  if (options.events?.length)
    findings.push(...checkEvents(options.events, { ...options, snapshots: [{ body, sha256 }] }));
  const skip = new Set(options.ignoreFingerprints ?? []);
  return sortFindings(findings.filter((finding) => !skip.has(finding.fingerprint)));
}

/**
 * Fails the test when the checks find anything, listing one line per finding
 * (check, elements, evidence, fingerprint) so the failure reads on its own.
 */
export async function expectNoFindings(page: Page, options: FindIssuesOptions = {}): Promise<void> {
  const findings = await findIssues(page, options);
  const lines = findings.map(formatFinding);
  const where = (() => {
    try {
      return new URL(page.url()).pathname;
    } catch {
      return page.url();
    }
  })();
  expect(
    lines,
    `${findings.length} UI finding${findings.length === 1 ? "" : "s"} on ${where}` +
      (findings.length ? ". Pass a fingerprint in ignoreFingerprints to accept one." : ""),
  ).toEqual([]);
}

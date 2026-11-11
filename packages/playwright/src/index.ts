/**
 * Playwright helpers for the CodePress Interactions UI checks: capture a
 * snapshot of the current page, list what the checks find, or fail a test
 * when they find anything.
 */
import { createHash } from "node:crypto";
import { expect, type ElementHandle, type JSHandle, type Page } from "@playwright/test";
import {
  checkEvents,
  checkSnapshot,
  formatFinding,
  hoverOnlyFindings,
  sortFindings,
  type DetectOptions,
  type Finding,
  type SnapshotBody,
  type TimelineEvent,
} from "@codepress/interactions-browser/detect";
import { PAGE_SCRIPT } from "@codepress/interactions-browser/page-script";

export type { CheckName, DetectOptions, Evidence, Finding, SnapshotBody, TimelineEvent } from "@codepress/interactions-browser/detect";
export { formatFinding, hoverOnlyFindings, sortFindings } from "@codepress/interactions-browser/detect";

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
  /**
   * Test ID filter, as the browser SDK's `testId` option: return the value to
   * keep it, `null` to drop it. Replaces the default (`defaultTestIdFilter`).
   * It runs in the page, so like a `page.evaluate` callback it must be
   * self-contained: no variables from the test file, no imports. Using one
   * fails the capture. To extend the default, call
   * `globalThis.__codepressInteractions.defaultTestIdFilter(value)`.
   */
  testId?: (value: string, element: Element) => string | null;
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
  hook(source: string): (value: string, element: Element) => string | null;
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
    testId: typeof options.testId === "function" ? String(options.testId) : null,
  };
  const body = await page.evaluate(async ({ script, options, testId }) => {
    const scope = globalThis as unknown as { __codepressInteractions?: Walker };
    // Indirect eval runs the bundled walker in the page's global scope.
    if (!scope.__codepressInteractions) (0, eval)(script);
    if (testId === null) return scope.__codepressInteractions!.walk(options);
    const hook = scope.__codepressInteractions!.hook(testId);
    // The SDK drops an ID when a hook throws. Here a name missing from the page
    // is a broken test setup, and dropping every ID would hide it.
    let missing: string | null = null;
    const body = await scope.__codepressInteractions!.walk({
      ...options,
      testId: (value: string, element: Element) => {
        try {
          return hook(value, element);
        } catch (error) {
          if (error instanceof ReferenceError) missing ??= error.message;
          throw error;
        }
      },
    });
    if (missing !== null)
      throw new Error(`testId runs in the page and must be self-contained: ${missing}`);
    return body;
  }, args);
  const sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { body, sha256 };
}

/** The checks on the page as it is now, unsorted and unfiltered, with the snapshot they ran on. */
async function inspect(page: Page, options: FindIssuesOptions): Promise<{ findings: Finding[]; snapshot: Snapshot }> {
  const snapshot = await captureSnapshot(page, options);
  const { body, sha256 } = snapshot;
  const findings = checkSnapshot(body, { ...options, sha256 });
  if (options.events?.length)
    findings.push(...checkEvents(options.events, { ...options, snapshots: [{ body, sha256 }] }));
  return { findings, snapshot };
}

/** Runs the checks on the page as it is now, sorted with blocked controls first. */
export async function findIssues(page: Page, options: FindIssuesOptions = {}): Promise<Finding[]> {
  const { findings } = await inspect(page, options);
  const skip = new Set(options.ignoreFingerprints ?? []);
  return sortFindings(findings.filter((finding) => !skip.has(finding.fingerprint)));
}

/**
 * Fails the test when the checks find anything, listing one line per finding
 * (check, elements, evidence, fingerprint) so the failure reads on its own.
 */
export async function expectNoFindings(page: Page, options: FindIssuesOptions = {}): Promise<void> {
  expectNone(page, await findIssues(page, options), "UI finding");
}

function expectNone(page: Page, findings: readonly Finding[], noun: string, suffix = ""): void {
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
    `${findings.length} ${noun}${findings.length === 1 ? "" : "s"} on ${where}${suffix}` +
      (findings.length ? ". Pass a fingerprint in ignoreFingerprints to accept one." : ""),
  ).toEqual([]);
}

// ---- Hover and focus sweep ------------------------------------------------

export interface SweepOptions extends FindIssuesOptions {
  /** Most controls visited, in document order; the rest are counted in `skipped`. Default 200. */
  maxControls?: number;
  /** Rest the mouse on each control. Default true. */
  hover?: boolean;
  /** Give each control keyboard focus. Default true. */
  focus?: boolean;
  /** Quiet time after the last change before a hover or focus counts as settled, in ms. Default 200. */
  settleMs?: number;
}

export interface SweepResult {
  /** Every finding seen at rest, while hovering and while focusing, once per fingerprint, sorted. */
  findings: Finding[];
  /** Controls visited. */
  controls: number;
  /** Controls not visited: past `maxControls`, or gone from the page (or no longer hoverable) when their turn came. */
  skipped: number;
}

interface SweepStep {
  reached: boolean;
  overlay: boolean;
  settled: boolean;
}

/** The in-page sweep (`Sweep` in the browser package's sweep.ts). */
interface PageSweep {
  controls(max: number): { elements: Element[]; total: number };
  controlId(element: Element): string;
  arm(): void;
  hovered(control: Element): Promise<SweepStep>;
  focus(control: Element): Promise<SweepStep>;
  blur(control: Element): void;
  quiet(): Promise<void>;
  away(): { x: number; y: number };
  stop(): void;
}

interface SweepScope {
  __codepressInteractions?: Walker & { sweep(setup: unknown): PageSweep };
}

/**
 * Hovers and then keyboard-focuses every visible control on the page (in
 * document order, up to `maxControls`), running the checks on the page at rest
 * and after each hover and focus settles. A control whose hover opened an
 * overlay that its keyboard focus did not adds an `a11y.hover_only_content`
 * finding. Escape is pressed between controls to close what they opened.
 */
export async function sweepInteractions(page: Page, options: SweepOptions = {}): Promise<SweepResult> {
  const hover = options.hover !== false;
  const focus = options.focus !== false;
  const max = Number.isFinite(options.maxControls) ? Math.max(0, Math.floor(options.maxControls!)) : 200;
  const settleMs = Number.isFinite(options.settleMs) ? Math.min(Math.max(1, Math.floor(options.settleMs!)), 60000) : 200;
  const found = new Map<string, Finding>();
  const add = (findings: readonly Finding[]) => {
    for (const finding of findings) if (!found.has(finding.fingerprint)) found.set(finding.fingerprint, finding);
  };

  // The page at rest; this also injects the page script.
  add((await inspect(page, options)).findings);
  const sweep = (await page.evaluateHandle(
    ({ setup, testId }) => {
      const api = (globalThis as unknown as SweepScope).__codepressInteractions!;
      return api.sweep({ ...setup, testId: testId === null ? undefined : api.hook(testId) });
    },
    {
      setup: { root: options.root, ignore: options.ignore, settleMs },
      testId: typeof options.testId === "function" ? String(options.testId) : null,
    },
  )) as JSHandle<PageSweep>;

  let visited = 0;
  let total = 0;
  try {
    const list = await sweep.evaluateHandle((s, limit) => s.controls(limit), hover || focus ? max : 0);
    total = await list.evaluate((l) => l.total);
    const elements = await (await list.evaluateHandle((l) => l.elements)).getProperties();
    await list.dispose();
    const rest = async () => {
      const { x, y } = await sweep.evaluate((s) => s.away());
      await page.mouse.move(x, y);
    };
    for (const property of elements.values()) {
      const control = property.asElement() as ElementHandle<Element> | null;
      if (!control) continue;
      try {
        if (!(await control.evaluate((element) => element.isConnected))) continue;
        let hovered: SweepStep | null = null;
        let hoverSnapshot: Snapshot | null = null;
        if (hover) {
          await rest();
          await control.scrollIntoViewIfNeeded({ timeout: 2000 });
          await sweep.evaluate(async (s) => {
            await s.quiet();
            s.arm();
          });
          await control.hover({ force: true, timeout: 2000 });
          hovered = await sweep.evaluate((s, element) => s.hovered(element), control);
          const result = await inspect(page, options);
          add(result.findings);
          hoverSnapshot = result.snapshot;
        }
        let focused: SweepStep | null = null;
        if (focus) {
          await rest();
          await page.keyboard.press("Escape");
          await sweep.evaluate(async (s) => {
            await s.quiet();
            s.arm();
          });
          focused = await sweep.evaluate((s, element) => s.focus(element), control);
          add((await inspect(page, options)).findings);
          await page.keyboard.press("Escape");
          await sweep.evaluate((s, element) => s.blur(element), control);
        }
        if (hovered?.reached && hovered.overlay && focused && !focused.overlay && hoverSnapshot) {
          const { body, sha256 } = hoverSnapshot;
          add(
            hoverOnlyFindings(
              {
                control_id: await sweep.evaluate((s, element) => s.controlId(element), control),
                route_template: body.route_template,
                viewport_width: body.viewport.width,
                viewport_height: body.viewport.height,
                snapshot_sha256: sha256,
                hover_overlay: true,
                focus_overlay: false,
                focus_reached: focused.reached,
              },
              options,
            ),
          );
        }
        visited++;
      } catch (error) {
        // The page navigated or closed: nothing more can be swept.
        if (page.isClosed() || /Execution context was destroyed|Target .*closed/i.test(String(error))) break;
        // Otherwise the control went away or could not be hovered: it counts as skipped.
      } finally {
        await control.dispose().catch(() => {});
      }
    }
    if (hover) await rest().catch(() => {});
  } finally {
    await sweep.evaluate((s) => s.stop()).catch(() => {});
    await sweep.dispose().catch(() => {});
  }
  const skip = new Set(options.ignoreFingerprints ?? []);
  return {
    findings: sortFindings([...found.values()].filter((finding) => !skip.has(finding.fingerprint))),
    controls: visited,
    skipped: Math.max(0, total - visited),
  };
}

/**
 * Fails the test when `sweepInteractions` finds anything, one line per
 * finding as `expectNoFindings` writes them.
 */
export async function expectNoSweepFindings(page: Page, options: SweepOptions = {}): Promise<void> {
  const { findings, controls } = await sweepInteractions(page, options);
  expectNone(page, findings, "UI finding", ` after hovering and focusing ${controls} control${controls === 1 ? "" : "s"}`);
}

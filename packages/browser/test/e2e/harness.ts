import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, type Route } from "@playwright/test";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// CommonJS interop: these packages put the constructor on `default`.
const Ajv2020 = ((Ajv2020Module as any).default ?? Ajv2020Module) as typeof Ajv2020Module;
const addFormats = ((addFormatsModule as any).default ?? addFormatsModule) as typeof addFormatsModule;

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");

/** The SDK source bundled as a classic script exposing `CodepressInteractions`. */
export const sdkBundle = buildSync({
  entryPoints: [resolve(here, "../../src/index.ts")],
  bundle: true,
  format: "iife",
  globalName: "CodepressInteractions",
  target: "es2022",
  write: false,
}).outputFiles[0].text;

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
export const validateBatch = ajv.compile(
  JSON.parse(readFileSync(resolve(repo, "protocol/v2-batch.schema.json"), "utf8")),
);
export const validateSnapshot = ajv.compile(
  JSON.parse(readFileSync(resolve(repo, "protocol/v2-snapshot.schema.json"), "utf8")),
);

export const APP = "https://app.test";
export const TELEMETRY = "https://telemetry.test";

export interface PageOptions {
  /** Extra routes, matched before the app page. */
  api?: (route: Route) => Promise<void> | void;
  /** Runs before any page script. */
  initScript?: string;
}

/**
 * Serves `body` as https://app.test{path} with the SDK loaded and a memory sink
 * at `window.sink`. Collects page errors so tests can assert none happened.
 */
export async function openPage(
  page: Page,
  body: string,
  { api, initScript }: PageOptions = {},
  path = "/",
): Promise<{ errors: string[] }> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    (window as unknown as { __rejections: number }).__rejections = 0;
    window.addEventListener("unhandledrejection", () => {
      (window as unknown as { __rejections: number }).__rejections++;
    });
  });
  if (initScript) await page.addInitScript(initScript);
  await page.route(`${APP}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/sdk.js")
      return route.fulfill({ contentType: "text/javascript", body: sdkBundle });
    if (url.pathname.startsWith("/api/") && api) return api(route);
    if (url.pathname.startsWith("/api/"))
      return route.fulfill({ contentType: "application/json", body: '{"ok":true}' });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px/1.25 sans-serif}</style><script src="/sdk.js"></script><script>window.sink = CodepressInteractions.createMemorySink();</script></head><body>${body}</body></html>`,
    });
  });
  await page.goto(APP + path);
  return { errors };
}

/** Starts the SDK with the memory sink and JSON-safe options. */
export async function init(page: Page, options: Record<string, unknown> = {}): Promise<void> {
  await page.evaluate((options) => {
    const w = window as any;
    w.handle = w.CodepressInteractions.initInteractions({
      sink: w.sink,
      flushIntervalMs: 3_600_000,
      routeSettleMs: 3_600_000,
      allowedApiOrigins: [location.origin],
      ...options,
    });
  }, options);
}

export interface Output {
  batches: any[];
  serialized: string[];
  snapshots: { sha256: string; serialized: string; body: any }[];
}

/** Flushes and returns everything the memory sink received. */
export async function output(page: Page): Promise<Output> {
  return page.evaluate(async () => {
    const w = window as any;
    await w.handle.flush();
    return {
      batches: w.sink.batches,
      serialized: w.sink.serializedBatches,
      snapshots: w.sink.snapshots,
    };
  });
}

export const events = (out: Output) => out.batches.flatMap((batch) => batch.events);

/** Every batch and snapshot body must satisfy the v2 contract. */
export function expectValid(out: Output): void {
  for (const batch of out.batches) {
    const ok = validateBatch(batch);
    expect(ok, JSON.stringify(validateBatch.errors?.slice(0, 3))).toBe(true);
  }
  for (const snapshot of out.snapshots) {
    const ok = validateSnapshot(snapshot.body);
    expect(ok, JSON.stringify(validateSnapshot.errors?.slice(0, 3))).toBe(true);
  }
}

/** Row lookup by test ID in a columnar body. */
export function rowOf(body: any, testId: string): number {
  const id = body.dictionaries.test_id.indexOf(testId);
  expect(id, `test id ${testId}`).toBeGreaterThanOrEqual(0);
  return body.elements.test_id.indexOf(id);
}

export async function rejections(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__rejections as number);
}

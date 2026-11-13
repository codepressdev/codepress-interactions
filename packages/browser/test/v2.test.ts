import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMemorySink,
  defaultRouteTemplate,
  initInteractions,
  type InteractionHandle,
  type InteractionOptions,
} from "../src/index";

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const protocol = resolve(dirname(fileURLToPath(import.meta.url)), "../../../protocol");
const validateBatch = ajv.compile(
  JSON.parse(readFileSync(resolve(protocol, "v2-batch.schema.json"), "utf8")),
);

let handles: InteractionHandle[] = [];
let calls: { url: string; init?: RequestInit }[];
let response: () => Response;
const start = (options: Partial<InteractionOptions> = {}) => {
  const sink = createMemorySink();
  const handle = initInteractions({
    sink,
    flushIntervalMs: 3_600_000,
    routeSettleMs: 3_600_000,
    allowedApiOrigins: ["http://localhost:3000"],
    ...options,
  });
  handles.push(handle);
  return { handle, sink };
};
const eventsOf = (sink: ReturnType<typeof createMemorySink>) =>
  sink.batches.flatMap((batch) => batch.events) as any[];

beforeEach(() => {
  calls = [];
  response = () => new Response("{}", { status: 200, headers: { "X-Trace-Id": "trace-abc.1" } });
  window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response();
  }) as typeof fetch;
  document.body.innerHTML = "";
});
afterEach(() => {
  handles.forEach((handle) => handle.shutdown());
  handles = [];
  vi.restoreAllMocks();
});

describe("fetch patch chaining", () => {
  it("keeps patches installed before and after init running after shutdown", async () => {
    const order: string[] = [];
    const base = window.fetch;
    const before: typeof fetch = (input, init) => {
      order.push("before");
      return base(input, init);
    };
    window.fetch = before;
    const { handle } = start();
    const ours = window.fetch;
    const after: typeof fetch = (input, init) => {
      order.push("after");
      return ours(input, init);
    };
    window.fetch = after;
    handle.shutdown();
    // The later library's patch is never removed; it still reaches the earlier one.
    expect(window.fetch).toBe(after);
    const result = await window.fetch("/api/x");
    expect(await result.json()).toEqual({});
    expect(order).toEqual(["after", "before"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].init).toBeUndefined();
  });
});

describe("options", () => {
  it("default route template collapses every segment unless allowlisted, and never includes the query", () => {
    const route = (path: string, words?: string[]) => defaultRouteTemplate(new URL(path, "https://app.test"), words);
    expect(route("/u/jane-smith")).toBe("/:id/:id");
    expect(route("/acme-corp/projects?q=secret#x")).toBe("/:id/:id");
    expect(route("/")).toBe("/");
    const words = ["orders", "items", "u", "settings", "projects", "Bad Word", 7 as any];
    expect(route("/orders/123/items?q=secret", words)).toBe("/orders/:id/items");
    expect(route("/u/8f14e45f-ceea-467f-a0e6-0e2a1b0c2b11/settings", words)).toBe("/u/:id/settings");
    expect(route("/u/jane-smith", words)).toBe("/u/:id");
    expect(route("/acme-corp/projects", words)).toBe("/:id/projects");
    expect(route("/orders/orders", words)).toBe("/orders/orders");
  });

  it("uses routeTemplate and requestLabel callbacks, keeping only bounded labels", async () => {
    const { handle, sink } = start({
      routeTemplate: (url) => (url.pathname.startsWith("/") ? "/custom/[id]" : null),
      requestLabel: (url, init) => (url.pathname === "/api/a" ? `api.${init?.method ?? "GET"}` : "has spaces"),
    });
    await window.fetch("http://localhost:3000/api/a", { method: "POST" });
    await window.fetch("http://localhost:3000/api/b");
    history.pushState({}, "", "/route-change");
    await handle.flush();
    const requests = eventsOf(sink).filter((e) => e.type === "request.completed");
    expect(requests.map((e) => e.data.request_label)).toEqual(["api.POST", undefined]);
    expect(requests[0].data.trace_id).toBe("trace-abc.1");
    for (const batch of sink.batches) expect(validateBatch(batch), JSON.stringify(validateBatch.errors)).toBe(true);
  });

  it("rejects route templates containing queries or free text", async () => {
    const { handle } = start({ routeTemplate: () => "/orders?id=1" });
    const summary = await handle.snapshot();
    if (summary) expect(summary.route_template).toBeNull();
  });

  it("propagates a custom header, or none when disabled", async () => {
    const first = start({ propagateHeader: "X-Request-Context" });
    await first.handle.runAction("save", () => window.fetch("http://localhost:3000/api/one"));
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("X-Request-Context")).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers.has("X-Interaction-Id")).toBe(false);
    first.handle.shutdown();
    const second = start({ propagateHeader: false });
    await second.handle.runAction("save", () => window.fetch("http://localhost:3000/api/two"));
    const plain = new Headers(calls[1].init?.headers);
    expect(plain.has("X-Interaction-Id")).toBe(false);
    expect(plain.has("X-Request-Context")).toBe(false);
    await second.handle.flush();
    // Still observed, just not propagated.
    expect(eventsOf(second.sink).some((e) => e.type === "request.started")).toBe(true);
  });

  it("sends a bounded release label with every batch and drops unsafe ones", async () => {
    const good = start({ release: "app@2.4.0+sha.1a2b" });
    good.handle.runAction("x", () => {});
    await good.handle.flush();
    expect(good.sink.batches[0]).toMatchObject({ schema_version: 2, sdk_version: "1.4.0", release: "app@2.4.0+sha.1a2b" });
    good.handle.shutdown();
    const bad = start({ release: "has spaces and <html>" });
    bad.handle.runAction("x", () => {});
    await bad.handle.flush();
    expect(bad.sink.batches[0].release).toBeNull();
  });

  it("requires a complete sink, or an endpoint with a project key", () => {
    expect(initInteractions({ sink: { sendBatch() {} } as any }).getDiagnostics().enabled).toBe(false);
    expect(initInteractions({ endpoint: "https://telemetry.test" }).getDiagnostics().enabled).toBe(false);
    const { handle } = start();
    expect(handle.getDiagnostics().enabled).toBe(true);
    // A different sink while one is active is a different configuration.
    expect(initInteractions({ sink: createMemorySink() }).getDiagnostics().enabled).toBe(false);
  });

  it("reports performance signals the environment lacks as unavailable", () => {
    const { handle } = start();
    const signals = handle.getDiagnostics().signals;
    // jsdom has no PerformanceObserver entry types.
    expect(signals.layout_shift).toBe(false);
    expect(signals.long_task).toBe(false);
    expect(signals.uncaught_error).toBe(true);
  });
});

let compiledSnapshot: ReturnType<typeof ajv.compile> | undefined;
const snapshotValidator = () =>
  (compiledSnapshot ??= ajv.compile(
    JSON.parse(readFileSync(resolve(protocol, "v2-snapshot.schema.json"), "utf8")),
  ));

describe("contract", () => {
  it("bodies and batches written by 0.2.0 still validate", () => {
    const validateSnapshot = snapshotValidator();
    const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
    // Saved verbatim from the 0.2.0 release's golden fixtures.
    const body = JSON.parse(readFileSync(resolve(fixtures, "v2-snapshot-0.2.0.json"), "utf8"));
    const batch = JSON.parse(readFileSync(resolve(fixtures, "v2-batch-0.2.0.json"), "utf8"));
    expect(body.legend.flags.aria_hidden).toBeUndefined();
    expect(validateSnapshot(body), JSON.stringify(validateSnapshot.errors)).toBe(true);
    expect(validateBatch(batch), JSON.stringify(validateBatch.errors)).toBe(true);
    // The original ten flags are still required, and values are still fixed.
    const { visible: _visible, ...missing } = body.legend.flags;
    expect(validateSnapshot({ ...body, legend: { ...body.legend, flags: missing } })).toBe(false);
    expect(validateSnapshot({ ...body, legend: { ...body.legend, flags: { ...body.legend.flags, aria_hidden: 1 } } })).toBe(false);
  });

  it("golden fixtures validate, and the snapshot fixture hashes to its event's sha256", async () => {
    const validateSnapshot = snapshotValidator();
    const batch = JSON.parse(readFileSync(resolve(protocol, "v2-batch.json"), "utf8"));
    const body = JSON.parse(readFileSync(resolve(protocol, "v2-snapshot.json"), "utf8"));
    expect(validateBatch(batch), JSON.stringify(validateBatch.errors)).toBe(true);
    expect(validateSnapshot(body), JSON.stringify(validateSnapshot.errors)).toBe(true);
    const types = batch.events.map((e: any) => e.type);
    for (const type of ["ui.snapshot", "ui.click.settled", "ui.hover.settled", "ui.finding", "perf.summary", "interaction.started"])
      expect(types).toContain(type);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body)));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(batch.events.find((e: any) => e.type === "ui.snapshot").data.sha256).toBe(hex);
    // Contract is strict: unknown fields and free text are refused.
    const extra = structuredClone(batch);
    extra.events[0].data.note = "free text";
    expect(validateBatch(extra)).toBe(false);
    const finding = structuredClone(batch);
    finding.events.find((e: any) => e.type === "ui.finding").data.evidence.verdict = "looks broken";
    expect(validateBatch(finding)).toBe(false);
  });

  it("ui.hover.settled, the hover and focus snapshot triggers and the silent counters validate; 1.1.0 summaries still do", () => {
    const batch = JSON.parse(readFileSync(resolve(protocol, "v2-batch.json"), "utf8"));
    const hover = batch.events.find((e: any) => e.type === "ui.hover.settled");
    const snapshot = batch.events.find((e: any) => e.type === "ui.snapshot");
    const perf = batch.events.find((e: any) => e.type === "perf.summary");
    const one = (event: any) => ({ ...batch, events: [event] });
    const focus = { ...hover, data: { ...hover.data, kind: "focus", dwell_ms: 0, snapshot_sha256: null, has_hover_handler: true } };
    expect(validateBatch(one(focus)), JSON.stringify(validateBatch.errors)).toBe(true);
    for (const trigger of ["hover", "focus"])
      expect(validateBatch(one({ ...snapshot, data: { ...snapshot.data, trigger } }))).toBe(true);
    expect(validateBatch(one({ ...perf, data: { ...perf.data, hovers_silent: 3, focus_silent: 1 } }))).toBe(true);
    const { hovers_silent: _h, focus_silent: _f, ...older } = perf.data;
    expect(validateBatch(one({ ...perf, data: older }))).toBe(true);
    // Strict: touch is not a kind, every effect is required, attribution is unknown.
    expect(validateBatch(one({ ...hover, data: { ...hover.data, kind: "touch" } }))).toBe(false);
    const { overlay_opened: _o, ...missing } = hover.data;
    expect(validateBatch(one({ ...hover, data: missing }))).toBe(false);
    expect(validateBatch(one({ ...hover, attribution: "explicit" }))).toBe(false);
    expect(validateBatch(one({ ...hover, data: { ...hover.data, tooltip_text: "x" } }))).toBe(false);
  });
});

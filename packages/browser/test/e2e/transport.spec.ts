import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import {
  TELEMETRY,
  events,
  expectValid,
  init,
  openPage,
  output,
  rejections,
  validateBatch,
  validateSnapshot,
} from "./harness";

async function initEndpoint(page: Page, options: Record<string, unknown> = {}) {
  await page.evaluate((options) => {
    const w = window as any;
    w.handle = w.CodepressInteractions.initInteractions({
      projectKey: "public-key",
      endpoint: "https://telemetry.test",
      flushIntervalMs: 3_600_000,
      routeSettleMs: 3_600_000,
      ...options,
    });
  }, options);
}

test("same screen twice in a session uploads one gzip body by HEAD then PUT", async ({ page }) => {
  const calls: { method: string; path: string; headers: Record<string, string>; body: Buffer | null }[] = [];
  const stored = new Set<string>();
  await page.route(`${TELEMETRY}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    calls.push({ method: request.method(), path, headers: await request.allHeaders(), body: request.postDataBuffer() });
    if (request.method() === "HEAD") return route.fulfill({ status: stored.has(path) ? 200 : 404 });
    if (request.method() === "PUT") stored.add(path);
    return route.fulfill({ status: request.method() === "PUT" ? 201 : 202 });
  });
  await openPage(page, '<main data-testid="screen"><h1>Same</h1></main>');
  await initEndpoint(page);
  const [first, second] = await page.evaluate(async () => {
    const w = window as any;
    const a = await w.handle.snapshot();
    const b = await w.handle.snapshot();
    await w.handle.flush();
    await w.handle.flush();
    return [a, b];
  });
  expect(second.sha256).toBe(first.sha256);
  expect(second.deduplicated).toBe(true);
  const heads = calls.filter((c) => c.method === "HEAD");
  const puts = calls.filter((c) => c.method === "PUT");
  expect(heads).toHaveLength(1);
  expect(puts).toHaveLength(1);
  expect(puts[0].path).toBe(`/v2/snapshots/${first.sha256}`);
  expect(puts[0].headers["content-encoding"]).toBe("gzip");
  expect(puts[0].headers.authorization).toBe("Bearer public-key");
  const raw = gunzipSync(puts[0].body!);
  expect(createHash("sha256").update(raw).digest("hex")).toBe(first.sha256);
  expect(validateSnapshot(JSON.parse(raw.toString("utf8")))).toBe(true);
  const batches = calls.filter((c) => c.method === "POST").map((c) => JSON.parse(c.body!.toString("utf8")));
  expect(calls.filter((c) => c.method === "POST").every((c) => c.path === "/v2/batches")).toBe(true);
  for (const batch of batches) expect(validateBatch(batch), JSON.stringify(validateBatch.errors)).toBe(true);
  expect(batches.flatMap((b) => b.events).filter((e: any) => e.type === "ui.snapshot")).toHaveLength(1);
  const diagnostics = await page.evaluate(() => (window as any).handle.getDiagnostics());
  expect(diagnostics.snapshots).toMatchObject({ taken: 2, uploaded: 1, deduplicated: 1 });
});

test("service answering 403 to a snapshot stops capture and clears pending evidence", async ({ page }) => {
  await page.route(`${TELEMETRY}/**`, (route) => route.fulfill({ status: 403 }));
  await openPage(page, '<button id="b">x</button>');
  await initEndpoint(page);
  const result = await page.evaluate(async () => {
    const w = window as any;
    const patched = window.fetch;
    document.getElementById("b")!.click();
    await w.handle.snapshot();
    await new Promise((r) => setTimeout(r, 50));
    return { diagnostics: w.handle.getDiagnostics(), restored: window.fetch !== patched };
  });
  expect(result.diagnostics).toMatchObject({ enabled: false, queuedEvents: 0, lastError: "admission_denied" });
  expect(result.restored).toBe(true);
});

const HOST_PAGE = `
<button id="pay">Pay</button><output id="count">0</output>
<script>
  let clicks = 0;
  document.getElementById("pay").addEventListener("click", () => {
    document.getElementById("count").textContent = String(++clicks);
  });
</script>`;

async function exerciseHost(page: Page) {
  return page.evaluate(async () => {
    const w = window as any;
    const button = document.getElementById("pay")!;
    button.click();
    button.click();
    const response = await fetch("/api/data");
    const json = await response.json();
    let failure = "";
    try {
      await fetch("https://unreachable.invalid/");
    } catch (error) {
      failure = (error as Error).name;
    }
    await w.handle.snapshot();
    await Promise.race([w.handle.flush(), new Promise((r) => setTimeout(r, 1000))]);
    await new Promise((r) => setTimeout(r, 400));
    return { count: document.getElementById("count")!.textContent, status: response.status, json, failure };
  });
}

for (const [name, sink] of [
  ["throws synchronously", "{ sendBatch() { throw new Error('boom'); }, sendSnapshot() { throw new Error('boom'); } }"],
  ["rejects later", "{ sendBatch: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 50)), sendSnapshot: () => Promise.reject(new Error('now')) }"],
  ["hangs forever", "{ sendBatch: () => new Promise(() => {}), sendSnapshot: () => new Promise(() => {}) }"],
] as const) {
  test(`a sink that ${name} leaves click handlers and fetch results unchanged`, async ({ page }) => {
    const { errors } = await openPage(page, HOST_PAGE);
    await page.evaluate((source) => {
      const w = window as any;
      w.handle = w.CodepressInteractions.initInteractions({
        sink: new Function(`return ${source}`)(),
        flushIntervalMs: 3_600_000,
        routeSettleMs: 3_600_000,
        requestTimeoutMs: 200,
        retryBaseMs: 1,
      });
    }, sink);
    const result = await exerciseHost(page);
    expect(result).toEqual({ count: "2", status: 200, json: { ok: true }, failure: "TypeError" });
    expect(await rejections(page)).toBe(0);
    expect(errors).toEqual([]);
    const diagnostics = await page.evaluate(() => (window as any).handle.getDiagnostics());
    expect(diagnostics.enabled).toBe(true);
    expect(diagnostics.acceptedBatches).toBe(0);
  });
}

for (const [name, behavior] of [
  ["hangs", "hang"],
  ["fails with 500", "500"],
  ["drops the connection", "abort"],
] as const) {
  test(`an endpoint that ${name} leaves click handlers and fetch results unchanged`, async ({ page }) => {
    await page.route(`${TELEMETRY}/**`, async (route) => {
      if (behavior === "hang") return; // never answered
      if (behavior === "abort") return route.abort("connectionreset");
      return route.fulfill({ status: 500 });
    });
    const { errors } = await openPage(page, HOST_PAGE);
    await initEndpoint(page, { requestTimeoutMs: 200, retryBaseMs: 1 });
    const result = await exerciseHost(page);
    expect(result).toEqual({ count: "2", status: 200, json: { ok: true }, failure: "TypeError" });
    expect(await rejections(page)).toBe(0);
    expect(errors).toEqual([]);
  });
}

test("hidden tab takes no snapshot until visible again", async ({ page }) => {
  await openPage(page, '<div style="height:40px"></div>', {
    initScript: `
      window.__visibility = "hidden";
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.__visibility });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__visibility === "hidden" });`,
  });
  await init(page, { routeSettleMs: 20, resizeSettleMs: 20, visibleSettleMs: 20 });
  await page.evaluate(() => history.pushState({}, "", "/elsewhere"));
  await page.setViewportSize({ width: 900, height: 700 });
  const manual = await page.evaluate(() => (window as any).handle.snapshot());
  expect(manual).toBeNull();
  await page.waitForTimeout(200);
  expect((await output(page)).snapshots).toHaveLength(0);
  await page.evaluate(() => {
    (window as any).__visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(async () => (await output(page)).snapshots.length).toBe(1);
  const out = await output(page);
  expectValid(out);
  expect(events(out).filter((e) => e.type === "ui.snapshot").map((e) => e.data.trigger)).toEqual(["visible"]);
});

test("performance signals count errors and image failures without messages or URLs", async ({ page }) => {
  await openPage(page, '<div id="x"></div>', {
    api: (route) => route.fulfill({ status: 404, body: "" }),
  });
  await init(page);
  await page.evaluate(async () => {
    const img = document.createElement("img");
    img.src = "/api/missing.png?private=SENTINEL_IMG";
    document.body.append(img);
    setTimeout(() => {
      throw new Error("SENTINEL_ERROR message");
    }, 0);
    Promise.reject(new Error("SENTINEL_REJECTION"));
    await new Promise((r) => setTimeout(r, 300));
  });
  const out = await output(page);
  expectValid(out);
  const perf = events(out).filter((e) => e.type === "perf.summary");
  expect(perf).toHaveLength(1);
  expect(perf[0].data).toMatchObject({ image_error_count: 1, uncaught_error_count: 2, unavailable: [] });
  expect(JSON.stringify(out)).not.toContain("SENTINEL");
});

test("a full snapshot queue never drops the body being uploaded, and dropped bodies can upload later", async ({ page }) => {
  await openPage(page, '<main id="m"></main>');
  const result = await page.evaluate(async () => {
    const w = window as any;
    const uploads: string[] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => (release = resolve));
    w.handle = w.CodepressInteractions.initInteractions({
      sink: {
        sendBatch() {},
        async sendSnapshot(snapshot: { sha256: string }) {
          if (!uploads.length) {
            uploads.push(snapshot.sha256);
            await first;
            return "accepted";
          }
          uploads.push(snapshot.sha256);
          return "accepted";
        },
      },
      flushIntervalMs: 3_600_000,
      routeSettleMs: 3_600_000,
      requestTimeoutMs: 60_000,
    });
    const screen = async (n: number) => {
      document.getElementById("m")!.innerHTML = "<p></p>".repeat(n);
      return (await w.handle.snapshot()).sha256 as string;
    };
    const taken: string[] = [];
    for (let n = 1; n <= 6; n++) taken.push(await screen(n));
    release();
    await w.handle.flush();
    await new Promise((r) => setTimeout(r, 50));
    const again = await screen(2);
    await w.handle.flush();
    await new Promise((r) => setTimeout(r, 50));
    return { taken, uploads, again, diagnostics: w.handle.getDiagnostics().snapshots };
  });
  const [a, b, c, d, e, f] = result.taken;
  // A was in flight; B and C were dropped for E and F; B re-uploads when seen again.
  expect(result.uploads).toEqual([a, d, e, f, b]);
  expect(result.again).toBe(b);
  expect(result.diagnostics).toMatchObject({ uploaded: 5, skipped: 2 });
  expect(new Set(result.uploads).has(c)).toBe(false);
});

test("a body that runs out of retries is not treated as sent", async ({ page }) => {
  await openPage(page, "<main></main>");
  const result = await page.evaluate(async () => {
    const w = window as any;
    let calls = 0;
    w.handle = w.CodepressInteractions.initInteractions({
      sink: { sendBatch() {}, sendSnapshot: () => (++calls === 1 ? "retry" : "accepted") },
      flushIntervalMs: 3_600_000,
      routeSettleMs: 3_600_000,
      maxRetries: 0,
    });
    await w.handle.snapshot();
    await w.handle.flush();
    await new Promise((r) => setTimeout(r, 50));
    const second = await w.handle.snapshot();
    await w.handle.flush();
    await new Promise((r) => setTimeout(r, 50));
    return { calls, deduplicated: second.deduplicated, stats: w.handle.getDiagnostics().snapshots };
  });
  expect(result).toMatchObject({ calls: 2, deduplicated: false, stats: { uploaded: 1, skipped: 1 } });
});

test("XMLHttpRequest.open keeps native errors for missing arguments", async ({ page }) => {
  await openPage(page, "<main></main>");
  const run = () =>
    page.evaluate(() => {
      try {
        (new XMLHttpRequest() as any).open("GET");
        return "no error";
      } catch (error) {
        return (error as Error).name;
      }
    });
  const native = await run();
  await init(page);
  expect(native).toBe("TypeError");
  expect(await run()).toBe(native);
});

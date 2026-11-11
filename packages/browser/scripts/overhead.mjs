// Overhead benchmark for @codepress/interactions-browser: bundle size, snapshot
// walk cost, UI check cost, click listener latency, body size and idle cost, in
// headless Chromium with and without 4x CPU throttling. Numbers are machine
// specific; the machine is printed with them.
// Usage: node scripts/overhead.mjs [--runs 5] [--sizes 500,2000] [--throttles 1,4] [--snapshots-only]
//   [--options '{"detect":{"checks":["overlap"]}}'] (SDK options for the snapshot runs)
//   [--src ../other-checkout/packages/browser/src] (measure another checkout, e.g. before a change)
import { chromium } from "@playwright/test";
import { buildSync } from "esbuild";
import { execSync } from "node:child_process";
import { cpus, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const text = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const arg = (name, fallback) => Number(text(name, fallback));
const list = (name, fallback) => text(name, fallback.join(",")).split(",").map(Number);
const SRC = resolve(text("src", resolve(here, "../src")));
const src = (file) => resolve(SRC, file);
const RUNS = arg("runs", 5);
const CLICKS = arg("clicks", 200);
const SIZES = list("sizes", [500, 2000, 5000]);
const THROTTLES = list("throttles", [1, 4]);
const OPTIONS = JSON.parse(text("options", "{}"));
const SNAPSHOTS_ONLY = process.argv.includes("--snapshots-only");
const ORIGIN = "https://app.test";

const bundle = (entry, options) =>
  buildSync({ entryPoints: [src(entry)], bundle: true, target: "es2022", write: false, ...options }).outputFiles[0]
    .contents;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const r = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const kb = (bytes) => `${r(bytes / 1024, 1)} KB`;

// 1. Bundle size: esbuild minified ESM with every import inlined (what an app bundler ships).
const sizes = Object.fromEntries(
  ["index.ts", "detect/index.ts"].map((entry) => {
    const code = bundle(entry, { format: "esm", minify: true });
    return [entry, { min: code.byteLength, gzip: gzipSync(code).byteLength }];
  }),
);
const sdkIife = new TextDecoder().decode(bundle("index.ts", { format: "iife", globalName: "CodepressInteractions" }));
const detectIife = new TextDecoder().decode(bundle("detect/index.ts", { format: "iife", globalName: "CodepressDetect" }));

// A deterministic page of roughly `target` elements: grids of flex cards with
// images (data: URI or none), text, links, lists, buttons, inputs and some deep nesting.
function pageBody(target) {
  const dot = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'/%3E";
  let html = `<header style="display:flex;gap:8px;padding:8px"><nav><a href="#">Home</a> <a href="#">Docs</a> <a href="#">Pricing</a></nav><button>Sign in</button><span id="count">0</span></header><main>`;
  let count = 10; // html, body, header, nav, 3 a, button, span, main
  for (let s = 0; count < target - 25; s++) {
    html += `<section style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:12px"><h2>Section ${s}</h2>`;
    count += 2;
    for (let c = 0; c < 10 && count < target - 25; c++) {
      const i = s * 10 + c;
      const deep = i % 5 === 0 ? 4 : 0;
      html += "<div>".repeat(deep);
      html += `<article data-testid="card-${i}" style="display:flex;gap:8px;border:1px solid #ccc;padding:8px">`;
      html += i % 3 ? `<img width="48" height="48" alt="" src="${dot}">` : `<img width="48" height="48" alt="">`;
      html += `<div><h3 style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Item ${i} with a longer title</h3>`;
      html += `<p>Short description <a href="#">details</a> <strong>new</strong></p><ul><li>one</li><li>two</li></ul></div>`;
      html += `<div style="display:grid;gap:4px"><button>Add</button><input type="text" aria-label="qty"><label><input type="checkbox"> gift</label></div></article>`;
      html += "</div>".repeat(deep);
      count += 15 + deep;
    }
    html += "</section>";
  }
  return `${html}</main>`;
}

// Long main-thread tasks from a Chromium trace: every top-level RunTask on a renderer main thread.
function mainThreadTasks(trace) {
  const events = JSON.parse(trace.toString()).traceEvents;
  const mains = new Set(
    events.filter((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain").map((e) => `${e.pid}:${e.tid}`),
  );
  return events.filter((e) => e.ph === "X" && e.name === "RunTask" && mains.has(`${e.pid}:${e.tid}`)).map((e) => e.dur / 1000);
}

// Runs before any page script: counts timers scheduled and live MutationObservers (idle test only).
const COUNTERS = `(() => {
  const t = (window.__timers = { scheduled: 0, observing: 0 });
  for (const name of ["setTimeout", "setInterval", "requestIdleCallback", "requestAnimationFrame"]) {
    const original = window[name];
    window[name] = function (...args) { t.scheduled++; return original.apply(this, args); };
  }
  const live = new WeakSet(), proto = MutationObserver.prototype, observe = proto.observe, disconnect = proto.disconnect;
  proto.observe = function (...args) { if (!live.has(this)) { live.add(this); t.observing++; } return observe.apply(this, args); };
  proto.disconnect = function () { if (live.has(this)) { live.delete(this); t.observing--; } return disconnect.call(this); };
})();`;

let browser;
async function openPage(body, { throttle, sdk = true, options = {}, initScript } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  if (initScript) await page.addInitScript(initScript);
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/sdk.js") return route.fulfill({ contentType: "text/javascript", body: sdkIife });
    if (path === "/detect.js") return route.fulfill({ contentType: "text/javascript", body: detectIife });
    return route.fulfill({
      contentType: "text/html",
      // Cross-origin isolation gives performance.now() 5 µs resolution instead of 100 µs.
      headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" },
      body: `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px/1.25 sans-serif}</style>
<script src="/sdk.js"></script><script src="/detect.js"></script><script>
  // Memory sink for batches; snapshot bodies are gzipped like the HTTP sink does, then kept.
  const memory = CodepressInteractions.createMemorySink();
  window.uploads = [];
  window.sink = { sendBatch: memory.sendBatch, async sendSnapshot(s) {
    const gz = await new Response(new Blob([s.serialized]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    window.uploads.push({ serialized: s.serialized, gzip: gz.byteLength });
    return "accepted";
  } };
</script></head><body>${body}</body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/`);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  if (sdk)
    await page.evaluate((options) => {
      window.handle = CodepressInteractions.initInteractions({ sink: window.sink, allowedApiOrigins: [location.origin], ...options });
    }, options);
  return { page, close: () => context.close() };
}

// 2, 3, 5. One on-demand snapshot per fresh page, traced. The SDK's own idle-time
// checks are off here so the trace shows the walk; they are timed on the body after.
async function snapshotRun(size, throttle) {
  const options = { routeSettleMs: 3_600_000, flushIntervalMs: 3_600_000, findings: false, ...OPTIONS };
  const { page, close } = await openPage(pageBody(size), { throttle, options });
  await page.waitForTimeout(300);
  await browser.startTracing(page, { categories: ["disabled-by-default-devtools.timeline", "devtools.timeline"] });
  const run = await page.evaluate(async () => {
    const long = [];
    new PerformanceObserver((list) => long.push(...list.getEntries().map((e) => e.duration))).observe({ type: "longtask" });
    const started = performance.now();
    const summary = await window.handle.snapshot();
    const wall = performance.now() - started;
    while (!window.uploads.length) await new Promise((done) => setTimeout(done, 10));
    await new Promise((done) => setTimeout(done, 500)); // the upload's gzip finishes
    return { summary, wall, long };
  });
  const tasks = mainThreadTasks(await browser.stopTracing());
  const checks = await page.evaluate(() => {
    const body = JSON.parse(window.uploads[0].serialized);
    const times = [];
    let findings = 0;
    for (let i = 0; i < 7; i++) {
      const started = performance.now();
      findings = CodepressDetect.checkSnapshot(body).length;
      times.push(performance.now() - started);
    }
    // The first call is cold (unoptimized code), as in the SDK's first idle-time pass.
    return { cold: times[0], ms: times.sort((a, b) => a - b)[3], findings };
  });
  const upload = await page.evaluate(() => ({ bytes: new TextEncoder().encode(window.uploads[0].serialized).byteLength, gzip: window.uploads[0].gzip }));
  await close();
  const s = run.summary;
  return {
    elements: s.element_count, truncated: s.truncated, torn: s.torn, wall: run.wall, walk: s.walk_ms, slices: s.slices,
    sdkMaxSlice: Math.max(...s.slice_ms), longestTask: Math.max(...tasks), longTasks: run.long.length, checks, ...upload,
  };
}

// 4. Time from a window capture listener (runs before the SDK's document listeners)
// to the app's own button handler, for real (trusted) mouse clicks.
async function clickRun(throttle, sdk) {
  const body = `${pageBody(500)}<button id="probe" style="position:fixed;top:200px;left:200px;z-index:9">Probe</button>`;
  const { page, close } = await openPage(body, { throttle, sdk, options: { clickSettleMs: 20, flushIntervalMs: 3_600_000 } });
  await page.evaluate(() => {
    window.lags = [];
    let start = 0;
    window.addEventListener("click", () => (start = performance.now()), true);
    document.getElementById("probe").addEventListener("click", () => {
      window.lags.push(performance.now() - start);
      document.getElementById("count").textContent = String(window.lags.length); // a visible effect
    });
  });
  await page.waitForTimeout(1500 * throttle); // first snapshot settles
  for (let i = 0; i < CLICKS; i++) {
    await page.mouse.click(210, 210);
    await page.waitForTimeout(40 * throttle); // the click settles and its snapshot runs before the next one
  }
  const lags = await page.evaluate(() => window.lags);
  await close();
  return { clicks: lags.length, median: median(lags), p95: pct(lags, 0.95), max: Math.max(...lags) };
}

// 6. Five seconds of an idle page after the first screen's snapshot, with and without the SDK.
async function idleRun(throttle, sdk) {
  const { page, close } = await openPage(pageBody(2000), { throttle, sdk, initScript: COUNTERS });
  await page.waitForTimeout(4000 * throttle); // routeSettleMs (1 s) + walk + checks + upload
  const before = await page.evaluate(() => ({ ...window.__timers }));
  await browser.startTracing(page, { categories: ["disabled-by-default-devtools.timeline", "devtools.timeline"] });
  const long = await page.evaluate(async () => {
    const long = [];
    new PerformanceObserver((list) => long.push(...list.getEntries())).observe({ type: "longtask" });
    await new Promise((done) => setTimeout(done, 5000));
    return long.length;
  });
  const tasks = mainThreadTasks(await browser.stopTracing());
  const after = await page.evaluate(() => ({ ...window.__timers }));
  await close();
  return {
    busyMs: tasks.reduce((a, b) => a + b, 0), longestTask: Math.max(...tasks), longTasks: long,
    timersScheduled: after.scheduled - before.scheduled - 1, // minus the benchmark's own setTimeout
    liveMutationObservers: after.observing,
  };
}

// 7. A thousand infinite CSS spinners (half inside an aria-hidden subtree), with
// and without the SDK: main-thread busy time in the 5 s while the SDK finds
// and looks at the loops, then in a later 5 s once it has settled, and what
// the SDK sent.
const SPINNERS = arg("spinners", 1000);
function spinnerBody(count) {
  const one = (i) => `<i data-testid="spin-${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i / 26) | 0) % 26)}" class="spin"></i>`;
  const half = count >> 1;
  return `<style>.spin{display:inline-block;width:8px;height:8px;border:2px solid #888;border-top-color:transparent;border-radius:50%;animation:spin 800ms linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style>
<div>${Array.from({ length: half }, (_, i) => one(i)).join("")}</div><div aria-hidden="true">${Array.from({ length: count - half }, (_, i) => one(half + i)).join("")}</div>`;
}
async function spinnerRun(throttle, sdk) {
  const options = { routeSettleMs: 3_600_000, flushIntervalMs: 3_600_000, snapshots: false, detect: { offscreenLoopMs: 1000 } };
  const { page, close } = await openPage(spinnerBody(SPINNERS), { throttle, sdk, options });
  await page.waitForTimeout(1500 * throttle);
  await browser.startTracing(page, { categories: ["disabled-by-default-devtools.timeline", "devtools.timeline"] });
  await page.evaluate(() => new Promise((done) => setTimeout(done, 5000)));
  const tasks = mainThreadTasks(await browser.stopTracing());
  await page.evaluate(() => new Promise((done) => setTimeout(done, 5000)));
  await browser.startTracing(page, { categories: ["disabled-by-default-devtools.timeline", "devtools.timeline"] });
  await page.evaluate(() => new Promise((done) => setTimeout(done, 5000)));
  const settled = mainThreadTasks(await browser.stopTracing());
  const sent = sdk
    ? await page.evaluate(async () => {
        await window.handle.flush();
        const events = memory.batches.flatMap((b) => b.events);
        const findings = events.filter((e) => e.type === "ui.finding");
        return { events: events.length, findings: findings.length, checks: [...new Set(findings.map((e) => e.data.check))] };
      })
    : null;
  await close();
  return { busyMs: tasks.reduce((a, b) => a + b, 0), longestTask: Math.max(...tasks), settledMs: settled.reduce((a, b) => a + b, 0), sent };
}

browser = await chromium.launch();
const machine = {
  cpu: (() => { try { return execSync("sysctl -n machdep.cpu.brand_string").toString().trim(); } catch { return cpus()[0]?.model; } })(),
  cores: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30), os: `${process.platform} ${release()}`,
  node: process.version, chromium: browser.version(), headless: true, viewport: "1280x720",
};
const results = { machine, runs: RUNS, bundle: sizes, snapshot: {}, clicks: {}, idle: {}, spinners: {} };
for (const throttle of THROTTLES) {
  for (const size of SIZES) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await snapshotRun(size, throttle));
    const pick = (key) => runs.map((run) => run[key]);
    results.snapshot[`${throttle}x/${size}`] = {
      elements: runs[0].elements, truncated: runs.some((x) => x.truncated), torn: runs.some((x) => x.torn),
      wallMs: median(pick("wall")), walkMs: median(pick("walk")), walkP95Ms: pct(pick("walk"), 0.95), slices: median(pick("slices")),
      sdkMaxSliceMs: Math.max(...pick("sdkMaxSlice")), longestTaskMedianMs: median(pick("longestTask")),
      longestTaskMaxMs: Math.max(...pick("longestTask")), longTasks: pick("longTasks").reduce((a, b) => a + b, 0),
      checksMs: median(runs.map((x) => x.checks.ms)), checksColdMs: median(runs.map((x) => x.checks.cold)),
      checksColdMaxMs: Math.max(...runs.map((x) => x.checks.cold)), findings: runs[0].checks.findings, bytes: runs[0].bytes, gzip: runs[0].gzip,
    };
    console.error(`snapshot ${throttle}x ${size}`, results.snapshot[`${throttle}x/${size}`]);
  }
  if (SNAPSHOTS_ONLY) continue;
  for (const sdk of [false, true]) results.clicks[`${throttle}x/${sdk ? "sdk" : "none"}`] = await clickRun(throttle, sdk);
  for (const sdk of [false, true]) results.idle[`${throttle}x/${sdk ? "sdk" : "none"}`] = await idleRun(throttle, sdk);
  for (const sdk of [false, true]) {
    const runs = [];
    for (let i = 0; i < Math.min(RUNS, 3); i++) runs.push(await spinnerRun(throttle, sdk));
    results.spinners[`${throttle}x/${sdk ? "sdk" : "none"}`] = {
      busyMs: median(runs.map((x) => x.busyMs)), longestTask: median(runs.map((x) => x.longestTask)),
      settledMs: median(runs.map((x) => x.settledMs)), sent: runs[0].sent,
    };
  }
  console.error(`clicks/idle/spinners ${throttle}x`, results.clicks, results.idle, results.spinners);
}
await browser.close();

const out = [];
out.push(`## Overhead (${machine.cpu}, ${machine.cores} cores, ${machine.os}; Chromium ${machine.chromium} headless; Node ${machine.node}; median of ${RUNS} runs)`, "");
if (Object.keys(OPTIONS).length) out.push(`SDK options: \`${JSON.stringify(OPTIONS)}\``, "");
out.push(`Bundle (esbuild --minify, all imports inlined; gzip level 6): main entry ${kb(sizes["index.ts"].min)} min / ${kb(sizes["index.ts"].gzip)} gzip (includes the checks); \`/detect\` ${kb(sizes["detect/index.ts"].min)} / ${kb(sizes["detect/index.ts"].gzip)}.`, "");
out.push("| CPU | Page elements | Recorded | Walk wall time | Walk CPU (median / p95) | Slices | Longest slice (SDK, max) | Longest main-thread task (median / max) | Long tasks | Checks, one idle task (first run median / max; warm) | Body | Body gzip |");
out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const [key, s] of Object.entries(results.snapshot)) {
  const [throttle, size] = key.split("/");
  out.push(`| ${throttle} | ~${size} | ${s.elements}${s.truncated ? " (truncated)" : ""}${s.torn ? " (torn)" : ""} | ${r(s.wallMs, 1)} ms | ${r(s.walkMs, 1)} / ${r(s.walkP95Ms, 1)} ms | ${s.slices} | ${r(s.sdkMaxSliceMs, 1)} ms | ${r(s.longestTaskMedianMs, 1)} / ${r(s.longestTaskMaxMs, 1)} ms | ${s.longTasks} | ${r(s.checksColdMs, 1)} / ${r(s.checksColdMaxMs, 1)} ms; ${r(s.checksMs, 1)} ms | ${kb(s.bytes)} | ${kb(s.gzip)} |`);
}
if (!SNAPSHOTS_ONLY) out.push("", "| CPU | Click to app handler, no SDK (median / p95) | With SDK (median / p95) | Idle 5 s main-thread busy, no SDK / SDK | Longest idle task, SDK | Long tasks idle | Timers scheduled idle | Live MutationObservers idle |");
if (!SNAPSHOTS_ONLY) out.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const throttle of SNAPSHOTS_ONLY ? [] : THROTTLES) {
  const [c0, c1, i0, i1] = [results.clicks[`${throttle}x/none`], results.clicks[`${throttle}x/sdk`], results.idle[`${throttle}x/none`], results.idle[`${throttle}x/sdk`]];
  out.push(`| ${throttle}x | ${r(c0.median, 3)} / ${r(c0.p95, 3)} ms | ${r(c1.median, 3)} / ${r(c1.p95, 3)} ms | ${r(i0.busyMs, 1)} / ${r(i1.busyMs, 1)} ms | ${r(i1.longestTask, 1)} ms | ${i1.longTasks} | ${i1.timersScheduled} | ${i1.liveMutationObservers} |`);
}
out.push("", `| CPU | ${SPINNERS} spinners, first 5 s main-thread busy, no SDK / SDK | Longest task, SDK | 5 s from 10 s on, no SDK / SDK | Events sent | Findings sent |`);
out.push("| --- | --- | --- | --- | --- | --- |");
for (const throttle of THROTTLES) {
  const [s0, s1] = [results.spinners[`${throttle}x/none`], results.spinners[`${throttle}x/sdk`]];
  out.push(`| ${throttle}x | ${r(s0.busyMs, 1)} / ${r(s1.busyMs, 1)} ms | ${r(s1.longestTask, 1)} ms | ${r(s0.settledMs, 1)} / ${r(s1.settledMs, 1)} ms | ${s1.sent?.events} | ${s1.sent?.findings} (${(s1.sent?.checks ?? []).join(", ")}) |`);
}
console.log(out.join("\n"));
console.log("\n```json\n" + JSON.stringify(results, null, 2) + "\n```");

import { expect, test, type Page } from "@playwright/test";
import { checkEvents, checkSnapshot, fingerprint, type Finding } from "../../src/detect/index";
import { APP, events, expectValid, init, openPage, output, rowOf, type Output } from "./harness";

// The test viewport is 1280 wide: the default band is 1024-1439.
const BAND = "1024-1439";
const fp = (check: Parameters<typeof fingerprint>[0], ids: (string | null)[], route = "/") =>
  fingerprint(check, route, BAND, ids);

const idle = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((resolve) => requestIdleCallback(() => setTimeout(resolve, 0), { timeout: 1000 })),
  );

const findingsOf = (out: Output) => events(out).filter((e) => e.type === "ui.finding");

/** The same finding without the local-only fields, for comparing Node results with sent events. */
const wire = (finding: Finding) => {
  const { type: _type, interaction_id: _id, ...data } = finding;
  return data;
};

interface Scan {
  body: any;
  sha256: string;
  node: Finding[];
  browser: any[];
  out: Output;
}

/** Opens `html`, takes one snapshot, and returns the Node checks and the findings the SDK sent for it. */
async function scan(page: Page, html: string, options: Record<string, unknown> = {}, path = "/"): Promise<Scan> {
  await openPage(page, html, {}, path);
  await init(page, options);
  const summary = await page.evaluate(() => (window as any).handle.snapshot());
  await idle(page);
  const out = await output(page);
  expectValid(out);
  const snapshot = out.snapshots.find((s) => s.sha256 === summary.sha256)!;
  expect(snapshot, "snapshot body").toBeTruthy();
  const node = checkSnapshot(snapshot.body, { ...((options.detect as object) ?? {}), sha256: snapshot.sha256 });
  const browser = findingsOf(out)
    .filter((e) => e.data.snapshot_sha256 === snapshot.sha256)
    .map((e) => e.data);
  return { body: snapshot.body, sha256: snapshot.sha256, node, browser, out };
}

/** Node and browser agree: one sent event per distinct fingerprint, identical data. */
function expectSame(result: Scan): void {
  const seen = new Set<string>();
  const firsts = result.node.filter((f) => !seen.has(f.fingerprint) && seen.add(f.fingerprint));
  expect(result.browser).toEqual(firsts.map(wire));
}

const checksOf = (findings: { check: string }[]) => findings.map((f) => f.check);

// ---- One fixture per layout check --------------------------------------------

test("overlap: a badge on a button's label sorts before a badge on an avatar's corner", async ({ page }) => {
  const result = await scan(
    page,
    `<div style="position:relative;margin:40px;height:200px">
      <div data-testid="avatar" style="position:absolute;left:0;top:0;width:48px;height:48px;border-radius:50%;background:#ccc"></div>
      <span data-testid="badge" style="position:absolute;left:38px;top:-6px;width:16px;height:16px;background:red;color:#fff;font-size:10px">3</span>
      <button data-testid="pay" style="position:absolute;left:0;top:100px;width:160px;height:40px">Pay now</button>
      <span data-testid="promo" style="position:absolute;left:30px;top:104px;width:100px;height:32px;background:gold">Sale</span>
    </div>`,
  );
  expectSame(result);
  const overlaps = result.node.filter((f) => f.type === "overlap");
  expect(overlaps.map((f) => [f.subject?.test_id, f.other?.test_id])).toEqual([
    ["pay", "promo"],
    ["avatar", "badge"],
  ]);
  const [pay, avatar] = overlaps;
  expect(pay.fingerprint).toBe(fp("overlap", ["pay", "promo"]));
  expect(avatar.fingerprint).toBe(fp("overlap", ["avatar", "badge"]));
  // Both report the intersection; only the button's has blocked points and covered text.
  expect(pay.evidence.overlap_px).toBeGreaterThan(0);
  expect(avatar.evidence.overlap_px).toBeGreaterThan(0);
  expect(pay.evidence).toMatchObject({ center_blocked: true, subject_text_covered: true, paint_order_from_hit_test: true });
  expect(pay.evidence.subject_blocked_points).toBeGreaterThan(0);
  expect(avatar.evidence).toMatchObject({ subject_blocked_points: 0, subject_text_covered: false });
  expect(pay.evidence.subject_covered_ratio).toBeGreaterThan(avatar.evidence.subject_covered_ratio as number);
  expect(pay.evidence).toMatchObject({ subject_depth_to_common: 1, other_depth_to_common: 1, common_parent_positioned: true });
});

test("spill: a child wider than its overflow:hidden card", async ({ page }) => {
  const result = await scan(
    page,
    `<div data-testid="card" style="width:200px;height:100px;overflow:hidden;margin:20px">
      <div data-testid="row" style="width:320px;height:20px;background:#eee"></div>
      <div data-testid="fits" style="width:200.5px;height:20px"></div>
    </div>`,
  );
  expectSame(result);
  const spills = result.node.filter((f) => f.type === "spill");
  expect(spills).toHaveLength(1);
  expect(spills[0].subject?.test_id).toBe("row");
  expect(spills[0].other?.test_id).toBe("card");
  expect(spills[0].fingerprint).toBe(fp("spill", ["row", "card"]));
  expect(spills[0].evidence).toMatchObject({ overflow_right_px: 120, overflow_left_px: 0, container_is_parent: true });
});

test("page_h_scroll: the element that widens the page", async ({ page }) => {
  const result = await scan(page, `<main><div data-testid="wide" style="width:1600px;height:20px"><span>x</span></div></main>`);
  expectSame(result);
  const found = result.node.filter((f) => f.type === "page_h_scroll");
  expect(found).toHaveLength(1);
  expect(found[0].subject?.test_id).toBe("wide");
  expect(found[0].fingerprint).toBe(fp("page_h_scroll", ["wide", null]));
  expect(found[0].evidence.overflow_px).toBeGreaterThan(300);
  expect(found[0].evidence.culprit_count).toBe(1);
});

test("offscreen_control: a button positioned left of the page cannot be reached", async ({ page }) => {
  const result = await scan(
    page,
    `<button data-testid="lost" style="position:absolute;left:-120px;top:10px;width:100px">Lost</button>
     <button data-testid="half" style="position:absolute;left:-20px;top:60px;width:100px">Half</button>
     <button data-testid="ok" style="position:absolute;left:10px;top:110px">Fine</button>`,
  );
  expectSame(result);
  const found = result.node.filter((f) => f.type === "offscreen_control");
  expect(found.map((f) => f.subject?.test_id)).toEqual(["lost", "half"]);
  expect(found[0].fingerprint).toBe(fp("offscreen_control", ["lost", null]));
  expect(found[0].evidence.reachable_ratio).toBe(0);
  expect(found[1].evidence.outside_left_px).toBe(20);
});

test("small_tap_target: only for touch input", async ({ page }) => {
  const html = `<p>Read the <a href="#" data-testid="inline">terms</a> first.</p>
    <button data-testid="tiny" style="width:16px;height:16px;padding:0"></button>
    <button data-testid="big" style="width:48px;height:48px"></button>`;
  const mouse = await scan(page, html);
  expect(checksOf(mouse.node)).not.toContain("layout.small_tap_target");
  await page.close();
  const touchPage = await page.context().newPage();
  const touch = await scan(touchPage, html, { detect: { touch: true } });
  expectSame(touch);
  const found = touch.node.filter((f) => f.type === "small_tap_target");
  expect(found.map((f) => f.subject?.test_id)).toEqual(["inline", "tiny"]);
  expect(found[0].evidence.inline_in_text).toBe(true);
  expect(found[1]).toMatchObject({ fingerprint: fp("small_tap_target", ["tiny", null]) });
  expect(found[1].evidence).toMatchObject({ width_px: 16, height_px: 16, min_size_px: 24, inline_in_text: false });
});

test("clipped_text: text cut by a fixed-size box, but not when it ends in an ellipsis", async ({ page }) => {
  const result = await scan(
    page,
    `<button data-testid="cut" style="width:80px;white-space:nowrap;overflow:hidden">Download the full report</button>
     <button data-testid="dots" style="width:80px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Download the full report</button>
     <div data-testid="clamp" style="width:80px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical">Download the full report</div>
     <span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Screen reader text that is long</span>`,
  );
  expectSame(result);
  const found = result.node.filter((f) => f.type === "clipped_text");
  expect(found.map((f) => f.subject?.test_id)).toEqual(["cut"]);
  expect(found[0].fingerprint).toBe(fp("clipped_text", ["cut", null]));
  expect(found[0].evidence).toMatchObject({ text_clipped: true, clipper_is_self: true });
  expect(found[0].evidence.clipped_right_px).toBeGreaterThan(20);
});

test("broken_image: an image that loaded no image data", async ({ page }) => {
  await openPage(page, `<img data-testid="hero" src="/missing.png" width="120" height="80" alt="">`);
  await page.waitForFunction(() => (document.querySelector("img") as HTMLImageElement).complete);
  await init(page);
  const summary = await page.evaluate(() => (window as any).handle.snapshot());
  await idle(page);
  const out = await output(page);
  expectValid(out);
  const body = out.snapshots.find((s) => s.sha256 === summary.sha256)!.body;
  const node = checkSnapshot(body);
  const found = node.filter((f) => f.type === "broken_image");
  expect(found).toHaveLength(1);
  expect(found[0].subject?.test_id).toBe("hero");
  expect(found[0].fingerprint).toBe(fp("broken_image", ["hero", null]));
  expect(findingsOf(out).map((e) => e.data.check)).toContain("stability.broken_image");
});

// ---- Layout negatives -----------------------------------------------------------

test("no overlap or spill: tooltip, dialog, ignored badge, scroller content, sticky header", async ({ page }) => {
  const result = await scan(
    page,
    `<header data-testid="top" style="position:sticky;top:0;height:60px;background:#fff;z-index:2">Header</header>
     <div style="position:relative;height:60px">
       <button data-testid="help" style="position:absolute;left:0;top:0;width:120px;height:40px">Help</button>
       <div role="tooltip" data-testid="tip" style="position:absolute;left:20px;top:10px;width:200px;height:40px;background:#333;color:#fff">Opens the guide</div>
     </div>
     <div style="position:relative;height:60px">
       <button data-testid="bell" style="width:120px;height:40px">Alerts</button>
       <span data-layout-ignore style="position:absolute;left:100px;top:-4px;width:24px;height:24px;background:red">9</span>
     </div>
     <div data-testid="list" style="height:100px;overflow:auto">
       ${Array.from({ length: 12 }, (_, i) => `<div data-testid="item-${i}" style="height:30px">Item ${i}</div>`).join("")}
     </div>
     <p data-testid="body" style="height:1500px">Long page text</p>
     <div role="dialog" data-testid="dialog" style="position:fixed;left:200px;top:100px;width:400px;height:300px;background:#fff">
       <p>Are you sure?</p><button>OK</button>
     </div>
     <dialog open data-testid="native" style="position:fixed;left:250px;top:150px;margin:0">Native dialog</dialog>`,
    {},
  );
  // Scroll the list and the page, then look again: content under the sticky header and inside the scroller.
  await page.evaluate(() => {
    document.querySelector('[data-testid="list"]')!.scrollTop = 45;
    window.scrollTo(0, 120);
  });
  const summary = await page.evaluate(() => (window as any).handle.snapshot());
  await idle(page);
  const out = await output(page);
  const scrolled = out.snapshots.find((s) => s.sha256 === summary.sha256)!;
  for (const findings of [result.node, checkSnapshot(scrolled.body)]) {
    const layout = findings.filter((f) => f.type === "overlap" || f.type === "spill");
    expect(layout.map((f) => `${f.check} ${f.subject?.stable_id} ${f.other?.stable_id}`)).toEqual([]);
  }
  expect(findingsOf(out).filter((e) => e.data.check === "layout.overlap" || e.data.check === "layout.spill")).toEqual([]);
});

test("the same overlap has the same fingerprint at different scroll offsets and in another session", async ({ page, browser }) => {
  const html = `<div style="height:600px"></div>
    <div style="position:relative;height:80px">
      <button data-testid="pay" style="position:absolute;left:0;top:0;width:160px;height:40px">Pay now</button>
      <span data-testid="promo" style="position:absolute;left:30px;top:4px;width:100px;height:32px;background:gold">Sale</span>
    </div><div style="height:1200px"></div>`;
  const first = await scan(page, html);
  await page.evaluate(() => window.scrollTo(0, 400));
  const summary = await page.evaluate(() => (window as any).handle.snapshot());
  const out = await output(page);
  const scrolledBody = out.snapshots.find((s) => s.sha256 === summary.sha256)!.body;
  expect(scrolledBody.viewport.scroll_y).toBe(400);
  const other = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  const second = await scan(await other.newPage(), html);
  await other.close();
  const prints = [first.node, checkSnapshot(scrolledBody), second.node].map((findings) =>
    findings.filter((f) => f.type === "overlap").map((f) => f.fingerprint),
  );
  expect(prints[0]).toEqual([fp("overlap", ["pay", "promo"])]);
  expect(prints[1]).toEqual(prints[0]);
  expect(prints[2]).toEqual(prints[0]);
});

test("an element without a test ID is identified by a structural path, and the finding says so", async ({ page }) => {
  const result = await scan(
    page,
    `<section data-testid="cart" style="position:relative;height:100px">
      <div><button style="position:absolute;left:0;top:0;width:120px;height:40px">Buy</button></div>
      <i style="position:absolute;left:60px;top:0;width:100px;height:40px;background:gold"></i>
    </section>`,
  );
  const [overlap] = result.node.filter((f) => f.type === "overlap");
  expect(overlap.subject?.stable_id).toBe("#cart/div/button");
  expect(overlap.other?.stable_id).toBe("#cart/i");
  expect(overlap.evidence).toMatchObject({ subject_structural_id: true, other_structural_id: true });
  expect(overlap.fingerprint).toBe(fp("overlap", ["#cart/div/button", "#cart/i"]));
});

test("checks give the same results in Node on a saved snapshot as in the browser", async ({ page }) => {
  const result = await scan(
    page,
    `<div data-testid="card" style="width:200px;height:60px;overflow:hidden;position:relative">
      <div data-testid="row" style="width:260px;height:20px"></div>
      <button data-testid="pay" style="position:absolute;left:0;top:20px;width:100px;height:30px">Pay</button>
      <span data-testid="promo" style="position:absolute;left:50px;top:24px;width:60px;height:20px;background:gold">!</span>
    </div>
    <button data-testid="cut" style="width:60px;white-space:nowrap;overflow:hidden">A long label here</button>`,
  );
  expect(result.node.length).toBeGreaterThanOrEqual(3);
  // The body as stored (JSON round trip) gives the same findings as the browser sent.
  const saved = JSON.parse(JSON.stringify(result.body));
  expect(checkSnapshot(saved, { sha256: result.sha256 })).toEqual(result.node);
  expectSame(result);
  // And the page itself, running the bundled checks, agrees.
  const inPage = await page.evaluate((body) => (window as any).CodepressInteractions.checkSnapshot?.(body) ?? null, saved);
  if (inPage) expect(inPage.map((f: Finding) => f.fingerprint)).toEqual(result.node.map((f) => f.fingerprint));
});

// ---- Click checks ---------------------------------------------------------------

const CLICKS = `
<button data-testid="dead">Nothing</button>
<button data-testid="fetch" id="fetch">Load</button>
<button data-testid="route" id="route">Next page</button>
<form><label><input type="checkbox" data-testid="agree"> Agree</label><p data-testid="note">Some text in a form</p></form>
<button data-testid="focus" id="focus">Edit</button><input data-testid="name" id="name">
<a data-testid="tab" href="/elsewhere" target="_blank">Docs</a>
<button data-testid="slow" id="slow">Slow</button>
<button data-testid="fail" id="fail">Fail</button>
<button data-testid="throw" id="throw">Throw</button>
<button data-testid="busy" id="busy">Busy</button>
<button data-testid="jank" id="jank">Jank</button>
<div id="out"></div>
<script>
  const $ = (id) => document.getElementById(id);
  $("fetch").addEventListener("click", () => fetch("/api/load"));
  $("route").addEventListener("click", () => history.pushState({}, "", "/next"));
  $("focus").addEventListener("click", () => $("name").focus());
  $("slow").addEventListener("click", async () => {
    await fetch("/api/slow");
    $("out").textContent = "done";
  });
  $("fail").addEventListener("click", () => fetch("/api/fail"));
  $("throw").addEventListener("click", () => { throw new Error("boom"); });
  $("busy").addEventListener("click", () => {
    const s = document.createElement("div");
    s.setAttribute("role", "progressbar");
    s.setAttribute("aria-busy", "true");
    s.textContent = "Loading";
    document.body.append(s);
  });
  $("jank").addEventListener("click", () => {
    const end = performance.now() + 300;
    while (performance.now() < end) {}
    $("out").textContent = "janked";
  });
</script>`;

async function clickPage(page: Page, options: Record<string, unknown> = {}) {
  const result = await openPage(page, CLICKS, {
    api: async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/slow") await new Promise((r) => setTimeout(r, 1200));
      if (path === "/api/fail") return route.fulfill({ status: 500, body: "{}" });
      return route.fulfill({ contentType: "application/json", body: "{}" });
    },
  });
  await init(page, { clickSettleMs: 150, ...options });
  return result;
}

const settledCount = async (page: Page) =>
  events(await output(page)).filter((e) => e.type === "ui.click.settled").length;

async function clickAndSettle(page: Page, selector: string) {
  const before = await settledCount(page);
  await page.click(selector);
  await expect.poll(() => settledCount(page), { timeout: 5000 }).toBeGreaterThan(before);
}

test("dead_click: a control that does nothing; fetch, route, checkbox, focus, new tab and plain text do not count", async ({ page }) => {
  await clickPage(page);
  for (const id of ["dead", "fetch", "route", "agree", "focus", "note"]) await clickAndSettle(page, `[data-testid="${id}"]`);
  const popup = page.waitForEvent("popup");
  await clickAndSettle(page, '[data-testid="tab"]');
  await (await popup).close();
  await idle(page);
  const out = await output(page);
  expectValid(out);
  const settled = events(out).filter((e) => e.type === "ui.click.settled");
  expect(settled).toHaveLength(7);
  const [dead, fetched, routed, agree, focused, note, tab] = settled.map((e) => e.data);
  expect(dead).toMatchObject({ control_id: "dead", target_interactive: true, first_feedback_ms: null, mutation_count: 0 });
  expect(fetched).toMatchObject({ control_id: "fetch", request_count: 1 });
  expect(routed).toMatchObject({ control_id: "route", route_changed: true });
  // A checkbox inside a form: the form is the control; the toggle is the effect.
  expect(agree).toMatchObject({ value_changed: true, target_interactive: true, mutation_count: 0 });
  expect(focused).toMatchObject({ control_id: "focus", focus_moved: true });
  // Plain text inside the same form: not a control.
  expect(note).toMatchObject({ control_id: agree.control_id, target_interactive: false });
  expect(tab).toMatchObject({ control_id: "tab", new_context: true });

  const node = checkEvents(events(out)).filter((f) => f.type === "dead_click");
  expect(node.map((f) => f.control_id)).toEqual(["dead"]);
  expect(node[0].fingerprint).toBe(fp("dead_click", ["dead"]));
  const sent = findingsOf(out).filter((e) => e.data.check === "click.dead_click");
  expect(sent).toHaveLength(1);
  expect(sent[0].data).toEqual(wire(node[0]));
  expect(sent[0].interaction_id).toBe(settled[0].interaction_id);
  expect(sent[0].attribution).toBe("inferred");
});

test("rage_click: three quick clicks on one control", async ({ page }) => {
  await clickPage(page);
  for (let i = 0; i < 4; i++) await page.click('[data-testid="dead"]', { delay: 0 });
  await expect.poll(() => settledCount(page)).toBeGreaterThanOrEqual(4);
  await idle(page);
  const out = await output(page);
  const node = checkEvents(events(out)).filter((f) => f.type === "rage_click");
  expect(node).toHaveLength(1);
  expect(node[0]).toMatchObject({ control_id: "dead", fingerprint: fp("rage_click", ["dead"]) });
  expect(node[0].evidence.click_count).toBe(4);
  expect(findingsOf(out).map((e) => e.data.check)).toContain("click.rage_click");
});

test("slow_feedback, silent_failure and error_after_click", async ({ page }) => {
  const { errors } = await clickPage(page, { clickSettleMs: 200 });
  for (const id of ["slow", "fail", "throw"]) await clickAndSettle(page, `[data-testid="${id}"]`);
  await idle(page);
  const out = await output(page);
  expect(errors).toEqual(["boom"]);
  const node = checkEvents(events(out));
  const pick = (type: string) => node.filter((f) => f.type === type).map((f) => f.control_id);
  expect(pick("slow_feedback")).toEqual(["slow"]);
  expect(pick("silent_failure")).toEqual(["fail"]);
  expect(pick("error_after_click")).toEqual(["throw"]);
  // The throwing handler changed nothing either: both pointers are reported, with the error count as evidence.
  expect(pick("dead_click")).toEqual(["throw"]);
  expect(node.find((f) => f.type === "dead_click")!.evidence.error_count).toBe(1);
  const slow = node.find((f) => f.type === "slow_feedback")!;
  expect(slow.fingerprint).toBe(fp("slow_feedback", ["slow"]));
  expect(slow.evidence.first_feedback_ms).toBeGreaterThanOrEqual(1000);
  expect(node.find((f) => f.type === "silent_failure")!.fingerprint).toBe(fp("silent_failure", ["fail"]));
  expect(node.find((f) => f.type === "error_after_click")!.fingerprint).toBe(fp("error_after_click", ["throw"]));
  const sent = new Set(findingsOf(out).map((e) => e.data.fingerprint));
  for (const finding of node) expect(sent.has(finding.fingerprint), finding.check).toBe(true);
});

// ---- Stability checks -------------------------------------------------------------

test("stuck_busy: a progress indicator that never goes away", async ({ page }) => {
  await clickPage(page, { detect: { stuckBusyMs: 300 } });
  await clickAndSettle(page, '[data-testid="busy"]');
  await page.waitForTimeout(400);
  const out = await output(page);
  const sent = findingsOf(out).filter((e) => e.data.check === "stability.stuck_busy");
  expect(sent).toHaveLength(1);
  expect(sent[0].data.evidence.busy_ms).toBeGreaterThanOrEqual(300);
  expect(sent[0].data.evidence.progress_indicator).toBe(true);
  const state = events(out).find((e) => e.type === "ui.state.changed" && e.data.feedback_type === "progress_indicator");
  expect(sent[0].data.fingerprint).toBe(fp("stuck_busy", [state.data.control_id]));
  // In Node, measured at a time of the caller's choosing.
  const later = Date.parse(state.occurred_at) + 10_000;
  expect(checkEvents(events(out), { now: later }).filter((f) => f.type === "stuck_busy")).toHaveLength(1);
  expect(checkEvents(events(out), { now: Date.parse(state.occurred_at) + 100 }).filter((f) => f.type === "stuck_busy")).toHaveLength(0);
});

test("layout_shift and slow_input from the performance summary", async ({ page }) => {
  await clickPage(page);
  await clickAndSettle(page, '[data-testid="jank"]');
  // Shifts within 500 ms of input are expected by the browser and not counted.
  await page.waitForTimeout(700);
  await page.evaluate(async () => {
    // A full-width panel, then a banner pushed in above it: most of the viewport moves.
    const panel = document.createElement("section");
    panel.style.cssText = "height:600px;background:#eef";
    document.body.prepend(panel);
    await new Promise((r) => setTimeout(r, 100));
    const block = document.createElement("div");
    block.style.height = "300px";
    document.body.prepend(block);
    await new Promise((r) => setTimeout(r, 100));
  });
  const out = await output(page);
  // Each flush takes a summary of its own window: look at all of them.
  const summaries = events(out).filter((e) => e.type === "perf.summary");
  const max = (key: string) => Math.max(...summaries.map((e) => e.data[key] ?? 0));
  const perf = { data: { layout_shift_score: max("layout_shift_score"), event_timing_max_ms: max("event_timing_max_ms") } };
  const node = checkEvents(events(out));
  const checks = checksOf(node);
  expect(checks).toContain("stability.layout_shift");
  expect(perf.data.layout_shift_score).toBeGreaterThanOrEqual(0.1);
  expect(perf.data.event_timing_max_ms).toBeGreaterThanOrEqual(200);
  expect(checks).toContain("stability.slow_input");
  const sent = findingsOf(out).map((e) => e.data.check);
  expect(sent).toContain("stability.layout_shift");
  expect(sent).toContain("stability.slow_input");
  expect(node.find((f) => f.type === "slow_input")!.fingerprint).toBe(fp("slow_input", [null]));
});

// ---- Click capture fixes ------------------------------------------------------------

test("F1: focus from a later click into an input is not credited to the earlier open click", async ({ page }) => {
  await clickPage(page, { clickSettleMs: 600 });
  await page.click('[data-testid="dead"]');
  await page.waitForTimeout(50);
  // A text field outside a form is not a tracked control: its click is only later input.
  await page.click('[data-testid="name"]');
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("name");
  await expect.poll(() => settledCount(page)).toBe(1);
  const out = await output(page);
  const [first] = events(out).filter((e) => e.type === "ui.click.settled");
  expect(first.data).toMatchObject({ control_id: "dead", focus_moved: false, first_feedback_ms: null });
});

test("F1: focus moved by keyboard after a click is not credited to the click", async ({ page }) => {
  await clickPage(page, { clickSettleMs: 400 });
  await page.click('[data-testid="dead"]');
  await page.keyboard.press("Tab");
  await expect.poll(() => settledCount(page)).toBe(1);
  const [click] = events(await output(page)).filter((e) => e.type === "ui.click.settled");
  expect(click.data).toMatchObject({ control_id: "dead", focus_moved: false, first_feedback_ms: null });
});

test("F2: slotted light-DOM content is not flagged in_shadow; shadow content is", async ({ page }) => {
  await openPage(
    page,
    `<x-card id="host"><button data-testid="slotted">Light</button></x-card>
     <script>
       const root = document.getElementById("host").attachShadow({ mode: "open" });
       root.innerHTML = '<div><slot></slot><button data-testid="inner">Shadow</button></div>';
     </script>`,
  );
  await init(page);
  await page.evaluate(() => (window as any).handle.snapshot());
  const out = await output(page);
  const body = out.snapshots[0].body;
  const flag = body.legend.flags.in_shadow;
  expect(body.elements.flags[rowOf(body, "inner")] & flag).toBe(flag);
  expect(body.elements.flags[rowOf(body, "slotted")] & flag).toBe(0);
});

test("navigating away right after a click is not a dead click", async ({ page }) => {
  await openPage(page, `<a data-testid="leave" href="/next">Next</a>`);
  await page.evaluate(() => {
    const w = window as any;
    const sink = {
      sendBatch(_batch: unknown, serialized: string) {
        const saved = JSON.parse(sessionStorage.getItem("batches") ?? "[]");
        saved.push(serialized);
        sessionStorage.setItem("batches", JSON.stringify(saved));
      },
      sendSnapshot() {},
    };
    w.handle = w.CodepressInteractions.initInteractions({
      sink,
      flushIntervalMs: 3_600_000,
      routeSettleMs: 3_600_000,
      clickSettleMs: 150,
    });
  });
  await Promise.all([page.waitForURL(`${APP}/next`), page.click('[data-testid="leave"]')]);
  const saved: string[] = await page.evaluate(() => JSON.parse(sessionStorage.getItem("batches") ?? "[]"));
  const all = saved.flatMap((s) => JSON.parse(s).events);
  const click = all.find((e: any) => e.type === "ui.click.settled");
  expect(click?.data).toMatchObject({ control_id: "leave", end_reason: "page_hidden" });
  expect(checkEvents(all).filter((f) => f.type === "dead_click")).toEqual([]);
  expect(all.filter((e: any) => e.type === "ui.finding" && e.data.check === "click.dead_click")).toEqual([]);
});

test("findings: false sends none", async ({ page }) => {
  await openPage(page, `<div data-testid="card" style="width:100px;height:50px;overflow:hidden"><div style="width:300px;height:10px"></div></div><button>x</button>`);
  await init(page, { findings: false, clickSettleMs: 100 });
  await page.evaluate(() => (window as any).handle.snapshot());
  await clickAndSettle(page, "button");
  await idle(page);
  const out = await output(page);
  expect(findingsOf(out)).toEqual([]);
  expect(checkSnapshot(out.snapshots[0].body).length).toBeGreaterThan(0);
});

test("content of a closed <details> is not visible, so closed accordions do not overlap", async ({ page }) => {
  const result = await scan(
    page,
    `<section style="width:600px">
      ${[1, 2, 3].map((i) => `<details data-testid="q${i}"><summary>Question ${i}</summary><div data-testid="a${i}" style="padding:20px">Answer ${i} with a few words</div></details>`).join("")}
      <details open data-testid="q4"><summary>Open question</summary><div data-testid="a4">Shown answer</div></details>
    </section>`,
  );
  const flag = result.body.legend.flags.visible;
  expect(result.body.elements.flags[rowOf(result.body, "a1")] & flag).toBe(0);
  expect(result.body.elements.flags[rowOf(result.body, "a4")] & flag).toBe(flag);
  expect(result.node.filter((f) => f.type === "overlap" || f.type === "spill")).toEqual([]);
});

test("theme: prefers-color-scheme by default, on the body and the ui.snapshot event", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await scan(page, `<main><button data-testid="go">Go</button></main>`);
  expect(dark.body.viewport.theme).toBe("dark");
  const snapshotEvent = (out: Output, sha: string) =>
    events(out).find((e) => e.type === "ui.snapshot" && e.data.sha256 === sha)!;
  expect(snapshotEvent(dark.out, dark.sha256).data.theme).toBe("dark");
  await page.emulateMedia({ colorScheme: "light" });
  const summary = await page.evaluate(() => (window as any).handle.snapshot());
  const out = await output(page);
  expectValid(out);
  expect(summary.sha256).not.toBe(dark.sha256);
  expect(snapshotEvent(out, summary.sha256).data.theme).toBe("light");
  expect(out.snapshots.find((s) => s.sha256 === summary.sha256)!.body.viewport.theme).toBe("light");
});

test("theme: the host's theme() wins over the media query; anything outside the enum is unknown", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openPage(page, `<main><button>Go</button></main>`);
  await page.evaluate(() => {
    const w = window as any;
    document.documentElement.dataset.theme = "dark";
    w.handle = w.CodepressInteractions.initInteractions({
      sink: w.sink,
      flushIntervalMs: 3_600_000,
      routeSettleMs: 3_600_000,
      allowedApiOrigins: [location.origin],
      theme: () => {
        if (document.documentElement.dataset.theme === "boom") throw new Error("no theme");
        return document.documentElement.dataset.theme;
      },
    });
  });
  const themes: string[] = [];
  for (const value of ["dark", "sepia", "boom", "light"]) {
    const summary = await page.evaluate(async (value) => {
      document.documentElement.dataset.theme = value;
      // A visible change too, so every screen has its own body.
      document.querySelector("button")!.textContent = `Go ${value}`;
      return (window as any).handle.snapshot();
    }, value);
    const out = await output(page);
    expectValid(out);
    const event = events(out).find((e) => e.type === "ui.snapshot" && e.data.sha256 === summary.sha256)!;
    expect(out.snapshots.find((s) => s.sha256 === summary.sha256)!.body.viewport.theme).toBe(event.data.theme);
    themes.push(event.data.theme);
  }
  expect(themes).toEqual(["dark", "unknown", "unknown", "light"]);
});

test("a fixed element over a control at the page origin is reported; once scrolled, it is not", async ({ page }) => {
  const result = await scan(
    page,
    `<main style="height:3000px">
      <button data-testid="buy" style="position:absolute;left:1000px;top:700px;width:160px;height:40px">Buy</button>
      <div data-testid="chat" style="position:fixed;left:980px;top:690px;width:220px;height:80px;background:#08f"></div>
    </main>`,
  );
  expectSame(result);
  const overlap = result.node.find((f) => f.type === "overlap")!;
  expect([overlap.subject?.test_id, overlap.other?.test_id]).toEqual(["buy", "chat"]);
  expect(overlap.evidence.subject_blocked_points).toBeGreaterThan(0);
  expect(result.node[0]).toBe(overlap);
  await page.evaluate(() => window.scrollTo(0, 300));
  const summary = await page.evaluate(() => (window as any).handle.snapshot());
  const out = await output(page);
  const scrolled = out.snapshots.find((s) => s.sha256 === summary.sha256)!;
  expect(checkSnapshot(scrolled.body).filter((f) => f.type === "overlap")).toEqual([]);
});

test("decorative layers and image crops carry content evidence and sort after content", async ({ page }) => {
  const result = await scan(
    page,
    `<section data-testid="hero" style="position:relative;overflow:hidden;width:800px;height:400px">
      <img data-testid="art" alt="" style="position:absolute;left:-60px;top:0;width:920px;height:400px;display:block" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==">
      <div data-testid="glow" style="position:absolute;inset:0;pointer-events:none;background:linear-gradient(#0000,#0008)"></div>
      <div aria-hidden="true" data-testid="shape" style="position:absolute;left:600px;top:40px;width:120px;height:120px;border-radius:50%;background:#f0f"><span data-testid="dot" style="display:block;width:20px;height:20px"></span></div>
    </section>
    <div style="position:relative;margin-top:20px">
      <p data-testid="caption" style="margin:0;font-size:16px">Caption text</p>
      <span data-testid="tag" style="position:absolute;left:40px;top:4px;width:60px;height:14px;background:#ccc"></span>
    </div>
    <div style="height:200px"><a data-testid="tiny" href="#x" style="font-size:10px">x</a></div>`,
    { detect: { touch: true } },
  );
  expectSame(result);
  const flags = result.body.legend.flags;
  expect(result.body.elements.flags[rowOf(result.body, "dot")] & flags.aria_hidden).toBe(flags.aria_hidden);
  const label = (f: Finding) => `${f.type} ${f.subject?.test_id} ${f.other?.test_id ?? ""}`.trim();
  const order = result.node.map(label);
  // Covered text first, then the tap target, then decorative and content-free findings.
  expect(order[0]).toBe("overlap caption tag");
  const tap = order.indexOf("small_tap_target tiny");
  expect(tap).toBeGreaterThan(0);
  const tail = result.node.slice(tap + 1);
  expect(tail.length).toBeGreaterThan(0);
  for (const f of tail)
    expect(
      f.evidence.subject_decorative === true ||
        f.evidence.other_decorative === true ||
        (f.evidence.subject_has_content === false && (f.type === "spill" || f.evidence.other_has_content === false)),
      label(f),
    ).toBe(true);
  expect(order).toContain("spill art hero");
});

import { expect, test, type Page } from "@playwright/test";
import { checkEvents, checkSnapshot, findingTier, fingerprint, focusIndicatorFindings, type Finding } from "../../src/detect/index";
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

// ---- data-layout-allow-overlap ------------------------------------------------------

const overlapsOf = (findings: Finding[]) =>
  findings.filter((f) => f.type === "overlap").map((f) => [f.subject?.test_id ?? f.subject?.stable_id, f.other?.test_id ?? f.other?.stable_id]);

test("allow-overlap: a badge marked for its avatar is not reported; one marked for another element is", async ({ page }) => {
  const avatar = (marker: string) =>
    `<div style="position:relative;margin:40px;height:200px">
      <div data-testid="avatar" style="position:absolute;left:0;top:0;width:48px;height:48px;border-radius:50%;background:#ccc"><img alt="" style="width:48px;height:48px;display:block"></div>
      <span data-testid="badge" data-layout-allow-overlap="${marker}" style="position:absolute;left:38px;top:-6px;width:16px;height:16px;background:red;color:#fff;font-size:10px">3</span>
      <div data-testid="card" style="position:absolute;left:0;top:100px;width:48px;height:48px"></div>
    </div>`;
  const allowed = await scan(page, avatar("avatar"));
  expectSame(allowed);
  expect(overlapsOf(allowed.node)).toEqual([]);
  const badge = rowOf(allowed.body, "badge");
  expect(allowed.body.elements.flags[badge] & 16384).toBe(16384);
  expect(allowed.body.allow_overlap).toEqual({ element: [badge], other: [rowOf(allowed.body, "avatar")] });

  const other = await scan(await page.context().newPage(), avatar("card"));
  expectSame(other);
  expect(overlapsOf(other.node)).toEqual([["avatar", "badge"]]);
  expect(other.node[0].evidence.allow_marker_overridden).toBe(false);
  // The named element exists but does not touch the badge: no pair is recorded.
  expect(other.body.allow_overlap).toEqual({ element: [], other: [] });
});

test("allow-overlap: the marker gives way once the badge covers the centre of an avatar button", async ({ page }) => {
  const result = await scan(
    page,
    `<div style="position:relative;margin:40px;height:200px">
      <button data-testid="avatar" style="position:absolute;left:0;top:0;width:48px;height:48px;border-radius:50%;padding:0;border:0;background:#ccc"></button>
      <span data-testid="badge" data-layout-allow-overlap="avatar" style="position:absolute;left:12px;top:12px;width:30px;height:30px;background:red"></span>
    </div>`,
  );
  expectSame(result);
  const found = result.node.filter((f) => f.type === "overlap");
  expect(overlapsOf(found)).toEqual([["avatar", "badge"]]);
  expect(found[0].evidence).toMatchObject({ center_blocked: true, subject_interactive: true, allow_marker_overridden: true });
});

test("allow-overlap: * on a fixed header, a marker on the covered side, and a name the test ID filter drops", async ({ page }) => {
  const html = (attr: string) =>
    `<header data-testid="top" ${attr}="*" style="position:fixed;left:0;top:0;width:100%;height:60px;background:#fff">Header</header>
     <main style="padding-top:40px"><p data-testid="intro" style="margin:0">Intro text under the header</p></main>
     <div style="position:relative;margin:100px 40px;height:60px">
       <div data-testid="user-42" style="position:absolute;left:0;top:0;width:48px;height:48px;background:#ccc"></div>
       <span data-testid="dot" ${attr}="user-42" style="position:absolute;left:38px;top:-6px;width:16px;height:16px;background:red"></span>
       <div data-testid="photo" ${attr}="pip" style="position:absolute;left:100px;top:0;width:48px;height:48px;background:#ccc"></div>
       <span data-testid="pip" style="position:absolute;left:138px;top:-6px;width:16px;height:16px;background:red"></span>
     </div>`;
  const unmarked = await scan(page, html("data-other"));
  expectSame(unmarked);
  const pairs = overlapsOf(unmarked.node);
  expect(pairs).toHaveLength(3);
  expect(pairs).toContainEqual(["photo", "pip"]);
  expect(pairs.filter(([, b]) => b === "top")).toHaveLength(1);
  expect(pairs.filter(([, b]) => b === "dot")).toHaveLength(1);

  const marked = await scan(await page.context().newPage(), html("data-layout-allow-overlap"));
  expectSame(marked);
  expect(overlapsOf(marked.node)).toEqual([]);
  // user-42 is dropped by the default test ID filter, yet the marker naming it still applies.
  expect(marked.body.dictionaries.test_id).not.toContain("user-42");
  expect(marked.body.allow_overlap.element).toHaveLength(3);
});

test("allow-overlap: names resolve for boxes too large to bucket, as marker or as partner", async ({ page }) => {
  // Each backdrop spans more than 64 cells of the 256 px grid the walk matches names on.
  const html = (attr: string) =>
    `<div style="position:relative;height:3200px">
       <div data-testid="backdrop" ${attr}="chip" style="position:absolute;left:0;top:0;width:1200px;height:3000px;background:#eee"></div>
       <span data-testid="chip" style="position:absolute;left:1180px;top:2000px;width:40px;height:20px;background:#09f"></span>
       <div data-testid="poster" style="position:absolute;left:0;top:0;width:1200px;height:3000px"></div>
       <span data-testid="sticker" ${attr}="poster" style="position:absolute;left:600px;top:2900px;width:40px;height:20px;background:red"></span>
     </div>`;
  const unmarked = await scan(page, html("data-other"));
  expectSame(unmarked);
  const pairs = overlapsOf(unmarked.node);
  expect(pairs).toContainEqual(["backdrop", "chip"]);
  expect(pairs).toContainEqual(["poster", "sticker"]);
  const marked = await scan(await page.context().newPage(), html("data-layout-allow-overlap"));
  expectSame(marked);
  const left = overlapsOf(marked.node);
  expect(left).not.toContainEqual(["backdrop", "chip"]);
  expect(left).not.toContainEqual(["poster", "sticker"]);
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
<form data-testid="prefs">
  <input type="checkbox" data-testid="c1"><input type="checkbox" data-testid="c2"><input type="checkbox" data-testid="c3">
  <label for="nick" data-testid="nick-label">Nickname</label><input id="nick" data-testid="nick">
</form>
<label for="go" data-testid="go-label">Go</label> <button id="go" data-testid="go">Go</button>
<label><button data-testid="wrapped">Wrapped</button> wrapped label text</label>
<form data-testid="termsform">
  <button type="button" role="checkbox" aria-checked="false" id="terms" data-testid="terms">✓</button>
  <label for="terms" data-testid="terms-label">I accept the terms</label>
  <label for="termsnote">Note <a href="#help" data-testid="help-link">help</a></label> <input id="termsnote" data-testid="termsnote">
  <label><input type="checkbox" data-testid="remember"> Remember me <span tabindex="0" data-testid="remember-info">(i)</span></label>
</form>
<form data-testid="busyform">
  <label for="busyfield" id="busylabel" data-testid="busy-label">Busy label</label><br><br><input id="busyfield" data-testid="busyfield">
</form>
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
  $("terms").addEventListener("click", () => {
    const box = $("terms");
    box.setAttribute("aria-checked", box.getAttribute("aria-checked") === "true" ? "false" : "true");
  });
  $("busylabel").addEventListener("click", (event) => {
    event.preventDefault();
    const until = performance.now() + 400;
    while (performance.now() < until) {}
  });
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

test("rage_click: a burst right after init is sent once, with the real viewport", async ({ page }) => {
  // Clicked before the first snapshot: the burst has no viewport until it lands.
  await clickPage(page);
  for (let i = 0; i < 4; i++) await page.click('[data-testid="dead"]', { delay: 0 });
  await expect.poll(() => settledCount(page)).toBeGreaterThanOrEqual(4);
  await idle(page);
  await page.evaluate(() => (window as any).handle.flush());
  await idle(page);
  const out = await output(page);
  expectValid(out);
  const node = checkEvents(events(out)).filter((f) => f.type === "rage_click");
  expect(node).toHaveLength(1);
  expect(node[0]).toMatchObject({ control_id: "dead", fingerprint: fp("rage_click", ["dead"]) });
  expect(node[0].evidence).toMatchObject({ click_count: 4, clicks_with_feedback: 0, clicks_settled: 4 });
  const sent = findingsOf(out).filter((e) => e.data.check === "click.rage_click");
  expect(sent).toHaveLength(1);
  expect(sent[0].data.viewport_width).toBe(page.viewportSize()!.width);
  expect(sent[0].data).toEqual(wire(node[0]));
});

test("rage_click: different fields of one form, a toggled checkbox and a label are not rage", async ({ page }) => {
  await clickPage(page);
  // Three different checkboxes in one form, quickly: every click changed a value.
  for (const id of ["c1", "c2", "c3"]) await page.click(`[data-testid="${id}"]`, { delay: 0 });
  // The same checkbox three times: each click answered.
  for (let i = 0; i < 3; i++) await page.click('[data-testid="c1"]', { delay: 0 });
  await expect.poll(() => settledCount(page)).toBeGreaterThanOrEqual(6);
  const starts = async () => events(await output(page)).filter((e) => e.type === "interaction.started" && e.data.action === "click").length;
  const before = await starts();
  // A label click makes the browser click its field too: that is one user click.
  await page.click('[data-testid="nick-label"]');
  await page.click('[data-testid="c2"]', { delay: 0 });
  await expect.poll(starts).toBe(before + 2);
  await idle(page);
  await page.evaluate(() => (window as any).handle.flush());
  await idle(page);
  const out = await output(page);
  expectValid(out);
  const clicks = events(out).filter((e) => e.type === "interaction.started" && e.data.action === "click");
  expect(clicks).toHaveLength(8);
  expect(new Set(clicks.map((e) => e.data.control_id))).toEqual(new Set(["prefs"]));
  // Distinct targets get distinct keys; the same checkbox keeps its key.
  const keys = clicks.map((e) => e.data.target_key);
  expect(new Set(keys.slice(0, 3)).size).toBe(3);
  expect(keys.slice(3, 6)).toEqual([keys[0], keys[0], keys[0]]);
  expect(checkEvents(events(out)).filter((f) => f.type === "rage_click")).toEqual([]);
  expect(findingsOf(out).filter((e) => e.data.check === "click.rage_click")).toEqual([]);
});

test("a label outside any tracked control still records its field's click", async ({ page }) => {
  await clickPage(page);
  // A label for a do-nothing button, and a label wrapping one: the button's click counts.
  await clickAndSettle(page, '[data-testid="go-label"]');
  await clickAndSettle(page, "text=wrapped label text");
  await idle(page);
  const out = await output(page);
  const starts = events(out).filter((e) => e.type === "interaction.started" && e.data.action === "click");
  expect(starts.map((e) => e.data.control_id)).toEqual(["go", "wrapped"]);
  const dead = findingsOf(out).filter((e) => e.data.check === "click.dead_click").map((e) => e.data.control_id);
  expect(dead.sort()).toEqual(["go", "wrapped"]);
});

test("a label for a button-type field in a form is one click on that field, and not rage", async ({ page }) => {
  await clickPage(page);
  const starts = async () =>
    events(await output(page)).filter((e) => e.type === "interaction.started" && e.data.action === "click");
  // shadcn/Radix-style checkbox: a <button role="checkbox"> with a <label for>.
  await clickAndSettle(page, '[data-testid="terms-label"]');
  expect((await starts()).map((e) => e.data.control_id)).toEqual(["terms"]);
  for (let i = 0; i < 2; i++) {
    await page.waitForTimeout(300);
    await page.click('[data-testid="terms-label"]');
  }
  await expect.poll(async () => (await starts()).length).toBe(3);
  expect(await page.getAttribute('[data-testid="terms"]', "aria-checked")).toBe("true");
  // A link inside a label is its own click; the browser forwards nothing.
  await clickAndSettle(page, '[data-testid="help-link"]');
  await clickAndSettle(page, '[data-testid="termsnote"]');
  await idle(page);
  await page.evaluate(() => (window as any).handle.flush());
  await idle(page);
  const out = await output(page);
  expectValid(out);
  expect((await starts()).map((e) => e.data.control_id)).toEqual(["terms", "terms", "terms", "help-link", "termsform"]);
  const settled = events(out).filter((e) => e.type === "ui.click.settled").slice(0, 3);
  for (const s of settled) expect(s.data.first_feedback_ms).not.toBeNull();
  expect(checkEvents(events(out)).filter((f) => f.type === "rage_click")).toEqual([]);
  expect(findingsOf(out).filter((e) => e.data.check === "click.rage_click")).toEqual([]);
});

test("a focusable span inside a label is still forwarded: one start per click, no rage", async ({ page }) => {
  await clickPage(page);
  for (let i = 0; i < 3; i++) {
    if (i) await page.waitForTimeout(300);
    await page.click('[data-testid="remember-info"]');
  }
  const starts = async () =>
    events(await output(page)).filter((e) => e.type === "interaction.started" && e.data.action === "click");
  await expect.poll(async () => (await starts()).length).toBe(3);
  expect(await page.isChecked('[data-testid="remember"]')).toBe(true);
  await idle(page);
  await page.evaluate(() => (window as any).handle.flush());
  await idle(page);
  const out = await output(page);
  expect((await starts()).map((e) => e.data.control_id)).toEqual(["termsform", "termsform", "termsform"]);
  expect(checkEvents(events(out)).filter((f) => f.type === "rage_click")).toEqual([]);
  expect(findingsOf(out).filter((e) => e.data.check === "click.rage_click")).toEqual([]);
});

test("a real click right after a slow label click is not taken for the label's forwarded click", async ({ page }) => {
  await clickPage(page);
  const label = (await page.locator('[data-testid="busy-label"]').boundingBox())!;
  const field = (await page.locator('[data-testid="busyfield"]').boundingBox())!;
  const first = page.mouse.click(label.x + 3, label.y + 3);
  await page.waitForTimeout(60);
  const second = page.mouse.click(field.x + 5, field.y + 5);
  await Promise.all([first, second]);
  await idle(page);
  const starts = events(await output(page)).filter((e) => e.type === "interaction.started" && e.data.action === "click");
  expect(starts).toHaveLength(2);
  expect(starts[0].data.target_key).not.toBe(starts[1].data.target_key);
});

test("an early finding waits through a pagehide that keeps the page, and is sent once", async ({ page }) => {
  await clickPage(page);
  // Before the first snapshot: the burst has no viewport yet.
  await page.evaluate(() => {
    const button = document.querySelector('[data-testid="dead"]') as HTMLElement;
    for (let i = 0; i < 4; i++) button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await expect.poll(() => settledCount(page)).toBeGreaterThanOrEqual(4);
  await page.evaluate(() => (window as any).handle.snapshot());
  await idle(page);
  await page.evaluate(() => (window as any).handle.flush());
  await idle(page);
  const out = await output(page);
  const sent = findingsOf(out).filter((e) => e.data.check === "click.rage_click");
  expect(sent).toHaveLength(1);
  expect(sent[0].data.viewport_width).toBe(page.viewportSize()!.width);
  expect(checkEvents(events(out)).filter((f) => f.type === "rage_click").map((f) => f.fingerprint)).toEqual([sent[0].data.fingerprint]);
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
      ${["one", "two", "three"].map((i) => `<details data-testid="q-${i}"><summary>Question ${i}</summary><div data-testid="a-${i}" style="padding:20px">Answer ${i} with a few words</div></details>`).join("")}
      <details open data-testid="q-four"><summary>Open question</summary><div data-testid="a-four">Shown answer</div></details>
    </section>`,
  );
  const flag = result.body.legend.flags.visible;
  expect(result.body.elements.flags[rowOf(result.body, "a-one")] & flag).toBe(0);
  expect(result.body.elements.flags[rowOf(result.body, "a-four")] & flag).toBe(flag);
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

// ---- 1.0.0: text fields, form owners, padded headers ---------------------------

test("rage_click: repeated clicks and a triple-click in one text field of a form are not rage; a dead button still is", async ({ page }) => {
  await openPage(
    page,
    `<form data-testid="profile">
       <input data-testid="city" value="San Francisco, California" style="width:300px">
       <p data-testid="hint">Use the city you live in now, not where you were born.</p>
     </form>
     <button data-testid="dead">Nothing</button>`,
  );
  await init(page, { clickSettleMs: 200 });
  await page.evaluate(() => (window as any).handle.snapshot());
  // Three separate clicks in the field, a real triple-click selecting its text,
  // and a triple-click selecting the paragraph's text.
  for (let i = 0; i < 3; i++) await page.click('[data-testid="city"]', { delay: 0 });
  await expect.poll(() => settledCount(page)).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(1200);
  await page.click('[data-testid="city"]', { clickCount: 3 });
  await page.waitForTimeout(1200);
  await page.click('[data-testid="hint"]', { clickCount: 3 });
  expect(await page.evaluate(() => getSelection()!.toString())).toContain("Use the city");
  await page.waitForTimeout(1200);
  // A button that does nothing, clicked three times: rage.
  for (let i = 0; i < 3; i++) await page.click('[data-testid="dead"]', { delay: 0 });
  await page.waitForTimeout(800);
  await idle(page);
  await page.evaluate(() => (window as any).handle.flush());
  await idle(page);
  const out = await output(page);
  expectValid(out);
  const settledFor = (id: string) => events(out).filter((e) => e.type === "ui.click.settled" && e.data.control_id === id);
  // Each field click put the caret in the focused field; the paragraph's presses changed the selection.
  expect(settledFor("profile").length).toBeGreaterThanOrEqual(3);
  for (const e of settledFor("profile")) expect(e.data.field_focused || e.data.selection_changed).toBe(true);
  const rage = checkEvents(events(out)).filter((f) => f.type === "rage_click");
  expect(rage.map((f) => f.control_id)).toEqual(["dead"]);
  expect(findingsOf(out).filter((e) => e.data.check === "click.rage_click").map((e) => e.data.control_id)).toEqual(["dead"]);
});

test("a label click on a field joined to another form with the form attribute is one start, on the field's form", async ({ page }) => {
  // The label sits in form A; its field joins form B through form="b", wherever it is in the DOM.
  const shapes = [
    `<form id="a" data-testid="A"><label for="x" data-testid="L">Opt in</label></form><input type="checkbox" id="x" form="b" data-testid="X"><form id="b" data-testid="B"></form>`,
    `<form id="a" data-testid="A"><label for="x" data-testid="L">Opt in</label><input type="checkbox" id="x" form="b" data-testid="X"></form><form id="b" data-testid="B"></form>`,
    `<form id="a" data-testid="A"><label data-testid="L">Opt in <input type="checkbox" form="b" data-testid="X"></label></form><form id="b" data-testid="B"></form>`,
    `<form id="a" data-testid="A"><label for="x" data-testid="L">City</label></form><div><input id="x" form="b" data-testid="X"></div><form id="b" data-testid="B"></form>`,
  ];
  for (const html of shapes) {
    await page.unrouteAll();
    await openPage(page, html);
    await init(page, { snapshots: false, clickSettleMs: 200 });
    await page.click('[data-testid="L"]');
    // The field's own click goes to the same form.
    await page.waitForTimeout(400);
    await page.click('[data-testid="X"]');
    await page.waitForTimeout(400);
    const starts = events(await output(page)).filter((e) => e.type === "interaction.started");
    expect(starts.map((e) => e.data.control_id), html).toEqual(["B", "B"]);
  }
});

test("a fixed header over a padded main is reported, with no content covered, and sorts as empty", async ({ page }) => {
  const header = `<header data-testid="header" style="position:fixed;top:0;left:0;right:0;height:64px;background:#fff;z-index:10"><a href="/" data-testid="home">Home</a></header>`;
  const padded = await scan(
    page,
    `${header}<main data-testid="main" style="padding-top:64px"><h1 data-testid="title" style="margin:8px 16px">Orders</h1><button data-testid="save">Save</button></main>`,
  );
  expectSame(padded);
  const overlaps = padded.node.filter((f) => f.type === "overlap");
  expect(overlaps.map((f) => `${f.subject?.test_id} ${f.other?.test_id}`)).toEqual(["main header"]);
  expect(overlaps[0].evidence).toMatchObject({ subject_blocked_points: 0, subject_text_covered: false, subject_content_covered: false });
  expect(findingTier(overlaps[0])).toBe(3);
  // The same header over a heading that starts under it covers content.
  const tight = await scan(
    page,
    `${header}<main data-testid="main"><h1 data-testid="title" style="margin:8px 16px">Orders</h1></main>`,
  );
  const [covering] = tight.node.filter((f) => f.type === "overlap");
  expect(covering.evidence).toMatchObject({ subject_content_covered: true, subject_text_covered: true });
  expect(findingTier(covering)).toBe(1);
});

test("a fixed widget beside main is reported against main, carrying the covered button's blocked points", async ({ page }) => {
  const result = await scan(
    page,
    `<main data-testid="main" style="height:700px"><button data-testid="save" style="position:absolute;right:24px;bottom:124px;width:120px;height:40px">Save</button></main>
     <div data-testid="chat" style="position:fixed;right:16px;bottom:116px;width:80px;height:80px;background:#36f;border-radius:40px"></div>`,
  );
  expectSame(result);
  const overlaps = result.node.filter((f) => f.type === "overlap");
  expect(overlaps.map((f) => `${f.subject?.test_id} ${f.other?.test_id}`)).toEqual(["main chat"]);
  expect(overlaps[0].evidence.subject_blocked_points).toBeGreaterThan(0);
  expect(overlaps[0].evidence).toMatchObject({ subject_blocked_controls: 1, subject_content_covered: true, subject_interactive: false });
  expect(findingTier(overlaps[0])).toBe(0);
  expect(result.node[0]).toBe(overlaps[0]);
});

test("a label click the browser does not forward, and that changes nothing, is a dead click on the label's control", async ({ page }) => {
  await openPage(
    page,
    `<form data-testid="signup">
       <label for="token" data-testid="hidden-label">Token</label><input type="hidden" id="token">
       <label data-testid="details-label">Terms <details><summary>Read</summary><span data-testid="terms-body">Body</span></details></label>
       <label for="off" data-testid="disabled-label">Off</label><input id="off" disabled>
     </form>`,
  );
  await init(page, { clickSettleMs: 200 });
  await page.evaluate(() => (window as any).handle.snapshot());
  await page.click('[data-testid="details-label"] summary');
  await page.waitForTimeout(500);
  await idle(page);
  for (const id of ["hidden-label", "terms-body"]) await clickAndSettle(page, `[data-testid="${id}"]`);
  // Playwright waits for a label's field to be enabled, so press the disabled field's label by position.
  const box = (await page.locator('[data-testid="disabled-label"]').boundingBox())!;
  const before = await settledCount(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => settledCount(page), { timeout: 5000 }).toBeGreaterThan(before);
  await idle(page);
  const out = await output(page);
  const dead = checkEvents(events(out)).filter((f) => f.type === "dead_click");
  expect(dead.map((f) => f.control_id)).toEqual(["signup", "signup", "signup"]);
  for (const f of dead) expect(f.evidence.structural_id).toBe(false);
  const settledOf = events(out).filter((e) => e.type === "ui.click.settled").slice(-3);
  for (const e of settledOf) expect(e.data).toMatchObject({ target_interactive: true, first_feedback_ms: null });
});

// ---- Accessibility -------------------------------------------------------------

test("no_focus_indicator: Tab to outline:none buttons, with and without a :focus-within wrapper or a focus transition", async ({ page }) => {
  await openPage(
    page,
    `<style>
       .wrap:focus-within { box-shadow: 0 0 0 2px blue; }
       .fade { outline: 2px solid transparent; transition: outline-color 0.2s; }
       .fade:focus-visible { outline-color: blue; }
       .ring:focus-visible { outline: none; box-shadow: 0 0 0 3px orange; }
     </style>
     <button data-testid="bare" style="outline:none">Bare</button>
     <button data-testid="ua">Default ring</button>
     <span class="wrap"><button data-testid="wrapped" style="outline:none">Wrapped</button></span>
     <button data-testid="fade" class="fade">Fade</button>
     <button data-testid="shadow" class="ring">Shadow</button>
     <div><div><a href="#" data-testid="deep" style="outline:none">Deep link</a></div></div>
     <button data-testid="end">End</button>`,
  );
  await init(page);
  const snapshot = await page.evaluate(() => (window as any).handle.snapshot());
  for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
  await page.waitForTimeout(100);
  const out = await output(page);
  expectValid(out);
  const browser = findingsOf(out).filter((e) => e.data.check === "a11y.no_focus_indicator").map((e) => e.data);
  expect(browser.map((f) => f.control_id)).toEqual(["bare", "deep"]);
  // Node builds the same finding from the same observation.
  const node = (["bare", "deep"] as const).flatMap((id) =>
    focusIndicatorFindings({
      control_id: id,
      route_template: "/",
      viewport_width: 1280,
      viewport_height: 800,
      snapshot_sha256: snapshot.sha256,
      indicator_changed: false,
      wrappers: id === "bare" ? 0 : 2,
    }),
  );
  expect(browser).toEqual(node.map(wire));
  expect(browser[0].fingerprint).toBe(fp("no_focus_indicator", ["bare"]));
});

// ---- Accessibility: contrast and accessible names ----------------------------------

const ofType = (findings: Finding[], type: Finding["type"]) => findings.filter((f) => f.type === type);
/** contrast_unknown summed over every perf.summary sent. */
const contrastUnknown = (out: Output) =>
  events(out)
    .filter((e) => e.type === "perf.summary")
    .reduce((sum, e) => sum + (e.data.contrast_unknown ?? 0), 0);

test("low_contrast: #999 text on #aaa needs 4.5:1 and has about 1.22:1", async ({ page }) => {
  const result = await scan(
    page,
    `<main style="background:#aaa;padding:16px"><p data-testid="faint" style="color:#999">Shipping is free over fifty</p></main>`,
  );
  expectSame(result);
  const found = ofType(result.node, "low_contrast");
  expect(found).toHaveLength(1);
  expect(found[0].subject?.test_id).toBe("faint");
  expect(found[0].check).toBe("a11y.low_contrast");
  // WCAG 2.x: (L(#aaa) + 0.05) / (L(#999) + 0.05) = 1.2264, rounded down to 2 places.
  expect(found[0].evidence).toMatchObject({ contrast_ratio: 1.22, required_ratio: 4.5, font_px: 16, bold: false, theme_dark: false });
  expect(found[0].fingerprint).toBe(fp("low_contrast", ["faint", null]));
  expect(contrastUnknown(result.out)).toBe(0);
});

test("low_contrast: black on white, 24px #767676 (4.54:1) and 19px bold #949494 (3.03:1) are not reported", async ({ page }) => {
  const result = await scan(
    page,
    `<main style="padding:16px">
       <p data-testid="black" style="color:#000">Plain text</p>
       <p data-testid="large" style="color:#767676;font-size:24px">Large grey text</p>
       <p data-testid="bold-large" style="color:#949494;font-size:19px;font-weight:700">Bold large grey</p>
       <button data-testid="off" disabled style="color:#ccc;background:#ddd">Disabled</button>
       <div aria-disabled="true" role="button" tabindex="0" style="color:#ccc;background:#ddd"><span data-testid="off-span">Inactive</span></div>
     </main>`,
  );
  expectSame(result);
  expect(ofType(result.node, "low_contrast")).toEqual([]);
  // Only text below 4.5:1 is listed: the bold large text (3.03:1, which meets 3:1). The disabled ones are never measured.
  expect(result.body.contrast.element).toEqual([rowOf(result.body, "bold-large")]);
  expect(result.body.contrast).toMatchObject({ ratio: [3.03], font_px: [19], bold: [true] });
  expect(contrastUnknown(result.out)).toBe(0);
});

test("low_contrast: text on a gradient, an image, a positioned picture, under a filter or opacity is unknown, not reported", async ({ page }) => {
  const img = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
  const result = await scan(
    page,
    `<main style="padding:16px">
       <div style="background:linear-gradient(#fff,#eee)"><p style="color:#f0f0f0">On a gradient</p></div>
       <div style="background:#fff url('${img}')"><p style="color:#f0f0f0">On an image</p></div>
       <div style="position:relative;height:60px">
         <img src="${img}" style="position:absolute;inset:0;width:100%;height:100%" alt="">
         <p style="position:relative;color:#f0f0f0;margin:0">On a picture</p>
       </div>
       <p style="color:#f0f0f0;filter:contrast(2)">Under a filter</p>
       <p style="color:#f0f0f0;opacity:.9">Under opacity</p>
     </main>`,
  );
  expectSame(result);
  expect(ofType(result.node, "low_contrast")).toEqual([]);
  expect(contrastUnknown(result.out)).toBe(5);
});

test("low_contrast: a semi-transparent background is composited over the one below it", async ({ page }) => {
  const result = await scan(
    page,
    `<div style="background:rgba(0,0,0,.5);padding:8px"><p data-testid="half-white" style="color:#fff">White on 50% black over white</p></div>
     <div style="background:rgba(0,0,0,.5);padding:8px"><p data-testid="half-black" style="color:#000">Black on it</p></div>`,
  );
  expectSame(result);
  // rgba(0,0,0,.5) over white is rgb(127.5,127.5,127.5): white on it is 3.98:1, black on it 5.28:1 (which passes).
  const found = ofType(result.node, "low_contrast");
  expect(found.map((f) => f.subject?.test_id)).toEqual(["half-white"]);
  expect(Math.abs((found[0].evidence.contrast_ratio as number) - 3.98)).toBeLessThan(0.05);
  expect(contrastUnknown(result.out)).toBe(0);
});

test("maxContrastElements caps the text measured per snapshot; 0 turns contrast off", async ({ page }) => {
  const faint = '<p style="color:#bbb;margin:0">Faint</p>'.repeat(5);
  const capped = await scan(page, faint, { maxContrastElements: 2 });
  expect(capped.body.contrast.element).toHaveLength(2);
  expectSame(capped);
  const off = await scan(page, faint, { maxContrastElements: 0 });
  expect(off.body.contrast).toBeUndefined();
  expect(ofType(off.node, "low_contrast")).toEqual([]);
});

test("a11y checks left out of detect.checks are not measured: their tables are absent", async ({ page }) => {
  const html = '<p style="color:#bbb">Faint</p><button data-testid="icon"><svg width="16" height="16"></svg></button>';
  const neither = await scan(page, html, { detect: { checks: ["overlap", "spill"] } });
  expect(neither.body.contrast).toBeUndefined();
  expect(neither.body.unnamed_controls).toBeUndefined();
  expect(neither.browser).toEqual([]);
  const namesOnly = await scan(page, html, { detect: { checks: ["unnamed_control"] } });
  expect(namesOnly.body.contrast).toBeUndefined();
  expect(namesOnly.body.unnamed_controls.element).toHaveLength(1);
  expect(ofType(namesOnly.node, "unnamed_control")).toHaveLength(1);
  expectSame(namesOnly);
  const contrastOnly = await scan(page, html, { detect: { checks: ["low_contrast"] } });
  expect(contrastOnly.body.unnamed_controls).toBeUndefined();
  expect(contrastOnly.body.contrast.element).toHaveLength(1);
  expectSame(contrastOnly);
});

test("low_contrast: a dialog over its scrim is measured against the dialog; the page under the scrim is unknown", async ({ page }) => {
  const result = await scan(
    page,
    // Faint page text: overlapping layers are only looked for above text measuring below 4.5:1.
    `<p style="color:#ccc">Page text under the scrim</p>
     <p data-testid="clear-under" style="color:#000">Clear text under the scrim (meets 4.5:1, not looked at further)</p>
     <div style="position:fixed;inset:0;background:rgba(0,0,0,.4)"></div>
     <div role="dialog" style="position:fixed;top:100px;left:100px;width:300px;background:#fff;z-index:1"><p data-testid="dialog-text" style="color:#bbb">Dialog text</p></div>`,
  );
  expectSame(result);
  const found = ofType(result.node, "low_contrast");
  expect(found.map((f) => f.subject?.test_id)).toEqual(["dialog-text"]);
  expect(found[0].evidence.contrast_ratio).toBe(1.91);
  expect(contrastUnknown(result.out)).toBe(1);
});

test("low_contrast: a dark theme page with dim text is reported with theme_dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const result = await scan(
    page,
    `<style>:root{color-scheme:light dark}</style>
     <main style="padding:16px">
       <p data-testid="dim" style="color:#333">Dim text on the dark canvas</p>
       <p style="color:#eee">Readable text</p>
     </main>`,
  );
  expectSame(result);
  const found = ofType(result.node, "low_contrast");
  expect(found.map((f) => f.subject?.test_id)).toEqual(["dim"]);
  // #333 on the black canvas: 1.66:1.
  expect(found[0].evidence).toMatchObject({ contrast_ratio: 1.66, required_ratio: 4.5, theme_dark: true });
});

test("unnamed_control: an icon-only button without a name is reported; named controls are not", async ({ page }) => {
  const icon = `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 2h12v12H2z"/></svg>`;
  const result = await scan(
    page,
    `<main style="padding:16px;display:grid;gap:8px;width:300px">
       <button data-testid="icon">${icon}</button>
       <button data-testid="icon-titled" title=" ">${icon}</button>
       <button data-testid="icon-labelled" aria-label="Close">${icon}</button>
       <button data-testid="icon-sr">${icon}<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Close</span></button>
       <button data-testid="icon-svg-title"><svg width="16" height="16"><title>Close</title><path d="M2 2h12v12H2z"/></svg></button>
       <span id="name-source">Archive</span><button data-testid="by-id" aria-labelledby="name-source">${icon}</button>
       <a data-testid="img-link" href="#"><img alt="" width="16" height="16" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a>
       <a data-testid="img-alt-link" href="#"><img alt="Home" width="16" height="16" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a>
       <label for="email">Email</label><input data-testid="labelled" id="email">
       <label>Name <input data-testid="wrapped"></label>
       <input data-testid="bare">
       <input data-testid="placeholder" placeholder="Search">
       <input data-testid="submit" type="submit">
       <input data-testid="empty-button" type="button">
       <button data-testid="text">Save</button>
       <button data-testid="hidden" aria-hidden="true" tabindex="-1">${icon}</button>
     </main>`,
  );
  expectSame(result);
  const found = ofType(result.node, "unnamed_control");
  expect(found.map((f) => f.subject?.test_id).sort()).toEqual(["bare", "empty-button", "icon", "icon-titled", "img-link"]);
  const byId = Object.fromEntries(found.map((f) => [f.subject!.test_id, f]));
  expect(byId.icon.check).toBe("a11y.unnamed_control");
  expect(byId.icon.evidence).toMatchObject({ has_title: false, has_icon_only: true });
  expect(byId["icon-titled"].evidence).toMatchObject({ has_title: true, has_icon_only: true });
  expect(byId["img-link"].evidence).toMatchObject({ has_icon_only: true });
  expect(byId.bare.evidence).toMatchObject({ has_title: false, has_icon_only: false });
  expect(byId.icon.fingerprint).toBe(fp("unnamed_control", ["icon", null]));
});

// ---- Motion checks ----------------------------------------------------------------

const sentOf = async (page: Page, check: string) =>
  findingsOf(await output(page))
    .filter((e) => e.data.check === check)
    .map((e) => e.data);

/** Adds `on` to each element and resolves when every one has sent `type` (in page). */
const toggleAndWait = (page: Page, ids: string[], type: string) =>
  page.evaluate(
    ({ ids, type }) =>
      Promise.all(
        ids.map((id) => {
          const el = document.querySelector(`[data-testid="${id}"]`)!;
          const done = new Promise<void>((resolve) => el.addEventListener(type, () => resolve(), { once: true }));
          el.classList.add("on");
          return done;
        }),
      ),
    { ids, type },
  );

test("layout_animation: a width transition is reported, a transform transition is not", async ({ page }) => {
  await openPage(
    page,
    `<style>
      #grow{width:100px;height:40px;background:#36f;transition:width 300ms linear}
      #grow.on{width:200px}
      #slide{width:100px;height:40px;background:#f63;transition:transform 300ms linear}
      #slide.on{transform:translateX(100px)}
    </style>
    <div id="grow" data-testid="grow"></div><div id="slide" data-testid="slide"></div>`,
  );
  await init(page);
  await toggleAndWait(page, ["grow", "slide"], "transitionend");
  await expect.poll(async () => (await sentOf(page, "motion.layout_animation")).length).toBe(1);
  const out = await output(page);
  expectValid(out);
  const [found] = await sentOf(page, "motion.layout_animation");
  // Both runs were resolved in the same frame: the transform one is a negative, not a miss.
  expect(found.subject).toMatchObject({ test_id: "grow", stable_id: "grow", tag: "div", index: -1 });
  expect(found.fingerprint).toBe(fp("layout_animation", ["grow", null]));
  expect(found.evidence).toMatchObject({ duration_ms: 300, layout_props: 1, transition: true, infinite: false });
  // The box is read in the first frame of the transition: at least the starting 100 × 40.
  expect(found.evidence.element_area_px).toBeGreaterThanOrEqual(4000);
  expect(found.evidence.element_area_px).toBeLessThan(8000);
  expect(found.viewport_width).toBe(1280);
});

test("layout_animation: a keyframe animation on top is found from its keyframes", async ({ page }) => {
  await openPage(
    page,
    `<style>
      @keyframes drop{from{top:0}to{top:100px}}
      #drop{position:relative;width:80px;height:80px;background:#3a3}
      #drop.on{animation:drop 400ms ease-out 1}
    </style>
    <div id="drop" data-testid="drop"></div>`,
  );
  await init(page);
  await toggleAndWait(page, ["drop"], "animationend");
  await expect.poll(async () => (await sentOf(page, "motion.layout_animation")).length).toBe(1);
  const [found] = await sentOf(page, "motion.layout_animation");
  expect(found.subject.test_id).toBe("drop");
  expect(found.evidence).toMatchObject({ duration_ms: 400, layout_props: 1, transition: false });
});

test("stuck_animation: a 20 s animation still running after stuckAnimationMs; one that ends in 300 ms is not", async ({ page }) => {
  await openPage(
    page,
    `<style>
      @keyframes fade{from{transform:scale(1)}to{transform:scale(1.1)}}
      @keyframes grow{from{width:10px}to{width:60px}}
      .box{width:60px;height:60px;background:#888}
      #long.on{animation:fade 20s linear 1}
      #short.on{animation:fade 300ms linear 1}
      #probe.on{animation:grow 300ms linear 1}
    </style>
    <div class="box" id="long" data-testid="long"></div><div class="box" id="short" data-testid="short"></div>
    <div class="box" id="probe" data-testid="probe"></div>`,
  );
  await init(page, { detect: { stuckAnimationMs: 500 } });
  await toggleAndWait(page, ["long"], "animationstart");
  await toggleAndWait(page, ["short"], "animationend");
  await expect.poll(async () => (await sentOf(page, "motion.stuck_animation")).length, { timeout: 5000 }).toBe(1);
  const [found] = await sentOf(page, "motion.stuck_animation");
  expect(found.subject.test_id).toBe("long");
  expect(found.fingerprint).toBe(fp("stuck_animation", ["long", null]));
  expect(found.evidence).toMatchObject({ duration_ms: 20000, transition: false });
  expect(found.evidence.elapsed_ms).toBeGreaterThanOrEqual(500);
  // The short one ended before its deadline; its sweep came and went with the long one's.
  expect((await sentOf(page, "motion.stuck_animation")).map((f) => f.subject.test_id)).toEqual(["long"]);
});

test("offscreen_loop: infinite spinners under aria-hidden or display:none; a visible spinner is not", async ({ page }) => {
  await openPage(
    page,
    `<style>
      @keyframes spin{to{transform:rotate(360deg)}}
      .spin{width:24px;height:24px;border:3px solid #888;border-top-color:transparent;border-radius:50%;animation:spin 800ms linear infinite}
    </style>
    <div class="spin" data-testid="shown-spin"></div>
    <div aria-hidden="true"><div class="spin" data-testid="muted-spin"></div></div>
    <div style="display:none"><div id="gone" data-testid="gone-spin" style="width:24px;height:24px"></div></div>
    <script>
      // CSS animations do not run under display:none; a Web Animations API loop does.
      document.getElementById("gone").animate([{ transform: "rotate(0)" }, { transform: "rotate(360deg)" }], { duration: 800, iterations: Infinity });
    </script>`,
  );
  await init(page, { detect: { offscreenLoopMs: 300 } });
  await expect
    .poll(async () => (await sentOf(page, "motion.offscreen_loop")).map((f) => f.subject.test_id).sort(), { timeout: 5000 })
    .toEqual(["gone-spin", "muted-spin"]);
  const found = await sentOf(page, "motion.offscreen_loop");
  const muted = found.find((f) => f.subject.test_id === "muted-spin");
  const gone = found.find((f) => f.subject.test_id === "gone-spin");
  expect(muted.evidence).toMatchObject({ aria_hidden: true, zero_box: false });
  expect(gone.evidence).toMatchObject({ zero_box: true, aria_hidden: false });
  expect(muted.evidence.elapsed_ms).toBeGreaterThan(300);
  expect(muted.fingerprint).toBe(fp("offscreen_loop", ["muted-spin", null]));
  // All three loops are looked at in the same sweep: the visible one was looked at and passed.
  expect(found.map((f) => f.subject.test_id)).not.toContain("shown-spin");
  expectValid(await output(page));
});

test("offscreen_loop: a spinner that starts after init, then is hidden with visibility, is found on a later sweep", async ({ page }) => {
  await openPage(
    page,
    `<style>
      @keyframes spin{to{transform:rotate(360deg)}}
      #late{width:24px;height:24px;background:#888}
      #late.on{animation:spin 800ms linear infinite}
      #late.gone{visibility:hidden}
    </style>
    <div id="late" data-testid="late"></div>`,
  );
  await init(page, { detect: { offscreenLoopMs: 200 } });
  await toggleAndWait(page, ["late"], "animationstart");
  await page.evaluate(() => document.getElementById("late")!.classList.add("gone"));
  await expect.poll(async () => (await sentOf(page, "motion.offscreen_loop")).length, { timeout: 5000 }).toBe(1);
  const [found] = await sentOf(page, "motion.offscreen_loop");
  expect(found.evidence).toMatchObject({ visibility_hidden: true, zero_box: false, aria_hidden: false });
});

test("janky_animation: a long animation frame during a visible animation", async ({ page }) => {
  await openPage(
    page,
    `<style>
      @keyframes pulse{from{transform:scale(1)}to{transform:scale(1.2)}}
      #pulse{width:80px;height:80px;background:#c3c}
      #pulse.on{animation:pulse 600ms linear infinite alternate}
    </style>
    <div id="pulse" data-testid="pulse"></div>`,
  );
  const supported = await page.evaluate(() => PerformanceObserver.supportedEntryTypes.includes("long-animation-frame"));
  test.skip(!supported, "long-animation-frame is not reported by this browser");
  await init(page);
  await toggleAndWait(page, ["pulse"], "animationstart");
  // Block the main thread inside an animation frame for 200 ms.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          const end = performance.now() + 200;
          while (performance.now() < end) {}
          setTimeout(resolve, 0);
        }),
      ),
  );
  await expect.poll(async () => (await sentOf(page, "motion.janky_animation")).length, { timeout: 5000 }).toBe(1);
  const [found] = await sentOf(page, "motion.janky_animation");
  expect(found.subject.test_id).toBe("pulse");
  expect(found.evidence.long_frames).toBeGreaterThanOrEqual(1);
  expect(found.evidence.max_blocking_ms).toBeGreaterThan(50);
  expect(found.evidence).toMatchObject({ infinite: true });
});

const SLIDE_IN = `<style>
  #panel{position:fixed;left:0;top:0;width:600px;height:500px;background:#eee;transform:translateX(-100%);transition:transform 500ms ease-out}
  #panel.on{transform:none}
  #probe{width:40px;height:40px;background:#36f;transition:width 500ms}
  #probe.on{width:80px}
</style>
<div id="panel" data-testid="panel"></div><div id="probe" data-testid="probe"></div>`;

for (const reduce of [true, false]) {
  test(`reduced_motion_ignored: a large slide-in ${reduce ? "is reported with" : "is not reported without"} prefers-reduced-motion: reduce`, async ({ page }) => {
    if (reduce) await page.emulateMedia({ reducedMotion: "reduce" });
    await openPage(page, SLIDE_IN);
    await init(page);
    await toggleAndWait(page, ["panel", "probe"], "transitionend");
    // The probe's width transition was resolved in the same frame as the panel's.
    await expect.poll(async () => (await sentOf(page, "motion.layout_animation")).length).toBe(1);
    const found = await sentOf(page, "a11y.reduced_motion_ignored");
    if (!reduce) {
      expect(found).toEqual([]);
      return;
    }
    expect(found).toHaveLength(1);
    expect(found[0].subject.test_id).toBe("panel");
    expect(found[0].fingerprint).toBe(fp("reduced_motion_ignored", ["panel", null]));
    expect(found[0].evidence).toMatchObject({ duration_ms: 500, motion_props: 1, element_area_px: 300000, transition: true });
    expect(found[0].evidence.viewport_area_ratio).toBeCloseTo(300000 / (1280 * 800), 3);
  });
}

test("motion checks are switched off through the checks option", async ({ page }) => {
  await openPage(page, SLIDE_IN);
  await init(page, { detect: { checks: ["overlap", "reduced_motion_ignored"] } });
  await toggleAndWait(page, ["probe"], "transitionend");
  await idle(page);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect(await sentOf(page, "motion.layout_animation")).toEqual([]);
});

test("a thousand spinners: findings stay bounded", async ({ page }) => {
  const letters = (i: number) => String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26) % 26);
  const spinners = (n: number, ids: boolean) =>
    Array.from({ length: n }, (_, i) => `<i class="spin"${ids ? ` data-testid="s-${letters(i)}"` : ""}></i>`).join("");
  await openPage(
    page,
    `<style>
      @keyframes spin{to{transform:rotate(360deg)}}
      .spin{display:inline-block;width:8px;height:8px;background:#888}
      .go .spin{animation:spin 800ms linear infinite}
    </style>
    <div id="a">${spinners(250, false)}</div>
    <div id="b" aria-hidden="true">${spinners(250, false)}</div>
    <div id="c" aria-hidden="true">${spinners(500, true)}</div>`,
  );
  const { errors } = { errors: [] as string[] };
  page.on("pageerror", (e) => errors.push(e.message));
  await init(page, { detect: { offscreenLoopMs: 200 } });
  await page.evaluate(() => document.body.classList.add("go"));
  // 500 different hidden IDs, at most 50 findings per check per page session.
  await expect.poll(async () => (await sentOf(page, "motion.offscreen_loop")).length, { timeout: 15000 }).toBe(50);
  const found = await sentOf(page, "motion.offscreen_loop");
  expect(new Set(found.map((f) => f.fingerprint)).size).toBe(50);
  for (const f of found) expect(f.evidence.aria_hidden).toBe(true);
  expect(errors).toEqual([]);
  expectValid(await output(page));
});

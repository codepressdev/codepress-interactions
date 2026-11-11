import { buildSync } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { events, expectValid, init, openPage, output, type Output } from "./harness";

const hovers = (out: Output) => events(out).filter((e) => e.type === "ui.hover.settled");
const findings = (out: Output) => events(out).filter((e) => e.type === "ui.finding");
const silent = (out: Output, key: "hovers_silent" | "focus_silent") =>
  events(out)
    .filter((e) => e.type === "perf.summary")
    .reduce((sum, e) => sum + (e.data[key] ?? 0), 0);

// A button whose tooltip is added on mouseenter (and on focus) inside an
// overflow:hidden card, so the tooltip spills out of it.
const TOOLTIP = `
<div data-testid="card" style="position:relative;width:240px;height:120px;overflow:hidden;margin:40px">
  <button data-testid="info" id="info" style="position:absolute;left:10px;top:10px;width:80px;height:32px">Info</button>
</div>
<div data-testid="plain" id="plain" style="cursor:pointer;width:200px;height:60px;margin:40px;background:#eee"></div>
<div id="away" style="height:200px"></div>
<script>
  const info = document.getElementById("info");
  const show = () => {
    if (document.getElementById("tip")) return;
    const tip = document.createElement("div");
    tip.id = "tip";
    tip.setAttribute("role", "tooltip");
    tip.dataset.testid = "tip";
    tip.style.cssText = "position:absolute;left:150px;top:10px;width:200px;height:30px;background:#333;color:#fff";
    tip.textContent = "More about this";
    info.parentElement.append(tip);
  };
  const hide = () => document.getElementById("tip")?.remove();
  info.addEventListener("mouseenter", show);
  info.addEventListener("mouseleave", hide);
  info.addEventListener("focus", show);
  info.addEventListener("blur", hide);
</script>`;

async function centerOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = (await page.locator(selector).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function rest(page: Page, selector: string, ms: number): Promise<void> {
  const { x, y } = await centerOf(page, selector);
  await page.mouse.move(x, y);
  await page.waitForTimeout(ms);
}

test("a mouse resting 200 ms on a button that shows a tooltip records one hover with a hover snapshot whose checks run", async ({ page }) => {
  await openPage(page, TOOLTIP);
  await init(page, { hoverSettleMs: 200 });
  await page.mouse.move(5, 790);
  await rest(page, "#info", 200);
  await expect.poll(async () => hovers(await output(page)).length).toBe(1);
  // The tooltip snapshot's layout checks run in idle time.
  await expect.poll(async () => findings(await output(page)).some((e) => e.data.check === "layout.spill")).toBe(true);
  const out = await output(page);
  expectValid(out);
  const [hover] = hovers(out);
  expect(hover.attribution).toBe("unknown");
  expect(hover.interaction_id).toBeNull();
  expect(hover.data).toMatchObject({
    kind: "pointer",
    control_id: "info",
    route_template: "/",
    overlay_opened: true,
    nodes_added: true,
    has_hover_handler: null,
  });
  expect(hover.data.dwell_ms).toBeGreaterThanOrEqual(140);
  expect(hover.data.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
  const snapshot = events(out).find((e) => e.type === "ui.snapshot" && e.data.sha256 === hover.data.snapshot_sha256);
  expect(snapshot.data.trigger).toBe("hover");
  // The tooltip is in the hover snapshot, and the spill check found it leaving the card.
  const body = out.snapshots.find((s) => s.sha256 === hover.data.snapshot_sha256)!.body;
  expect(body.dictionaries.test_id).toContain("tip");
  const spill = findings(out).find((e) => e.data.check === "layout.spill" && e.data.snapshot_sha256 === hover.data.snapshot_sha256);
  expect(spill.data.subject.test_id).toBe("tip");
  expect(spill.data.other.test_id).toBe("card");
  // Resting on it again within 30 s records nothing more.
  await page.mouse.move(5, 790);
  await rest(page, "#info", 500);
  expect(hovers(await output(page))).toHaveLength(1);
});

test("a mouse passing over a control in 50 ms records nothing", async ({ page }) => {
  await openPage(page, TOOLTIP);
  await init(page, { hoverSettleMs: 200 });
  await page.mouse.move(5, 790);
  await rest(page, "#info", 50);
  await page.mouse.move(5, 790);
  await rest(page, "#plain", 50);
  await page.mouse.move(5, 790);
  await page.waitForTimeout(500);
  const out = await output(page);
  expect(hovers(out)).toHaveLength(0);
  expect(silent(out, "hovers_silent")).toBe(0);
  expect(out.snapshots).toHaveLength(0);
});

test("hovering a plain pointer-cursor div that reacts to nothing sends no event and counts a silent hover", async ({ page }) => {
  await openPage(page, TOOLTIP);
  await init(page, { hoverSettleMs: 200 });
  await page.mouse.move(5, 790);
  await rest(page, "#plain", 500);
  await page.mouse.move(5, 790);
  const out = await output(page);
  expectValid(out);
  expect(hovers(out)).toHaveLength(0);
  expect(silent(out, "hovers_silent")).toBe(1);
  expect(silent(out, "focus_silent")).toBe(0);
});

test.describe("touch", () => {
  test.use({ hasTouch: true });

  test("a touch tap is not a hover", async ({ page }) => {
    await openPage(page, TOOLTIP);
    await init(page, { hoverSettleMs: 200 });
    await page.tap("#info");
    await page.tap("#plain");
    await page.waitForTimeout(600);
    const out = await output(page);
    expectValid(out);
    // The tap is a click; it is never followed as a hover.
    expect(events(out).some((e) => e.type === "ui.click.settled")).toBe(true);
    expect(hovers(out)).toHaveLength(0);
    expect(silent(out, "hovers_silent")).toBe(0);
  });
});

const here = dirname(fileURLToPath(import.meta.url));
/** A tiny React app: a button with onMouseEnter that shows a tooltip, next to a plain DOM button. */
const reactApp = buildSync({
  stdin: {
    contents: `
      import { createElement as h, useState } from "react";
      import { createRoot } from "react-dom/client";
      function App() {
        const [open, setOpen] = useState(false);
        return h("div", null,
          h("button", { "data-testid": "react-info", style: { margin: "40px" }, onMouseEnter: () => setOpen(true), onMouseLeave: () => setOpen(false) }, "Info"),
          open ? h("div", { role: "tooltip", "data-testid": "react-tip" }, "More") : null,
          h("div", { style: { height: "200px" } }),
        );
      }
      createRoot(document.getElementById("app")).render(h(App));
    `,
    resolveDir: resolve(here, "../.."),
    loader: "js",
  },
  bundle: true,
  format: "iife",
  target: "es2022",
  define: { "process.env.NODE_ENV": '"production"' },
  write: false,
}).outputFiles[0].text;

test("a React onMouseEnter handler is reported; plain DOM reports null", async ({ page }) => {
  await openPage(page, `<div id="app"></div>${TOOLTIP}<script>${reactApp}</script>`);
  await expect(page.getByTestId("react-info")).toBeVisible();
  await init(page, { hoverSettleMs: 200 });
  await page.mouse.move(5, 5);
  await rest(page, '[data-testid="react-info"]', 200);
  await expect.poll(async () => hovers(await output(page)).length).toBe(1);
  await page.mouse.move(5, 5);
  await rest(page, "#info", 200);
  await expect.poll(async () => hovers(await output(page)).length).toBe(2);
  const out = await output(page);
  expectValid(out);
  const [react, plain] = hovers(out);
  expect(react.data).toMatchObject({ control_id: "react-info", has_hover_handler: true, overlay_opened: true });
  expect(plain.data).toMatchObject({ control_id: "info", has_hover_handler: null, overlay_opened: true });
});

const FOCUS = `
<button data-testid="bare" style="outline:none">Bare</button>
<button data-testid="ringed">Ringed</button>
<span data-testid="wrapped" class="wrap"><button data-testid="inner" style="outline:none">Inner</button></span>
<button data-testid="last">Last</button>
<style>.wrap:focus-within { box-shadow: 0 0 0 2px blue; }</style>`;

test("tabbing to a button with outline:none and no other change is a no-focus-indicator finding; a focus ring is not", async ({ page }) => {
  await openPage(page, FOCUS);
  await init(page, { hoverSettleMs: 100 });
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(300);
  const out = await output(page);
  expectValid(out);
  const found = findings(out).filter((e) => e.data.check === "a11y.no_focus_indicator");
  expect(found.map((e) => e.data.control_id)).toEqual(["bare"]);
  expect(found[0].data).toMatchObject({ subject: null, other: null, route_template: "/" });
  expect(found[0].data.evidence).toMatchObject({ kind_focus: true, indicator_changed: false, wrappers_compared: 0, structural_id: false });
  // None of these focuses changed anything else: each is counted silent.
  expect(silent(out, "focus_silent")).toBe(4);
  expect(hovers(out)).toHaveLength(0);
});

test("keyboard focus that opens a tooltip records a focus hover with a focus snapshot", async ({ page }) => {
  await openPage(page, TOOLTIP);
  await init(page, { hoverSettleMs: 200 });
  await page.keyboard.press("Tab");
  await expect.poll(async () => hovers(await output(page)).length).toBe(1);
  const out = await output(page);
  expectValid(out);
  const [focus] = hovers(out);
  expect(focus.data).toMatchObject({ kind: "focus", control_id: "info", dwell_ms: 0, overlay_opened: true });
  const snapshot = events(out).find((e) => e.type === "ui.snapshot" && e.data.sha256 === focus.data.snapshot_sha256);
  expect(snapshot.data.trigger).toBe("focus");
});

test("a testId hook that replaces the element under a resting pointer is called once, not in a loop", async ({ page }) => {
  // Away from the origin: Chromium on Linux can start the mouse at (0, 0) and report it over an element there.
  await openPage(page, `<button data-testid="save-button" style="width:200px;height:60px;margin:100px">Go</button>`);
  await page.evaluate(() => {
    const w = window as any;
    w.calls = 0;
    w.handle = w.CodepressInteractions.initInteractions({
      sink: w.sink,
      flushIntervalMs: 3_600_000,
      routeSettleMs: 3_600_000,
      testId: (value: string, element: Element) => {
        w.calls++;
        const clone = element.cloneNode(true) as Element;
        clone.setAttribute("aria-busy", "true");
        element.replaceWith(clone);
        return value;
      },
    });
  });
  await page.mouse.move(400, 400);
  await page.mouse.move(150, 130);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => (window as any).calls)).toBeLessThanOrEqual(2);
});

test("hovers: false turns hover and focus following off", async ({ page }) => {
  await openPage(page, TOOLTIP);
  await init(page, { hoverSettleMs: 200, hovers: false });
  await page.mouse.move(5, 790);
  await rest(page, "#info", 500);
  await page.keyboard.press("Tab");
  await page.waitForTimeout(400);
  const out = await output(page);
  expect(hovers(out)).toHaveLength(0);
  expect(silent(out, "hovers_silent") + silent(out, "focus_silent")).toBe(0);
  // Summaries look exactly as before 1.2.0: the two counts are absent, not 0.
  // The first snapshot always sends a summary (which signals the browser has).
  await page.evaluate(() => (window as any).handle.snapshot());
  await expect.poll(async () => events(await output(page)).filter((e) => e.type === "perf.summary").length).toBeGreaterThan(0);
  const summaries = events(await output(page)).filter((e) => e.type === "perf.summary");
  for (const summary of summaries) {
    expect(summary.data).not.toHaveProperty("hovers_silent");
    expect(summary.data).not.toHaveProperty("focus_silent");
  }
  expect(await page.evaluate(() => (window as any).handle.getDiagnostics().adapters)).not.toContain("hover_effects");
});

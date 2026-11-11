import { expect, test, type Page } from "@playwright/test";
import {
  captureSnapshot,
  expectNoFindings,
  expectNoSweepFindings,
  findIssues,
  formatFinding,
  sweepInteractions,
} from "../src/index";

const BROKEN = `
<header style="position:relative;height:60px;padding:8px">
  <button data-testid="checkout" style="position:absolute;left:8px;top:8px;width:160px;height:40px">Checkout</button>
  <span data-testid="promo" style="position:absolute;left:40px;top:12px;width:110px;height:32px;background:gold">20% off</span>
</header>
<div data-testid="card" style="width:200px;height:80px;overflow:hidden">
  <div data-testid="price-row" style="width:320px;height:20px">Price</div>
</div>`;

// The same page, fixed: the promo sits beside the button and the row fits its card.
const FIXED = `
<header style="position:relative;height:60px;padding:8px">
  <button data-testid="checkout" style="position:absolute;left:8px;top:8px;width:160px;height:40px">Checkout</button>
  <span data-testid="promo" style="position:absolute;left:180px;top:12px;width:110px;height:32px;background:gold">20% off</span>
</header>
<div data-testid="card" style="width:200px;height:80px;overflow:hidden">
  <div data-testid="price-row" style="width:200px;height:20px">Price</div>
</div>`;

async function serve(page: Page, html: string, path = "/shop/42") {
  await page.route("https://shop.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px/1.25 sans-serif}</style></head><body>${html}</body></html>`,
    }),
  );
  await page.goto(`https://shop.test${path}`);
}

test("captureSnapshot walks the page in one pass", async ({ page }) => {
  await serve(page, BROKEN);
  const { body, sha256 } = await captureSnapshot(page, { routeSegments: ["shop"] });
  expect(body.torn).toBe(false);
  expect(body.truncated).toBe(false);
  expect(body.route_template).toBe("/shop/:id");
  expect(body.dictionaries.test_id).toEqual(expect.arrayContaining(["checkout", "promo", "card", "price-row"]));
  expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  // Injecting twice reuses the walker.
  expect((await captureSnapshot(page, { routeSegments: ["shop"] })).sha256).toBe(sha256);
  // Without allowed segments every segment is collapsed, as in the SDK.
  expect((await captureSnapshot(page)).body.route_template).toBe("/:id/:id");
});

test("findIssues lists findings, blocked control first", async ({ page }) => {
  await serve(page, BROKEN);
  const findings = await findIssues(page, { routeSegments: ["shop"] });
  expect(findings.map((f) => [f.check, f.subject?.test_id, f.other?.test_id])).toEqual([
    ["layout.overlap", "checkout", "promo"],
    ["layout.spill", "price-row", "card"],
  ]);
  expect(findings[0].evidence.subject_blocked_points).toBeGreaterThan(0);
  expect(findings[0].route_template).toBe("/shop/:id");
  const only = await findIssues(page, { checks: ["spill"] });
  expect(only.map((f) => f.check)).toEqual(["layout.spill"]);
  const accepted = await findIssues(page, { routeSegments: ["shop"], ignoreFingerprints: [findings[0].fingerprint] });
  expect(accepted.map((f) => f.check)).toEqual(["layout.spill"]);
  const scoped = await findIssues(page, { root: '[data-testid="card"]' });
  expect(scoped.map((f) => f.check)).toEqual(["layout.spill"]);
  const ignored = await findIssues(page, { ignore: '[data-testid="promo"], [data-testid="price-row"]' });
  expect(ignored).toEqual([]);
});

test("expectNoFindings fails with a readable message on the broken page", async ({ page }) => {
  await serve(page, BROKEN);
  let message = "";
  try {
    await expectNoFindings(page, { routeSegments: ["shop"] });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain("2 UI findings on /shop/42");
  expect(message).toContain("layout.overlap checkout × promo on /shop/:id @1280x800:");
  expect(message).toContain("subject_blocked_points=");
  expect(message).toContain("layout.spill price-row × card");
  expect(message).toContain("ignoreFingerprints");
});

test("expectNoFindings passes on the fixed page", async ({ page }) => {
  await serve(page, FIXED);
  await expectNoFindings(page);
});

test("route and thresholds are options", async ({ page }) => {
  await serve(page, BROKEN);
  const [first] = await findIssues(page, { route: "/shop/:product" });
  expect(first.route_template).toBe("/shop/:product");
  const tolerant = await findIssues(page, { tolerancePx: 200, checks: ["spill"] });
  expect(tolerant).toEqual([]);
});

test("captureSnapshot records the page's color scheme, or the theme it is given", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await serve(page, FIXED);
  expect((await captureSnapshot(page)).body.viewport.theme).toBe("dark");
  await page.emulateMedia({ colorScheme: "light" });
  expect((await captureSnapshot(page)).body.viewport.theme).toBe("light");
  expect((await captureSnapshot(page, { theme: "dark" })).body.viewport.theme).toBe("dark");
});

test("captureSnapshot drops data-bearing test IDs by default, and a testId hook replaces the rule", async ({ page }) => {
  await serve(
    page,
    `<button data-testid="item-42">A</button><button data-testid="domain-row-acme.com">B</button><button data-testid="save-button">C</button>`,
  );
  expect((await captureSnapshot(page)).body.dictionaries.test_id).toEqual(["save-button"]);
  const kept = await captureSnapshot(page, { testId: (value) => value });
  expect(kept.body.dictionaries.test_id).toEqual(["item-42", "domain-row-acme.com", "save-button"]);
  // The hook runs in the page and gets the element.
  const mapped = await captureSnapshot(page, {
    testId(value, element) {
      return element.tagName === "BUTTON" && value.startsWith("item-") ? "item" : null;
    },
  });
  expect(mapped.body.dictionaries.test_id).toEqual(["item"]);
  const none = await captureSnapshot(page, { testId: () => null });
  expect(none.body.dictionaries.test_id).toEqual([]);
});

test("a testId hook can call the default in the page, and gets the same result as the SDK rule", async ({ page }) => {
  await serve(page, `<button data-testid="order-row-7">A</button><button data-testid="item-42">B</button><button data-testid="save-button">C</button>`);
  const { body } = await captureSnapshot(page, {
    testId: (value) =>
      value.startsWith("order-row-")
        ? "order-row"
        : (globalThis as any).__codepressInteractions.defaultTestIdFilter(value),
  });
  expect(body.dictionaries.test_id).toEqual(["order-row", "save-button"]);
});

test("a testId hook that is not self-contained fails the capture instead of dropping every ID", async ({ page }) => {
  await serve(page, `<button data-testid="save-button">A</button>`);
  const allowed = new Set(["save-button"]);
  await expect(captureSnapshot(page, { testId: (value) => (allowed.has(value) ? value : null) })).rejects.toThrow(
    /must be self-contained.*allowed/,
  );
  // The walker stays usable, and a hook that throws for its own reasons only drops the ID.
  const dropped = await captureSnapshot(page, {
    testId: () => {
      throw new Error("not this one");
    },
  });
  expect(dropped.body.dictionaries.test_id).toEqual([]);
});

test("a bound or native testId function fails with a clear error", async ({ page }) => {
  await serve(page, `<button data-testid="save-button">A</button>`);
  const bound = ((value: string) => value).bind(null);
  await expect(captureSnapshot(page, { testId: bound })).rejects.toThrow(/self-contained function/);
  await expect(
    captureSnapshot(page, { testId: String.prototype.trim as unknown as (value: string) => string }),
  ).rejects.toThrow(/self-contained function/);
});

// ---- Hover and focus sweep ------------------------------------------------

// A CSS-only tooltip shown on :hover only, and the same tooltip also shown on :focus-visible.
const TOOLTIP_CSS = `
<style>
  .tip-wrap { position: relative; display: inline-block; margin: 40px }
  .tip { position: absolute; left: 0; top: 44px; width: 160px; padding: 4px; background: #222; color: #fff; visibility: hidden }
  .hover-only:hover + .tip { visibility: visible }
  .both:hover + .tip, .both:focus-visible + .tip { visibility: visible }
</style>`;
const HOVER_ONLY = `${TOOLTIP_CSS}
<span class="tip-wrap"><button data-testid="help" class="hover-only">Help</button><span class="tip">Opens the guide</span></span>`;
const HOVER_AND_FOCUS = `${TOOLTIP_CSS}
<span class="tip-wrap"><button data-testid="help" class="both">Help</button><span class="tip">Opens the guide</span></span>`;

// A navigation bar whose submenu opens on hover (and focus-within) and spills
// out of the bar's clipped box, past the right edge of the screen.
const SPILLING_MENU = `
<style>
  nav { position: relative; height: 48px; overflow: hidden; background: #eee }
  .item { position: absolute; right: 8px; top: 8px }
  .menu { display: none; position: absolute; left: 0; top: 36px; width: 320px; background: #fff; border: 1px solid #999 }
  .item:hover .menu, .item:focus-within .menu { display: block }
  .menu a { display: block; height: 28px }
</style>
<nav data-testid="topnav">
  <div class="item" data-testid="account-item">
    <button data-testid="account">Account</button>
    <div class="menu" data-testid="account-menu"><a href="#a" data-testid="profile">Profile</a><a href="#b" data-testid="sign-out">Sign out</a></div>
  </div>
</nav>`;

// Hover effects that keyboard users get too, and nothing broken.
const CLEAN = `
${TOOLTIP_CSS}
<style>
  .menu-wrap { position: relative; margin: 40px }
  .menu { display: none; position: absolute; left: 0; top: 36px; width: 160px; background: #fff; border: 1px solid #999; z-index: 1 }
  .menu-wrap:hover .menu, .menu-wrap:focus-within .menu { display: block }
  .menu a { display: block; height: 28px }
  a.link:hover, a.link:focus-visible { text-decoration: underline; outline: 2px solid blue }
</style>
<span class="tip-wrap"><button data-testid="help" class="both">Help</button><span class="tip">Opens the guide</span></span>
<p style="margin:40px"><a class="link" href="#z" data-testid="docs">Docs</a> <input data-testid="search" aria-label="Search" style="width:160px"></p>
<div class="menu-wrap"><button data-testid="more">More</button><div class="menu"><a href="#x" data-testid="first">First</a><a href="#y" data-testid="second">Second</a></div></div>`;

test("sweep: a CSS-only :hover tooltip is hover-only content", async ({ page }) => {
  await serve(page, HOVER_ONLY);
  // At rest the page is clean.
  expect(await findIssues(page)).toEqual([]);
  const result = await sweepInteractions(page, { routeSegments: ["shop"] });
  expect(result.controls).toBe(1);
  expect(result.skipped).toBe(0);
  const hoverOnly = result.findings.filter((f) => f.check === "a11y.hover_only_content");
  expect(hoverOnly).toHaveLength(1);
  expect(hoverOnly[0]).toMatchObject({
    type: "hover_only_content",
    control_id: "help",
    route_template: "/shop/:id",
    viewport_width: 1280,
    viewport_height: 800,
    subject: null,
    evidence: { hover_overlay: true, focus_overlay: false, focus_reached: true, structural_id: false },
  });
  expect(hoverOnly[0].snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(formatFinding(hoverOnly[0])).toContain("a11y.hover_only_content help on /shop/:id @1280x800: hover_overlay focus_reached");
});

test("sweep: the same tooltip also shown on :focus-visible is not reported", async ({ page }) => {
  await serve(page, HOVER_AND_FOCUS);
  const result = await sweepInteractions(page);
  expect(result).toEqual({ findings: [], controls: 1, skipped: 0 });
});

test("sweep: a tooltip added by a mouseenter handler only is hover-only; one added on focus too is not", async ({ page }) => {
  const control = (id: string, focus: boolean) => `
<div style="position:relative;margin:40px"><button data-testid="${id}" id="${id}">${id}</button></div>
<script>
  (() => {
    const button = document.getElementById("${id}");
    const show = () => {
      if (button.parentElement.querySelector("[role=tooltip]")) return;
      const tip = document.createElement("div");
      tip.setAttribute("role", "tooltip");
      tip.style.cssText = "position:absolute;left:0;top:30px;width:120px;background:#333;color:#fff";
      tip.textContent = "Details";
      button.parentElement.append(tip);
    };
    const hide = () => button.parentElement.querySelector("[role=tooltip]")?.remove();
    button.addEventListener("mouseenter", show);
    button.addEventListener("mouseleave", hide);
    ${focus ? 'button.addEventListener("focus", show); button.addEventListener("blur", hide);' : ""}
  })();
</script>`;
  await serve(page, control("mouse-only", false) + control("both-ways", true));
  const result = await sweepInteractions(page);
  expect(result.controls).toBe(2);
  expect(result.findings.map((f) => [f.check, f.control_id])).toEqual([["a11y.hover_only_content", "mouse-only"]]);
});

test("sweep: hover content on an element keyboard focus cannot reach is reported with focus_reached false", async ({ page }) => {
  await serve(
    page,
    `${TOOLTIP_CSS}<style>.card:hover + .tip { visibility: visible }</style>
<span class="tip-wrap"><span role="button" class="card" data-testid="card-button">Card</span><span class="tip">Hidden extra</span></span>`,
  );
  const [finding, ...rest] = (await sweepInteractions(page)).findings;
  expect(rest).toEqual([]);
  expect(finding.check).toBe("a11y.hover_only_content");
  expect(finding.evidence).toMatchObject({ hover_overlay: true, focus_overlay: false, focus_reached: false });
});

test("sweep: a toast shown on a timer during a hover is not hover-only content of that control", async ({ page }) => {
  // The toast is unrelated to the button: a fixed layer added to the body
  // elsewhere on the page 50 ms after the pointer first reaches the button,
  // and left showing.
  await serve(
    page,
    `${TOOLTIP_CSS}
<span class="tip-wrap"><button data-testid="help" class="both">Help</button><span class="tip">Opens the guide</span></span>
<script>
  document.addEventListener("pointerover", (event) => {
    if (!event.target.closest?.("button") || document.getElementById("toast")) return;
    setTimeout(() => {
      const toast = document.createElement("div");
      toast.id = "toast";
      toast.setAttribute("role", "alert");
      toast.style.cssText = "position:fixed;right:16px;bottom:16px;width:240px;padding:8px;background:#333;color:#fff";
      toast.textContent = "Saved";
      document.body.append(toast);
    }, 50);
  });
</script>`,
  );
  const result = await sweepInteractions(page);
  expect(await page.locator("#toast").isVisible()).toBe(true);
  expect(result).toEqual({ findings: [], controls: 1, skipped: 0 });
});

test("sweep: a layer far from the control, not inside its parent or referenced by it, is not the control's", async ({ page }) => {
  // A status line in the page corner, shown on every hover of the button.
  await serve(
    page,
    `<div style="margin:40px"><button data-testid="save" id="save">Save</button></div>
<script>
  const button = document.getElementById("save");
  button.addEventListener("mouseenter", () => {
    const status = document.createElement("div");
    status.id = "status";
    status.style.cssText = "position:fixed;right:16px;bottom:16px;width:240px;background:#333;color:#fff";
    status.textContent = "Ctrl+S saves";
    document.body.append(status);
  });
  button.addEventListener("mouseleave", () => document.getElementById("status")?.remove());
</script>`,
  );
  expect(await sweepInteractions(page)).toEqual({ findings: [], controls: 1, skipped: 0 });
});

test("sweep: a layer the control shows on its first hover only is not reported (the hover is repeated)", async ({ page }) => {
  await serve(
    page,
    `<div style="position:relative;margin:40px"><button data-testid="hint" id="hint">New</button></div>
<script>
  const button = document.getElementById("hint");
  let shown = false;
  button.addEventListener("mouseenter", () => {
    if (shown) return;
    shown = true;
    const tip = document.createElement("div");
    tip.setAttribute("role", "tooltip");
    tip.style.cssText = "position:absolute;left:0;top:30px;width:120px;background:#333;color:#fff";
    tip.textContent = "Try this";
    button.parentElement.append(tip);
  });
  button.addEventListener("mouseleave", () => button.parentElement.querySelector("[role=tooltip]")?.remove());
</script>`,
  );
  expect(await sweepInteractions(page)).toEqual({ findings: [], controls: 1, skipped: 0 });
});

test("sweep: a tooltip portaled to the body and referenced by aria-describedby counts as the control's", async ({ page }) => {
  await serve(
    page,
    `<div style="margin:200px 40px"><button data-testid="share" id="share" aria-describedby="share-tip">Share</button></div>
<script>
  const button = document.getElementById("share");
  button.addEventListener("mouseenter", () => {
    const tip = document.createElement("div");
    tip.id = "share-tip";
    tip.style.cssText = "position:absolute;left:600px;top:40px;width:120px;background:#333;color:#fff";
    tip.textContent = "Copy a link";
    document.body.append(tip);
  });
  button.addEventListener("mouseleave", () => document.getElementById("share-tip")?.remove());
</script>`,
  );
  const { findings } = await sweepInteractions(page);
  expect(findings.map((f) => [f.check, f.control_id])).toEqual([["a11y.hover_only_content", "share"]]);
});

test("sweep: a large parent does not use up the scan before a portaled, referenced tooltip is reached", async ({ page }) => {
  await serve(
    page,
    `<div style="margin:200px 40px"><button data-testid="share" id="share" aria-describedby="share-tip">Share</button><div id="rows" hidden></div></div>
<script>
  // More descendants than the sweep inspects per state, all in the button's parent.
  document.getElementById("rows").innerHTML = "<span></span>".repeat(2500);
  const button = document.getElementById("share");
  button.addEventListener("mouseenter", () => {
    const tip = document.createElement("div");
    tip.id = "share-tip";
    tip.style.cssText = "position:absolute;left:600px;top:40px;width:120px;background:#333;color:#fff";
    tip.textContent = "Copy a link";
    document.body.append(tip);
  });
  button.addEventListener("mouseleave", () => document.getElementById("share-tip")?.remove());
</script>`,
  );
  const { findings } = await sweepInteractions(page);
  expect(findings.map((f) => [f.check, f.control_id])).toEqual([["a11y.hover_only_content", "share"]]);
});

test("sweep: a hover menu that spills out of its bar and off screen is found by the sweep, not at rest", async ({ page }) => {
  await serve(page, SPILLING_MENU);
  expect(await findIssues(page)).toEqual([]);
  const result = await sweepInteractions(page);
  // The menu's links are hidden at rest, so only the button is visited.
  expect(result.controls).toBe(1);
  const spill = result.findings.find((f) => f.check === "layout.spill" && f.subject?.test_id === "account-menu");
  expect(spill, result.findings.map(formatFinding).join("\n")).toBeTruthy();
  expect(spill!.other?.test_id).toBe("topnav");
  // Focus opens the menu too (focus-within), so it is not hover-only.
  expect(result.findings.some((f) => f.check === "a11y.hover_only_content")).toBe(false);
});

test("sweep: maxControls caps the controls visited and skipped counts the rest", async ({ page }) => {
  const buttons = Array.from({ length: 6 }, (_, i) => `<button data-testid="b-${"abcdef"[i]}" style="margin:8px">B</button>`).join("");
  await serve(page, `${buttons}<button disabled>Off</button><button style="display:none">Gone</button>`);
  const capped = await sweepInteractions(page, { maxControls: 2 });
  expect(capped).toEqual({ findings: [], controls: 2, skipped: 4 });
  const none = await sweepInteractions(page, { maxControls: 0 });
  expect(none).toEqual({ findings: [], controls: 0, skipped: 6 });
  // Hover only, scoped to a root.
  await serve(page, `<div id="a">${buttons}</div><div id="b"><button>One</button></div>`);
  expect(await sweepInteractions(page, { root: "#b", focus: false })).toEqual({ findings: [], controls: 1, skipped: 0 });
});

test("sweep: a clean page has no findings", async ({ page }) => {
  await serve(page, CLEAN);
  const result = await sweepInteractions(page);
  // help, docs, search and more; the menu links are hidden until hovered.
  expect(result).toEqual({ findings: [], controls: 4, skipped: 0 });
  await expectNoSweepFindings(page);
});

test("sweep: findings seen at rest and while hovering are each reported once", async ({ page }) => {
  await serve(page, BROKEN + HOVER_ONLY);
  const result = await sweepInteractions(page, { routeSegments: ["shop"] });
  expect(result.findings.map((f) => f.check).sort()).toEqual(["a11y.hover_only_content", "layout.overlap", "layout.spill"]);
  // Ignored fingerprints and checks narrow the result.
  const hoverOnly = result.findings.find((f) => f.check === "a11y.hover_only_content")!;
  const accepted = await sweepInteractions(page, { routeSegments: ["shop"], ignoreFingerprints: [hoverOnly.fingerprint] });
  expect(accepted.findings.map((f) => f.check).sort()).toEqual(["layout.overlap", "layout.spill"]);
  const onlyOverlap = await sweepInteractions(page, { checks: ["overlap"] });
  expect(onlyOverlap.findings.map((f) => f.check)).toEqual(["layout.overlap"]);
  // Hover off: nothing to compare, so no hover-only finding.
  const focusOnly = await sweepInteractions(page, { hover: false, checks: ["hover_only_content"] });
  expect(focusOnly.findings).toEqual([]);
});

test("expectNoSweepFindings fails with one line per finding", async ({ page }) => {
  await serve(page, HOVER_ONLY);
  let message = "";
  try {
    await expectNoSweepFindings(page);
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain("1 UI finding on /shop/42 after hovering and focusing 1 control");
  expect(message).toContain("a11y.hover_only_content help on /:id/:id @1280x800: hover_overlay focus_reached");
  expect(message).toContain("ignoreFingerprints");
  const { findings } = await sweepInteractions(page);
  await expectNoSweepFindings(page, { ignoreFingerprints: findings.map((f) => f.fingerprint) });
});

test("sweep: a tooltip that fades in with a CSS transition on hover only is hover-only content; one that also fades in on focus is not", async ({ page }) => {
  const FADE = `
<style>
  .tip-wrap { position: relative; display: inline-block; margin: 40px }
  .tip { position: absolute; left: 0; top: 44px; width: 160px; padding: 4px; background: #222; color: #fff;
         visibility: hidden; opacity: 0; transform: translateY(-6px); transition: opacity 400ms, transform 400ms, visibility 400ms }
  .hover-only:hover + .tip, .both:hover + .tip, .both:focus-visible + .tip { visibility: visible; opacity: 1; transform: none }
</style>
<span class="tip-wrap"><button data-testid="fade-hover" class="hover-only">Hover</button><span class="tip">Opens the guide</span></span>
<span class="tip-wrap"><button data-testid="fade-both" class="both">Both</button><span class="tip">Opens the guide</span></span>`;
  await serve(page, FADE);
  // The page counts the transitions it starts, so the test knows the hover and focus ran them.
  await page.evaluate(() => {
    (window as any).__runs = 0;
    document.addEventListener("transitionrun", () => (window as any).__runs++, true);
  });
  const result = await sweepInteractions(page);
  expect(await page.evaluate(() => (window as any).__runs)).toBeGreaterThan(0);
  expect(result.controls).toBe(2);
  expect(result.findings.filter((f) => f.check === "a11y.hover_only_content").map((f) => f.control_id)).toEqual(["fade-hover"]);
});

test("sweep: a hover whose only sign of life within the settle time is a transition starting is followed until its tooltip shows", async ({ page }) => {
  // 250 ms after the pointer enters, the page flips a class on an element unrelated to the control,
  // which starts a 20 ms transition on the control. No mutation the hover follow-through counts
  // happens before the tooltip shows 150 ms after that transition ends. Only the transition's start,
  // seen through the motion listeners, keeps the hover open past its 300 ms settle time: without
  // it the hover settles at about 330 ms (30 ms dwell + 300 ms), before the tooltip shows at about 420 ms.
  const LATE = `
<style>
  .tip-wrap { position: relative; display: inline-block; margin: 40px }
  .late { transition: background-color 20ms }
  #flag.on ~ .tip-wrap .late { background-color: #ffd }
  .tip { position: absolute; left: 0; top: 44px; width: 160px; padding: 4px; background: #222; color: #fff; display: none }
  .tip.shown { display: block }
</style>
<i id="flag"></i>
<span class="tip-wrap"><button data-testid="late" class="late">Help</button><span class="tip">Opens the guide</span></span>`;
  await serve(page, LATE);
  await page.evaluate(() => {
    const w = window as any;
    w.__runs = 0;
    w.__shown = 0;
    const flag = document.getElementById("flag")!;
    const button = document.querySelector(".late")!;
    const tip = document.querySelector(".tip")!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    button.addEventListener("transitionrun", () => w.__runs++);
    button.addEventListener("pointerenter", () => {
      timer = setTimeout(() => flag.classList.add("on"), 250);
    });
    button.addEventListener("transitionend", () => {
      if (!flag.classList.contains("on")) return;
      timer = setTimeout(() => {
        tip.classList.add("shown");
        w.__shown++;
      }, 150);
    });
    button.addEventListener("pointerleave", () => {
      clearTimeout(timer);
      flag.classList.remove("on");
      tip.classList.remove("shown");
    });
  });
  const result = await sweepInteractions(page, { settleMs: 300 });
  expect(await page.evaluate(() => (window as any).__runs)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).__shown)).toBeGreaterThan(0);
  expect(result.controls).toBe(1);
  expect(result.findings.filter((f) => f.check === "a11y.hover_only_content").map((f) => f.control_id)).toEqual(["late"]);
});

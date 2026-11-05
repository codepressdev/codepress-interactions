import { expect, test, type Page } from "@playwright/test";
import { captureSnapshot, expectNoFindings, findIssues } from "../src/index";

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

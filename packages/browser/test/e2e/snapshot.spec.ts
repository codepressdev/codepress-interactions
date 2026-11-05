import { expect, test } from "@playwright/test";
import { events, expectValid, init, openPage, output, rowOf } from "./harness";

const FIXTURE = `
<header data-testid="header" style="position:fixed;top:0;left:0;right:0;height:48px;z-index:10;background:#eee">
  <button data-testid="menu" style="margin:8px">Menu</button>
</header>
<main data-testid="main" style="padding:64px 24px 24px">
  <h1 data-testid="title">Orders</h1>
  <div data-testid="relative" style="position:relative;width:320px;height:120px;border:2px solid #333">
    <span data-testid="absolute" style="position:absolute;right:-30px;top:10px;width:80px;height:20px;background:#fc0;z-index:2"></span>
  </div>
  <div data-testid="scroller" style="height:60px;width:200px;overflow:auto;margin-top:12px">
    <div data-testid="tall" style="height:300px">x</div>
  </div>
  <div data-testid="sticky" style="position:sticky;top:48px;transform:translateX(13.37px) scale(0.9)">sticky</div>
  <my-card data-testid="host"></my-card>
  <canvas data-testid="canvas" width="100" height="40"></canvas>
  <iframe data-testid="frame" srcdoc="<p>inside</p>" style="width:120px;height:50px"></iframe>
  <section data-testid="ignored" data-layout-ignore style="width:100px;height:30px"><button data-testid="inside-ignored">x</button></section>
  <div class="private" style="width:90px;height:30px"><button data-testid="inside-private">x</button></div>
  <div style="display:none"><button data-testid="hidden">x</button></div>
</main>
<script>
  customElements.define("my-card", class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" }).innerHTML =
        '<div style="padding:4px"><button data-testid="shadow-button">Go</button><slot></slot></div>';
    }
  });
</script>`;

test("snapshot boxes match getBoundingClientRect for sampled elements", async ({ page }) => {
  await openPage(page, FIXTURE);
  await init(page, { ignoreSelector: ".private" });
  const summary = await page.evaluate(() => (window as any).handle.snapshot());
  expect(summary).not.toBeNull();
  const out = await output(page);
  expectValid(out);
  expect(out.snapshots).toHaveLength(1);
  const body = out.snapshots[0].body;
  expect(out.snapshots[0].sha256).toBe(summary.sha256);
  expect(body.truncated).toBe(false);
  expect(body.torn).toBe(false);

  const sampled = [
    "header", "menu", "main", "title", "relative", "absolute", "scroller", "tall",
    "sticky", "canvas", "frame", "ignored",
  ];
  const rects = await page.evaluate((ids) => {
    const find = (id: string): Element | null =>
      document.querySelector(`[data-testid="${id}"]`) ??
      document.querySelector("my-card")!.shadowRoot!.querySelector(`[data-testid="${id}"]`);
    return Object.fromEntries(
      [...ids, "shadow-button"].map((id) => {
        const r = find(id)!.getBoundingClientRect();
        return [id, { x: r.x, y: r.y, width: r.width, height: r.height }];
      }),
    );
  }, sampled);
  for (const id of [...sampled, "shadow-button"]) {
    const row = rowOf(body, id);
    for (const key of ["x", "y", "width", "height"] as const)
      expect(Math.abs(body.elements[key][row] - rects[id][key]), `${id}.${key}`).toBeLessThanOrEqual(0.005);
  }

  const flags = body.legend.flags;
  const has = (id: string, flag: string) => (body.elements.flags[rowOf(body, id)] & flags[flag]) !== 0;
  const position = (id: string) => body.legend.position[body.elements.position[rowOf(body, id)]];
  expect(position("header")).toBe("fixed");
  expect(position("relative")).toBe("relative");
  expect(position("absolute")).toBe("absolute");
  expect(position("sticky")).toBe("sticky");
  expect(position("title")).toBe("static");
  expect(body.elements.z_index[rowOf(body, "header")]).toBe(10);
  expect(body.elements.z_index[rowOf(body, "title")]).toBeNull();
  expect(has("header", "overlay")).toBe(true);
  expect(has("absolute", "overlay")).toBe(true);
  expect(has("scroller", "scrollable")).toBe(true);
  expect(has("scroller", "clips_content")).toBe(true);
  expect(has("tall", "clipped")).toBe(true);
  expect(has("menu", "interactive")).toBe(true);
  expect(has("menu", "visible")).toBe(true);
  expect(has("title", "interactive")).toBe(false);
  expect(has("canvas", "opaque")).toBe(true);
  expect(has("frame", "opaque")).toBe(true);
  expect(has("ignored", "ignored")).toBe(true);
  expect(has("shadow-button", "in_shadow")).toBe(true);
  expect(has("shadow-button", "interactive")).toBe(true);
  // Ignored and private subtrees are one box; display:none is absent.
  for (const id of ["inside-ignored", "inside-private", "hidden"])
    expect(body.dictionaries.test_id).not.toContain(id);
  // Parents precede children, and the shadow button's ancestor chain reaches the host.
  const parents: number[] = body.elements.parent;
  parents.forEach((parent, row) => expect(parent).toBeLessThan(row));
  let at = rowOf(body, "shadow-button");
  const chain: number[] = [];
  while (at !== -1) chain.push((at = parents[at]));
  expect(chain).toContain(rowOf(body, "host"));
  // Roles: explicit or implicit for common tags.
  const role = (id: string) => body.dictionaries.role[body.elements.role[rowOf(body, id)]];
  expect(role("menu")).toBe("button");
  expect(role("title")).toBe("heading");

  const snapshotEvents = events(out).filter((e) => e.type === "ui.snapshot");
  expect(snapshotEvents).toHaveLength(1);
  expect(snapshotEvents[0].data).toMatchObject({
    sha256: summary.sha256,
    trigger: "manual",
    element_count: body.element_count,
    route_template: "/",
    viewport_width: 1280,
  });
  // The first screen also reports performance signal availability.
  const perf = events(out).find((e) => e.type === "perf.summary");
  expect(perf.data.unavailable).toEqual([]);
});

test("route settled and resize settled trigger snapshots", async ({ page }) => {
  await openPage(page, '<div data-testid="a" style="width:50%;height:40px"></div>');
  await init(page, { routeSettleMs: 50, resizeSettleMs: 50, visibleSettleMs: 50, routeSegments: ["orders"] });
  await expect.poll(async () => (await output(page)).snapshots.length).toBe(1);
  await page.evaluate(() => history.pushState({}, "", "/orders/8f14e45f-ceea-467f-a0e6-0e2a1b0c2b11?q=secret"));
  await page.evaluate(() => {
    const div = document.createElement("div");
    div.style.height = "20px";
    document.body.append(div);
  });
  await expect.poll(async () => events(await output(page)).filter((e) => e.type === "ui.snapshot").length).toBe(2);
  await page.setViewportSize({ width: 700, height: 600 });
  await expect.poll(async () => events(await output(page)).filter((e) => e.type === "ui.snapshot").length).toBe(3);
  const out = await output(page);
  expectValid(out);
  const triggers = events(out).filter((e) => e.type === "ui.snapshot").map((e) => [e.data.trigger, e.data.route_template]);
  expect(triggers).toEqual([
    ["route", "/"],
    ["route", "/orders/:id"],
    ["resize", "/orders/:id"],
  ]);
  expect(JSON.stringify(out)).not.toContain("secret");
});

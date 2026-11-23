/** UI state (1.5.0) in a real browser: the snapshot state table and the click state fields. */
import { expect, test, type Page } from "@playwright/test";
import { events, expectValid, init, openPage, output, rowOf } from "./harness";

const STATE = { current: 1, selected: 2, expanded: 4, pressed: 8, checked: 16, disabled: 32, invalid: 64, busy: 128, open: 256, links_here: 512 };

const bitsOf = (body: any, testId: string): number => {
  const row = rowOf(body, testId);
  const at = body.state?.element.indexOf(row) ?? -1;
  return at === -1 ? 0 : body.state.bits[at];
};

test("a snapshot's state rows carry nav current, tab selected, disclosure expanded and checkbox checked", async ({ page }) => {
  await openPage(
    page,
    `<nav>
       <a data-testid="nav-home" href="/">Home</a>
       <a data-testid="nav-docs" href="/docs/" aria-current="page">Docs</a>
     </nav>
     <div role="tablist">
       <button role="tab" data-testid="tab-a" aria-selected="true">A</button>
       <button role="tab" data-testid="tab-b" aria-selected="false">B</button>
     </div>
     <button data-testid="more" aria-expanded="true" aria-controls="panel">More</button>
     <div id="panel">Panel</div>
     <label><input type="checkbox" data-testid="agree" checked> Agree</label>
     <label><input type="checkbox" data-testid="news"> News</label>
     <div popover id="pop" data-testid="pop">Pop</div>`,
    {},
    "/docs",
  );
  await init(page);
  await page.evaluate(() => (document.getElementById("pop") as any).showPopover());
  await page.evaluate(() => (window as any).handle.snapshot());
  const out = await output(page);
  expectValid(out);
  const body = out.snapshots[0].body;
  expect(body.legend.state).toEqual(STATE);
  expect(bitsOf(body, "nav-docs")).toBe(STATE.current | STATE.links_here);
  expect(bitsOf(body, "nav-home")).toBe(0);
  expect(bitsOf(body, "tab-a")).toBe(STATE.selected);
  expect(bitsOf(body, "tab-b")).toBe(0);
  expect(bitsOf(body, "more")).toBe(STATE.expanded);
  expect(bitsOf(body, "agree")).toBe(STATE.checked);
  expect(bitsOf(body, "news")).toBe(0);
  expect(bitsOf(body, "pop")).toBe(STATE.open);
  expect(body.state.truncated).toBe(false);
});

/** A client-side nav: a click on a link pushes its path without the trailing slash; `moveCurrent` says whether the app marks it. */
const nav = (moveCurrent: boolean) => `
  <nav>
    <a data-testid="nav-home" href="/" aria-current="page">Home</a>
    <a data-testid="nav-foo" href="/foo/">Foo</a>
  </nav>
  <main id="main">Home page</main>
  <script>
    for (const link of document.querySelectorAll("nav a"))
      link.addEventListener("click", (event) => {
        event.preventDefault();
        history.pushState({}, "", link.getAttribute("href").replace(/(.)\\/$/, "$1"));
        document.getElementById("main").textContent = "Another page";
        ${moveCurrent ? `for (const other of document.querySelectorAll("nav a")) other.removeAttribute("aria-current");
        link.setAttribute("aria-current", "page");` : ""}
      });
  </script>`;

async function clickFoo(page: Page) {
  await init(page, { clickSettleMs: 100 });
  await page.evaluate(() => (window as any).handle.snapshot());
  await page.click('[data-testid="nav-foo"]');
  await expect.poll(async () => events(await output(page)).some((e) => e.type === "ui.click.settled")).toBe(true);
  expect(new URL(page.url()).pathname).toBe("/foo");
  const out = await output(page);
  expectValid(out);
  return { out, click: events(out).find((e) => e.type === "ui.click.settled").data };
}

test("a nav link to /foo/ landing on /foo with nothing marked current: links here, none marked", async ({ page }) => {
  await openPage(page, nav(false));
  const { out, click } = await clickFoo(page);
  expect(click.route_changed).toBe(true);
  expect(click.links_here_after).toBeGreaterThanOrEqual(1);
  expect(click.links_here_marked_after).toBe(0);
  expect(click.marked_before).toBe(1);
  expect(click.marked_after).toBe(1);
  // Home is still the one marked: the after snapshot shows it, and the link here has links_here only.
  const after = out.snapshots.find((s) => s.sha256 === click.after_sha256)!.body;
  expect(bitsOf(after, "nav-home")).toBe(STATE.current);
  expect(bitsOf(after, "nav-foo")).toBe(STATE.links_here);
});

test("a nav link to /foo/ with nothing marked at all after the click: marked_after 0", async ({ page }) => {
  await openPage(
    page,
    nav(false).replace(
      'document.getElementById("main").textContent = "Another page";',
      'document.getElementById("main").textContent = "Another page"; for (const other of document.querySelectorAll("nav a")) other.removeAttribute("aria-current");',
    ),
  );
  const { click } = await clickFoo(page);
  expect(click.links_here_after).toBeGreaterThanOrEqual(1);
  expect(click.links_here_marked_after).toBe(0);
  expect(click.marked_before).toBe(1);
  expect(click.marked_after).toBe(0);
  expect(click.state_changes).toBe(1);
});

test("a correct nav marks the link here: links_here_marked_after and marked_after are 1", async ({ page }) => {
  await openPage(page, nav(true));
  const { out, click } = await clickFoo(page);
  expect(click.links_here_after).toBeGreaterThanOrEqual(1);
  expect(click.links_here_marked_after).toBeGreaterThanOrEqual(1);
  expect(click.marked_before).toBe(1);
  expect(click.marked_after).toBe(1);
  expect(click.clicked_state_changed).toBe(true);
  expect(click.state_reverted).toBe(false);
  const after = out.snapshots.find((s) => s.sha256 === click.after_sha256)!.body;
  expect(bitsOf(after, "nav-foo")).toBe(STATE.current | STATE.links_here);
  expect(bitsOf(after, "nav-home")).toBe(0);
});

test("a tab selected and then unselected before settling records state_reverted", async ({ page }) => {
  await openPage(
    page,
    `<div role="tablist">
       <button role="tab" data-testid="tab-a" aria-selected="true">A</button>
       <button role="tab" data-testid="tab-b" aria-selected="false">B</button>
     </div>
     <script>
       const [a, b] = document.querySelectorAll('[role="tab"]');
       b.addEventListener("click", () => {
         b.setAttribute("aria-selected", "true");
         a.setAttribute("aria-selected", "false");
         setTimeout(() => {
           b.setAttribute("aria-selected", "false");
           a.setAttribute("aria-selected", "true");
         }, 30);
       });
     </script>`,
  );
  await init(page, { clickSettleMs: 100 });
  await page.click('[data-testid="tab-b"]');
  await expect.poll(async () => events(await output(page)).some((e) => e.type === "ui.click.settled")).toBe(true);
  const out = await output(page);
  expectValid(out);
  const click = events(out).find((e) => e.type === "ui.click.settled").data;
  expect(click).toMatchObject({ state_reverted: true, state_changes: 0, clicked_state_changed: false, marked_before: 1, marked_after: 1 });
});

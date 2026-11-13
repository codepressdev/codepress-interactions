import { expect, test, type Page, type Route } from "@playwright/test";
import { events, expectValid, init, openPage, output, type Output } from "./harness";

const CHECK = "click.effect_not_applied";
const findings = (out: Output) => events(out).filter((e) => e.type === "ui.finding" && e.data.check === CHECK);
const settled = (out: Output) => events(out).filter((e) => e.type === "ui.click.settled");

/** Every API call answers after `delay` ms, so a click's window stays open across the handler's steps. */
const slowApi = (delay = 60) => async (route: Route) => {
  await new Promise((r) => setTimeout(r, delay));
  await route.fulfill({ contentType: "application/json", body: "{}" });
};

async function clickAndSettle(page: Page, selector: string, count = 1): Promise<Output> {
  await page.click(selector);
  await expect.poll(async () => settled(await output(page)).length).toBe(count);
  return output(page);
}

/** Reloads, starts the SDK again and takes the first snapshot, after which pending expectations are re-checked. */
async function reloadAndCheck(page: Page): Promise<void> {
  await page.reload();
  await init(page, { clickSettleMs: 150 });
  await page.evaluate(() => (window as any).handle.snapshot());
}

const STORE = "codepress-interactions:effects";
const stored = (page: Page) => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "[]").length as number, STORE);
/** Waits until every expectation for the next load has been decided (and removed from storage). */
const expectDecided = (page: Page) => expect.poll(() => stored(page)).toBe(0);

const LIST = (handler: string, before = "") => `
<ul id="list">
  <li data-interaction-item="inv-a" data-testid="invite-row">A <button data-testid="remove-invite" data-interaction-removes>Remove</button></li>
  <li data-interaction-item="inv-b" data-testid="invite-row">B</li>
</ul>
<script>
  ${before}
  const row = () => document.querySelector('[data-interaction-item="inv-a"]');
  document.addEventListener("click", async (event) => {
    if (!event.target.closest('[data-testid="remove-invite"]')) return;
    ${handler}
  });
</script>`;

test("a marked Remove whose item is still there at settle gives exactly one finding", async ({ page }) => {
  const { errors } = await openPage(page, LIST(`await fetch("/api/remove", { method: "POST" });`), { api: slowApi() });
  await init(page, { clickSettleMs: 150 });
  const out = await clickAndSettle(page, '[data-testid="remove-invite"]');
  expectValid(out);
  const found = findings(out);
  expect(found).toHaveLength(1);
  const click = settled(out)[0];
  expect(found[0].interaction_id).toBe(click.interaction_id);
  expect(found[0].data).toMatchObject({ control_id: "remove-invite", subject: null, other: null, check_version: 1 });
  expect(found[0].data.evidence).toMatchObject({
    effect: 1,
    expected_removed: 1,
    present_at_settle: true,
    vanished_then_returned: false,
    present_after_reload: null,
    matches: 1,
    request_count: 1,
    request_failed_count: 0,
    dialog_opened: false,
  });
  expect(errors).toEqual([]);
});

test("an optimistic remove that comes back within the window is reported as vanished then returned", async ({ page }) => {
  await openPage(
    page,
    LIST(`
      const li = row();
      const parent = li.parentElement;
      li.remove();
      await fetch("/api/remove", { method: "POST" });
      parent.prepend(li.cloneNode(true));`),
    { api: slowApi() },
  );
  await init(page, { clickSettleMs: 150 });
  const out = await clickAndSettle(page, '[data-testid="remove-invite"]');
  const found = findings(out);
  expect(found).toHaveLength(1);
  expect(found[0].data.evidence).toMatchObject({ effect: 1, present_at_settle: true, vanished_then_returned: true });
});

test("an item really removed gives no finding, also when the list re-renders every row as a new element", async ({ page }) => {
  // Re-rendering the list under new keys: every row is a new element; the removed one is gone.
  await openPage(
    page,
    LIST(`
      await fetch("/api/remove", { method: "POST" });
      document.getElementById("list").innerHTML = '<li data-interaction-item="inv-b" data-testid="invite-row">B</li>';`),
    { api: slowApi() },
  );
  await init(page, { clickSettleMs: 150 });
  const out = await clickAndSettle(page, '[data-testid="remove-invite"]');
  expect(findings(out)).toEqual([]);
});

test("a row re-rendered as a new element with the same item key still counts as there", async ({ page }) => {
  await openPage(
    page,
    LIST(`
      await fetch("/api/remove", { method: "POST" });
      document.getElementById("list").innerHTML =
        '<li data-interaction-item="inv-a">A again</li><li data-interaction-item="inv-b">B</li>';`),
    { api: slowApi() },
  );
  await init(page, { clickSettleMs: 150 });
  const out = await clickAndSettle(page, '[data-testid="remove-invite"]');
  expect(findings(out)).toHaveLength(1);
  expect(findings(out)[0].data.evidence).toMatchObject({ present_at_settle: true, vanished_then_returned: false });
});

test("an item that comes back after a reload in the same tab is reported on the next load", async ({ page }) => {
  // The page always renders the item: the server never removed it.
  await openPage(page, LIST(`row().remove(); await fetch("/api/remove", { method: "POST" });`), { api: slowApi() });
  await init(page, { clickSettleMs: 150 });
  const first = await clickAndSettle(page, '[data-testid="remove-invite"]');
  expect(findings(first)).toEqual([]);
  const stored = await page.evaluate(() => sessionStorage.getItem("codepress-interactions:effects"));
  expect(JSON.parse(stored!)).toHaveLength(1);
  await reloadAndCheck(page);
  await expect.poll(async () => findings(await output(page)).length).toBe(1);
  const out = await output(page);
  expectValid(out);
  const [finding] = findings(out);
  expect(finding.interaction_id).toBeNull();
  expect(finding.data.control_id).toBe("remove-invite");
  expect(finding.data.evidence).toMatchObject({
    effect: 1,
    expected_removed: 1,
    present_at_settle: false,
    present_after_reload: true,
    matches: 1,
    request_count: 1,
  });
  // Judged once: the expectation is gone.
  expect(await page.evaluate(() => sessionStorage.getItem("codepress-interactions:effects"))).toBeNull();
});

test("a removal that persists across a reload gives no finding", async ({ page }) => {
  await openPage(
    page,
    LIST(
      `row().remove(); localStorage.setItem("gone", "1"); await fetch("/api/remove", { method: "POST" });`,
      `if (localStorage.getItem("gone")) document.querySelector('[data-interaction-item="inv-a"]').remove();`,
    ),
    { api: slowApi() },
  );
  await init(page, { clickSettleMs: 150 });
  await clickAndSettle(page, '[data-testid="remove-invite"]');
  await reloadAndCheck(page);
  await expectDecided(page);
  expect(findings(await output(page))).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.getItem("codepress-interactions:effects"))).toBeNull();
});

test("removes by test ID: a missing target counts as removed, one still rendered does not", async ({ page }) => {
  await openPage(
    page,
    `<div data-testid="draft-banner">Draft</div><div data-testid="draft-tag">tag</div>
     <button data-testid="discard" data-interaction-removes="draft-banner draft-tag">Discard</button>
     <script>
       document.querySelector('[data-testid="discard"]').addEventListener("click", async () => {
         document.querySelector('[data-testid="draft-banner"]').remove();
         await fetch("/api/discard", { method: "POST" });
       });
     </script>`,
    { api: slowApi() },
  );
  await init(page, { clickSettleMs: 150 });
  const out = await clickAndSettle(page, '[data-testid="discard"]');
  expect(findings(out)).toHaveLength(1);
  expect(findings(out)[0].data.evidence).toMatchObject({ effect: 1, expected_removed: 2, present_at_settle: true, matches: 1 });
});

test("adds: a target that never appears is reported; one that appears and stays after reload is not", async ({ page }) => {
  await openPage(
    page,
    `<ul id="tokens">${"<li data-testid=\"token-row\">t</li>"}</ul>
     <button data-testid="add-token" data-interaction-adds="token-row">Add</button>
     <button data-testid="add-token-broken" data-interaction-adds="token-row">Add (broken)</button>
     <script>
       for (let i = 0; i < Number(sessionStorage.getItem("added") ?? 0); i++)
         document.getElementById("tokens").insertAdjacentHTML("beforeend", '<li data-testid="token-row">t</li>');
       document.querySelector('[data-testid="add-token"]').addEventListener("click", async () => {
         await fetch("/api/add", { method: "POST" });
         sessionStorage.setItem("added", String(Number(sessionStorage.getItem("added") ?? 0) + 1));
         document.getElementById("tokens").insertAdjacentHTML("beforeend", '<li data-testid="token-row">t</li>');
       });
       document.querySelector('[data-testid="add-token-broken"]').addEventListener("click", () => fetch("/api/add", { method: "POST" }));
     </script>`,
    { api: slowApi() },
  );
  await init(page, { clickSettleMs: 150 });
  let out = await clickAndSettle(page, '[data-testid="add-token"]');
  expect(findings(out)).toEqual([]);
  out = await clickAndSettle(page, '[data-testid="add-token-broken"]', 2);
  expect(findings(out)).toHaveLength(1);
  expect(findings(out)[0].data).toMatchObject({ control_id: "add-token-broken" });
  expect(findings(out)[0].data.evidence).toMatchObject({ effect: 2, expected_added: 1, present_at_settle: false, matches: 2 });
  await reloadAndCheck(page);
  await expectDecided(page);
  expect(findings(await output(page))).toEqual([]);
});

const SWITCH = (handler: string, before = "") => `
<button role="switch" aria-checked="false" data-testid="notify-switch" data-interaction-sets="notify-switch:checked">Notify</button>
<script>
  const sw = document.querySelector('[data-testid="notify-switch"]');
  ${before}
  sw.addEventListener("click", async () => {
    ${handler}
  });
</script>`;

test("sets: a switch that flips back within the window is reported with state_held false", async ({ page }) => {
  await openPage(
    page,
    SWITCH(`sw.setAttribute("aria-checked", "true"); await fetch("/api/notify", { method: "POST" }); sw.setAttribute("aria-checked", "false");`),
    { api: slowApi() },
  );
  await init(page, { clickSettleMs: 150 });
  const out = await clickAndSettle(page, '[data-testid="notify-switch"]');
  expect(findings(out)).toHaveLength(1);
  expect(findings(out)[0].data.evidence).toMatchObject({ effect: 3, state_held: false, matches: 1 });
});

test("sets: a switch that holds at settle but comes back unchecked after a reload is reported on the next load", async ({ page }) => {
  await openPage(page, SWITCH(`sw.setAttribute("aria-checked", "true"); await fetch("/api/notify", { method: "POST" });`), {
    api: slowApi(),
  });
  await init(page, { clickSettleMs: 150 });
  const first = await clickAndSettle(page, '[data-testid="notify-switch"]');
  expect(findings(first)).toEqual([]);
  await reloadAndCheck(page);
  await expect.poll(async () => findings(await output(page)).length).toBe(1);
  const [finding] = findings(await output(page));
  expect(finding.data.evidence).toMatchObject({ effect: 3, state_held: false, present_after_reload: null });
});

test("sets: a switch that holds at settle and after a reload gives no finding", async ({ page }) => {
  await openPage(
    page,
    SWITCH(
      `sw.setAttribute("aria-checked", "true"); localStorage.setItem("notify", "1"); await fetch("/api/notify", { method: "POST" });`,
      `if (localStorage.getItem("notify")) sw.setAttribute("aria-checked", "true");`,
    ),
    { api: slowApi() },
  );
  await init(page, { clickSettleMs: 150 });
  const first = await clickAndSettle(page, '[data-testid="notify-switch"]');
  expect(findings(first)).toEqual([]);
  await reloadAndCheck(page);
  await expectDecided(page);
  expect(findings(await output(page))).toEqual([]);
});

test("sets: a data-state literal that does not hold is reported", async ({ page }) => {
  await openPage(
    page,
    `<div data-testid="github-connection" data-state="disconnected">GitHub</div>
     <button data-testid="connect" data-interaction-sets="github-connection:data-state=connected">Connect</button>
     <script>
       document.querySelector('[data-testid="connect"]').addEventListener("click", async () => {
         const el = document.querySelector('[data-testid="github-connection"]');
         el.dataset.state = "connecting";
         await fetch("/api/connect", { method: "POST" });
         el.dataset.state = "disconnected";
       });
     </script>`,
    { api: slowApi() },
  );
  await init(page, { clickSettleMs: 150 });
  const out = await clickAndSettle(page, '[data-testid="connect"]');
  expect(findings(out)).toHaveLength(1);
  expect(findings(out)[0].data.evidence).toMatchObject({ effect: 3, state_held: false });
});

const FORM = (persist: boolean) => `
<form id="profile" onsubmit="return false">
  <input data-testid="display-name" id="dn" value="Old name">
  <textarea data-testid="bio" id="bio">Old bio</textarea>
  <button data-testid="save-profile" data-interaction-saves="display-name bio">Save</button>
</form>
<script>
  const saved = JSON.parse(localStorage.getItem("profile") ?? "null");
  if (saved) { dn.value = saved.name; bio.value = saved.bio; }
  document.querySelector('[data-testid="save-profile"]').addEventListener("click", async () => {
    await fetch("/api/profile", { method: "POST" });
    ${persist ? `localStorage.setItem("profile", JSON.stringify({ name: dn.value, bio: bio.value }));` : ""}
  });
</script>`;

test("saves: a field that shows its old value after a reload is reported on the next load", async ({ page }) => {
  await openPage(page, FORM(false), { api: slowApi() });
  await init(page, { clickSettleMs: 150 });
  await page.fill("#dn", "New name");
  const first = await clickAndSettle(page, '[data-testid="save-profile"]');
  expect(findings(first)).toEqual([]);
  await reloadAndCheck(page);
  await expect.poll(async () => findings(await output(page)).length).toBe(1);
  const out = await output(page);
  const [finding] = findings(out);
  expect(finding.data.control_id).toBe("save-profile");
  expect(finding.data.evidence).toMatchObject({ effect: 4, fields_saved: 2, fields_reverted: 1, matches: 2 });
  const everything = out.serialized.join("\n");
  expect(everything).not.toContain("New name");
  expect(everything).not.toContain("Old name");
});

test("saves: a field reset to its old value at settle is reported at once", async ({ page }) => {
  await openPage(
    page,
    `<input data-testid="display-name" id="dn" value="Old name">
     <button data-testid="save-profile" data-interaction-saves="display-name">Save</button>
     <script>
       document.querySelector('[data-testid="save-profile"]').addEventListener("click", async () => {
         await fetch("/api/profile", { method: "POST" });
         dn.value = "Old name";
       });
     </script>`,
    { api: slowApi() },
  );
  await init(page, { clickSettleMs: 150 });
  await page.fill("#dn", "New name");
  const out = await clickAndSettle(page, '[data-testid="save-profile"]');
  expect(findings(out)).toHaveLength(1);
  expect(findings(out)[0].data.evidence).toMatchObject({ effect: 4, fields_saved: 1, fields_reverted: 1 });
});

test("saves: a save that persists gives no finding, at settle or after a reload", async ({ page }) => {
  await openPage(page, FORM(true), { api: slowApi() });
  await init(page, { clickSettleMs: 150 });
  await page.fill("#dn", "New name");
  await page.fill("#bio", "New bio");
  const first = await clickAndSettle(page, '[data-testid="save-profile"]');
  expect(findings(first)).toEqual([]);
  await reloadAndCheck(page);
  await expectDecided(page);
  expect(findings(await output(page))).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.getItem("codepress-interactions:effects"))).toBeNull();
});

test("windows that are not judged give no finding: a confirm dialog opener, overlapped, navigated and timed-out clicks", async ({ page }) => {
  await openPage(
    page,
    `<ul>
       <li data-interaction-item="a"><button data-testid="remove-a" data-interaction-removes>Remove A</button></li>
       <li data-interaction-item="b"><button data-testid="remove-b" data-interaction-removes>Remove B</button></li>
       <li data-interaction-item="c"><button data-testid="remove-c" data-interaction-removes>Remove C</button></li>
       <li data-interaction-item="d"><button data-testid="remove-d" data-interaction-removes>Remove D</button></li>
     </ul>
     <button data-testid="other">Other</button>
     <script>
       const on = (id, fn) => document.querySelector('[data-testid="' + id + '"]').addEventListener("click", fn);
       // Opens a confirm dialog: the marker belongs on the dialog's own button.
       on("remove-a", () => {
         const d = document.createElement("div");
         d.setAttribute("role", "dialog");
         d.textContent = "Sure?";
         document.body.append(d);
       });
       // Slow: a second click overlaps it.
       on("remove-b", () => fetch("/api/slow"));
       // Navigates within the app.
       on("remove-c", () => history.pushState({}, "", "/elsewhere"));
       // Keeps changing the page until the window times out.
       on("remove-d", () => {
         let n = 0;
         const t = setInterval(() => { document.title = "t" + n++; document.body.dataset.n = String(n); document.body.classList.toggle("x"); }, 50);
         setTimeout(() => clearInterval(t), 1500);
       });
     </script>`,
    {
      api: async (route) => {
        if (new URL(route.request().url()).pathname === "/api/slow") await new Promise((r) => setTimeout(r, 400));
        await route.fulfill({ contentType: "application/json", body: "{}" });
      },
    },
  );
  await init(page, { clickSettleMs: 150, clickTimeoutMs: 600 });
  await clickAndSettle(page, '[data-testid="remove-a"]', 1);
  await page.click('[data-testid="remove-b"]');
  await page.waitForTimeout(50);
  await clickAndSettle(page, '[data-testid="other"]', 3);
  await clickAndSettle(page, '[data-testid="remove-c"]', 4);
  await page.evaluate(() => history.pushState({}, "", "/"));
  const out = await clickAndSettle(page, '[data-testid="remove-d"]', 5);
  const [a, b, , c, d] = settled(out);
  expect(a.data.dialog_opened).toBe(true);
  expect(b.data.overlapped).toBe(true);
  expect(c.data.route_changed).toBe(true);
  expect(d.data).toMatchObject({ incomplete: true, end_reason: "timeout" });
  expect(findings(out)).toEqual([]);
  // Nothing waits for a reload either.
  expect(await page.evaluate(() => sessionStorage.getItem("codepress-interactions:effects"))).toBeNull();
});

test("the last click before an unload is judged on the next load", async ({ page }) => {
  // The click navigates the whole page before its window settles: the item is still served.
  await openPage(page, LIST(`row().remove(); location.reload();`));
  await init(page, { clickSettleMs: 2000 });
  await Promise.all([page.waitForEvent("load"), page.click('[data-testid="remove-invite"]')]);
  await init(page, { clickSettleMs: 150 });
  await page.evaluate(() => (window as any).handle.snapshot());
  await expect.poll(async () => findings(await output(page)).length).toBe(1);
  const [finding] = findings(await output(page));
  expect(finding.data.evidence).toMatchObject({ effect: 1, present_at_settle: null, present_after_reload: true });
});

test("without sessionStorage the settle check still runs, with no reload check and no error", async ({ page }) => {
  const { errors } = await openPage(page, LIST(`await fetch("/api/remove", { method: "POST" });`), {
    api: slowApi(),
    initScript: `Object.defineProperty(window, "sessionStorage", { get() { throw new DOMException("blocked", "SecurityError"); } });`,
  });
  await init(page, { clickSettleMs: 150 });
  const out = await clickAndSettle(page, '[data-testid="remove-invite"]');
  expect(findings(out)).toHaveLength(1);
  await reloadAndCheck(page);
  await page.waitForTimeout(300);
  expect(findings(await output(page))).toEqual([]);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => (window as any).__rejections)).toBe(0);
});

test("the check is off when left out of detect.checks, and pages without the markup store nothing", async ({ page }) => {
  await openPage(page, LIST(`await fetch("/api/remove", { method: "POST" });`), { api: slowApi() });
  await init(page, { clickSettleMs: 150, detect: { checks: ["dead_click"] } });
  const out = await clickAndSettle(page, '[data-testid="remove-invite"]');
  expect(findings(out)).toEqual([]);
  await openPage(page, `<button id="b">Plain</button><script>b.onclick = () => fetch("/api/x")</script>`);
  await init(page, { clickSettleMs: 150 });
  await clickAndSettle(page, "#b");
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
});

// ---- The next load decides only on evidence, once the page is quiet ---------

/**
 * Pages that start the SDK before the app fetches its state, as an app does.
 * The first snapshot comes at 50 ms, long before the state request (400 ms)
 * renders what the click changed. `persist` decides whether the click's effect
 * really stuck.
 */
const START = `<script>window.handle = CodepressInteractions.initInteractions({
  sink: window.sink, flushIntervalMs: 3600000, routeSettleMs: 50, clickSettleMs: 150, allowedApiOrigins: [location.origin] });</script>`;
const ready = `document.body.dataset.ready = "1";`;
const stateApi = async (route: Route) => {
  const path = new URL(route.request().url()).pathname;
  await new Promise((r) => setTimeout(r, path === "/api/state" ? 400 : 60));
  await route.fulfill({ contentType: "application/json", body: "{}" });
};

const DELAYED: Record<string, { page: (persist: boolean) => string; control: string; before?: (page: Page) => Promise<void>; failed: Record<string, unknown> }> = {
  removes: {
    control: '[data-testid="remove-invite"]',
    page: (persist) => `${START}
      <ul id="list"></ul>
      <script>
        fetch("/api/state").then(() => {
          document.getElementById("list").innerHTML =
            (localStorage.getItem("gone") ? "" : '<li data-interaction-item="inv-a">A <button data-testid="remove-invite" data-interaction-removes>Remove</button></li>') +
            '<li data-interaction-item="inv-b">B</li>';
          ${ready}
        });
        document.addEventListener("click", async (event) => {
          if (!event.target.closest('[data-testid="remove-invite"]')) return;
          event.target.closest("li").remove();
          ${persist ? `localStorage.setItem("gone", "1");` : ""}
          await fetch("/api/remove", { method: "POST" });
        });
      </script>`,
    failed: { effect: 1, present_at_settle: false, present_after_reload: true },
  },
  adds: {
    control: '[data-testid="add-token"]',
    page: (persist) => `${START}
      <ul id="tokens"></ul>
      <button data-testid="add-token" data-interaction-adds="token-row">Add</button>
      <script>
        const tokens = document.getElementById("tokens");
        fetch("/api/state").then(() => {
          tokens.innerHTML = '<li data-testid="token-row">t</li>'.repeat(1 + Number(localStorage.getItem("added") ?? 0));
          ${ready}
        });
        document.querySelector('[data-testid="add-token"]').addEventListener("click", async () => {
          await fetch("/api/add", { method: "POST" });
          ${persist ? `localStorage.setItem("added", String(Number(localStorage.getItem("added") ?? 0) + 1));` : ""}
          tokens.insertAdjacentHTML("beforeend", '<li data-testid="token-row">t</li>');
        });
      </script>`,
    failed: { effect: 2, present_at_settle: true, present_after_reload: false, matches: 1 },
  },
  sets: {
    control: '[data-testid="notify-switch"]',
    page: (persist) => `${START}
      <button role="switch" aria-checked="false" data-testid="notify-switch" data-interaction-sets="notify-switch:checked">Notify</button>
      <script>
        const sw = document.querySelector('[data-testid="notify-switch"]');
        fetch("/api/state").then(() => {
          sw.setAttribute("aria-checked", localStorage.getItem("notify") ? "true" : "false");
          ${ready}
        });
        sw.addEventListener("click", async () => {
          sw.setAttribute("aria-checked", "true");
          ${persist ? `localStorage.setItem("notify", "1");` : ""}
          await fetch("/api/notify", { method: "POST" });
        });
      </script>`,
    failed: { effect: 3, state_held: false },
  },
  saves: {
    control: '[data-testid="save-profile"]',
    before: (page) => page.fill("#dn", "New name"),
    page: (persist) => `${START}
      <input data-testid="display-name" id="dn" value="">
      <button data-testid="save-profile" data-interaction-saves="display-name">Save</button>
      <script>
        const dn = document.getElementById("dn");
        fetch("/api/state").then(() => {
          dn.value = localStorage.getItem("dn") ?? "Old name";
          ${ready}
        });
        document.querySelector('[data-testid="save-profile"]').addEventListener("click", async () => {
          ${persist ? `localStorage.setItem("dn", dn.value);` : ""}
          await fetch("/api/profile", { method: "POST" });
        });
      </script>`,
    failed: { effect: 4, fields_saved: 1, fields_reverted: 1 },
  },
};

async function firstLoad(page: Page, kind: string, persist: boolean): Promise<void> {
  const setup = DELAYED[kind];
  await openPage(page, setup.page(persist), { api: stateApi });
  await page.waitForSelector("body[data-ready]");
  await setup.before?.(page);
  const out = await clickAndSettle(page, setup.control);
  expect(findings(out)).toEqual([]);
  expect(await stored(page)).toBe(1);
}

for (const kind of Object.keys(DELAYED)) {
  test(`${kind}: an effect that held, filled in by a request after the reload's first snapshot, gives no finding`, async ({ page }) => {
    await firstLoad(page, kind, true);
    await page.reload();
    await expectDecided(page);
    const out = await output(page);
    // The first snapshot was taken before the state request answered.
    expect(events(out).some((e) => e.type === "ui.snapshot")).toBe(true);
    expect(findings(out)).toEqual([]);
  });

  test(`${kind}: an effect that did not hold, shown by a request after the reload's first snapshot, is reported once the page is quiet`, async ({ page }) => {
    await firstLoad(page, kind, false);
    await page.reload();
    await expect.poll(async () => findings(await output(page)).length).toBe(1);
    const out = await output(page);
    expectValid(out);
    const [finding] = findings(out);
    expect(finding.interaction_id).toBeNull();
    expect(finding.data.evidence).toMatchObject(DELAYED[kind].failed);
    // Judged after the state request rendered, not at the first snapshot.
    const snapshot = events(out).find((e) => e.type === "ui.snapshot");
    const answered = events(out).find((e) => e.type === "request.completed");
    expect(finding.sequence).toBeGreaterThan(snapshot.sequence);
    expect(finding.sequence).toBeGreaterThan(answered.sequence);
    await expectDecided(page);
  });
}

/** Moves every stored expectation's deadline to `ms` from now. */
const shortenDeadline = (page: Page, ms: number) =>
  page.evaluate(
    ({ key, ms }) => {
      const entries = JSON.parse(sessionStorage.getItem(key) ?? "[]");
      for (const entry of entries) entry.d = Date.now() + ms;
      sessionStorage.setItem(key, JSON.stringify(entries));
    },
    { key: STORE, ms },
  );

test("a page that never goes quiet decides nothing: the expectation is dropped at its deadline with no finding", async ({ page }) => {
  // On the second load the page changes every 50 ms, so it is never quiet for 150 ms.
  await openPage(
    page,
    LIST(
      `row().remove(); await fetch("/api/remove", { method: "POST" });`,
      `if (sessionStorage.getItem("loaded")) setInterval(() => { document.body.dataset.tick = String(Date.now()); }, 50);
       sessionStorage.setItem("loaded", "1");`,
    ),
    { api: slowApi() },
  );
  await init(page, { clickSettleMs: 150 });
  await clickAndSettle(page, '[data-testid="remove-invite"]');
  await shortenDeadline(page, 2500);
  await reloadAndCheck(page);
  // The item is back, but the page was never quiet: still waiting, nothing reported.
  await page.waitForTimeout(1000);
  expect(await stored(page)).toBe(1);
  expect(findings(await output(page))).toEqual([]);
  await expectDecided(page);
  expect(findings(await output(page))).toEqual([]);
});

test("targets that never appear after the reload decide nothing: dropped at the deadline with no finding", async ({ page }) => {
  // The switch is not rendered on the second load (its panel never loads).
  await openPage(
    page,
    SWITCH(
      `sw.setAttribute("aria-checked", "true"); await fetch("/api/notify", { method: "POST" });`,
      `if (sessionStorage.getItem("loaded")) sw.remove(); sessionStorage.setItem("loaded", "1");`,
    ),
    { api: slowApi() },
  );
  await init(page, { clickSettleMs: 150 });
  await clickAndSettle(page, '[data-testid="notify-switch"]');
  await shortenDeadline(page, 2000);
  await reloadAndCheck(page);
  await page.waitForTimeout(800);
  expect(await stored(page)).toBe(1);
  await expectDecided(page);
  expect(findings(await output(page))).toEqual([]);
});

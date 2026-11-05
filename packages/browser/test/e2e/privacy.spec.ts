import { expect, test, type Page } from "@playwright/test";
import { events, expectValid, init, openPage, output } from "./harness";

// Mixed case and digits: a default route template collapses it like an ID.
const S = "Zq7Sentinel";

const PAGE = `
<title>${S} title</title>
<header><a id="link" href="/orders?ref=${S}&token=${S}" title="${S} tooltip">${S} link text</a></header>
<main class="c-${S}" id="id-${S}">
  <h1>${S} heading</h1>
  <p>Hello <strong>${S}</strong> customer</p>
  <img alt="${S} alt" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="20" height="20">
  <input id="field" value="${S}-value" placeholder="${S} placeholder" aria-label="${S} label">
  <textarea id="notes">${S} notes</textarea>
  <select id="pick"><option value="${S}">${S} option</option></select>
  <div contenteditable="true" id="editor">${S} editable</div>
  <button id="go" data-extra="${S}" aria-describedby="id-${S}">${S} button</button>
  <div data-interactions-exclude><button id="private">${S} private</button></div>
  <svg width="10" height="10"><text>${S}</text></svg>
</main>
<script>
  document.getElementById("go").addEventListener("click", async () => {
    document.querySelector("h1").textContent = "${S} changed";
    await fetch("/api/${S}/items?q=${S}", { headers: { "X-Custom": "${S}" } });
    history.pushState({}, "", "/account/${S}?q=${S}#${S}");
  });
</script>`;

test("a sentinel in text, values, title, href query and alt appears nowhere in sink output", async ({ page }) => {
  await openPage(page, PAGE, {
    api: (route) =>
      route.fulfill({
        contentType: "application/json",
        headers: { "X-Trace-Id": "trace-1", "Access-Control-Expose-Headers": "X-Trace-Id" },
        body: JSON.stringify({ secret: S }),
      }),
  }, `/start/${S}?q=${S}`);
  await page.context().addCookies([{ name: "c", value: S, url: "https://app.test" }]);
  await init(page, { clickSettleMs: 100, release: "web-1.2.3" });
  await page.evaluate(() => (window as any).handle.snapshot());
  await page.fill("#field", `${S} typed`);
  await page.locator("#editor").pressSequentially(`${S}`);
  await page.selectOption("#pick", S);
  await page.click("#go");
  await page.click("#private");
  // The link is clicked but its navigation is cancelled, so the page and sink survive.
  await page.evaluate(() => document.getElementById("link")!.addEventListener("click", (e) => e.preventDefault()));
  await page.click("#link");
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as any).handle.snapshot());
  const out = await output(page);
  expectValid(out);
  // Something substantial was captured.
  const types = new Set(events(out).map((e) => e.type));
  for (const type of ["ui.snapshot", "ui.click.settled", "request.started", "request.completed", "interaction.started"])
    expect(types, type).toContain(type);
  expect(out.snapshots.length).toBeGreaterThanOrEqual(2);
  const everything = [...out.serialized, ...out.snapshots.map((s) => s.serialized), ...out.snapshots.map((s) => s.sha256)].join("\n");
  expect(everything.toLowerCase()).not.toContain(S.toLowerCase());
  expect(everything).not.toContain("typed");
  // With no routeSegments allowlist every path segment is collapsed.
  const routes = new Set(
    [...events(out).map((e) => e.data.route_template), ...out.snapshots.map((s) => s.body.route_template)].filter(Boolean),
  );
  expect([...routes].sort()).toEqual(["/:id/:id"]);
  expect(out.batches[0].release).toBe("web-1.2.3");
});

// Lowercase slugs look like route words, so only an explicit allowlist keeps a segment.
const SLUGS = ["jane-smith", "acme-corp", "my-secret-post"];

for (const routeSegments of [undefined, ["u", "projects", "blog"]]) {
  test(`lowercase path slugs never reach the sink (${routeSegments ? "with" : "without"} routeSegments)`, async ({ page }) => {
    await openPage(
      page,
      `<button data-testid="next" id="next">Next</button>
       <script>
         const paths = ["/acme-corp/projects", "/blog/my-secret-post"];
         document.getElementById("next").addEventListener("click", () => {
           history.pushState({}, "", paths.shift() ?? "/u/jane-smith#acme-corp");
           return fetch("/api/projects/acme-corp?owner=jane-smith");
         });
       </script>`,
      { api: (route) => route.fulfill({ contentType: "application/json", body: "{}" }) },
      "/u/jane-smith",
    );
    await init(page, { clickSettleMs: 50, routeSettleMs: 20, ...(routeSegments ? { routeSegments } : {}) });
    await expect.poll(async () => (await output(page)).snapshots.length).toBe(1);
    for (let i = 1; i <= 3; i++) {
      await page.click("#next");
      await expect.poll(async () => events(await output(page)).filter((e) => e.type === "ui.click.settled").length).toBe(i);
    }
    await page.evaluate(() => (window as any).handle.snapshot());
    const out = await output(page);
    expectValid(out);
    const everything = [...out.serialized, ...out.snapshots.map((s) => s.serialized)].join("\n");
    for (const slug of SLUGS) expect(everything, slug).not.toContain(slug);
    const routes = new Set(events(out).map((e) => e.data.route_template).filter(Boolean));
    expect([...routes].sort()).toEqual(
      routeSegments ? ["/:id/projects", "/blog/:id", "/u/:id"] : ["/:id/:id"],
    );
  });
}

// Test IDs built from data: a record UUID, a domain and a counter. Static ones survive.
const DATA_IDS = ["row-3f2a9c1e-7b4d-4e8a-9c21-5d6e7f809a1b", "domain-row-acme.com", "item-42"];
const STATIC_IDS = ["save-button", "nav:settings"];

/**
 * Five buttons pushed off the left edge, each clicked once. Each is an
 * offscreen_control finding; buttons without a test ID share one structural
 * stable_id and so one fingerprint, sent once.
 */
async function testIdRun(page: Page, testId?: "keep-all") {
  const ids = [...DATA_IDS, ...STATIC_IDS];
  await openPage(
    page,
    ids
      .map((id, i) => `<button data-testid="${id}" style="position:absolute;left:-300px;top:${20 + i * 40}px;width:120px;height:32px">Go</button>`)
      .join(""),
  );
  await page.evaluate((keepAll) => {
    const w = window as any;
    w.handle = w.CodepressInteractions.initInteractions({
      sink: w.sink,
      flushIntervalMs: 3_600_000,
      routeSettleMs: 3_600_000,
      clickSettleMs: 50,
      ...(keepAll ? { testId: (value: string) => value } : {}),
    });
  }, testId === "keep-all");
  await page.evaluate(() => (window as any).handle.snapshot());
  await page.evaluate(() => document.querySelectorAll("button").forEach((button) => button.click()));
  await expect.poll(async () => events(await output(page)).filter((e) => e.type === "ui.click.settled").length).toBe(5);
  await expect.poll(async () => events(await output(page)).filter((e) => e.type === "ui.finding").length).toBe(testId ? 5 : 3);
  const out = await output(page);
  expectValid(out);
  return {
    dictionary: out.snapshots[0].body.dictionaries.test_id as string[],
    controlIds: events(out).filter((e) => e.type === "interaction.started").map((e) => e.data.control_id as string),
    stableIds: events(out).filter((e) => e.type === "ui.finding").map((e) => e.data.subject.stable_id as string),
    everything: [...out.serialized, ...out.snapshots.map((s) => s.serialized)].join("\n"),
  };
}

test("test IDs carrying data stay out of the snapshot, control_id and finding stable_id by default", async ({ page }) => {
  const run = await testIdRun(page);
  expect([...run.dictionary].sort()).toEqual([...STATIC_IDS].sort());
  expect(run.controlIds.filter((id) => STATIC_IDS.includes(id)).sort()).toEqual([...STATIC_IDS].sort());
  expect(run.stableIds.filter((id) => STATIC_IDS.includes(id)).sort()).toEqual([...STATIC_IDS].sort());
  // The three data-bearing IDs fall back to one structural path: one finding, not three.
  expect(run.stableIds.filter((id) => !STATIC_IDS.includes(id))).toEqual(["html/body/button"]);
  expect(run.controlIds.filter((id) => !STATIC_IDS.includes(id))).toEqual(["body/button", "body/button", "body/button"]);
  for (const id of [...DATA_IDS, "acme"]) expect(run.everything, id).not.toContain(id);
});

test("a testId hook replaces the default filter", async ({ page }) => {
  const run = await testIdRun(page, "keep-all");
  for (const id of [...DATA_IDS, ...STATIC_IDS]) {
    expect(run.dictionary, id).toContain(id);
    expect(run.controlIds, id).toContain(id);
    expect(run.stableIds, id).toContain(id);
  }
});

for (const [name, write] of [
  ["a constant aria-busy", 'element.setAttribute("aria-busy", "false")'],
  ["a toggled aria-busy", 'element.setAttribute("aria-busy", String(element.getAttribute("aria-busy") !== "true"))'],
  ["a toggled disabled", 'element.toggleAttribute("disabled")'],
]) {
  test(`a testId hook that writes ${name} leaves the page responsive`, async ({ page }) => {
    await openPage(page, `<button data-testid="save-button">Go</button><p id="alive">alive</p>`);
    await page.evaluate((write) => {
      const w = window as any;
      w.calls = 0;
      const apply = (0, eval)(`(element) => { ${write}; }`);
      w.handle = w.CodepressInteractions.initInteractions({
        sink: w.sink,
        flushIntervalMs: 3_600_000,
        routeSettleMs: 3_600_000,
        testId: (value: string, element: Element) => {
          w.calls++;
          apply(element);
          return value;
        },
      });
      // Not awaited: a frozen page must fail the check below, not this call.
      void w.handle.snapshot();
    }, write);
    await page.waitForTimeout(300);
    const answer = page.evaluate(() => [document.getElementById("alive")!.textContent, (window as any).calls]);
    const frozen = new Promise<string>((resolve) => setTimeout(() => resolve("frozen"), 3000));
    const result = await Promise.race([answer, frozen]);
    expect(result).not.toBe("frozen");
    expect((result as [string, number])[1]).toBeLessThanOrEqual(2);
  });
}

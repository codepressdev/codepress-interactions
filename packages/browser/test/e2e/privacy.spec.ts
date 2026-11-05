import { expect, test } from "@playwright/test";
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
  // The route template keeps lowercase words and drops IDs and queries.
  const routes = new Set(
    [...events(out).map((e) => e.data.route_template), ...out.snapshots.map((s) => s.body.route_template)].filter(Boolean),
  );
  expect([...routes].sort()).toEqual(["/account/:id", "/start/:id"]);
  expect(out.batches[0].release).toBe("web-1.2.3");
});

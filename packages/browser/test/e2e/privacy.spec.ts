import { buildSync } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

// Colours and names are read in the page for contrast and accessible names; only numbers and booleans may leave it.
const COLOURS = ["#1a2b3c", "rgb(26, 43, 60)", "26, 43, 60", "#d4c5b6", "212, 197, 182", "rgba(9, 8, 7, 0.5)", "9, 8, 7"];

test("colour values, labels and names read for the a11y checks appear nowhere in sink output", async ({ page }) => {
  await openPage(
    page,
    `<main style="background:#d4c5b6;padding:16px">
       <p style="color:#1a2b3c">${S} readable paragraph</p>
       <p style="color:#c9bbac">${S} faint paragraph</p>
       <div style="background:rgba(9, 8, 7, 0.5)"><span style="color:#0f0e0d">${S} overlay</span></div>
       <label for="mail">${S} label text</label><input id="mail">
       <span id="labeller">${S} labelled-by text</span><button aria-labelledby="labeller">x</button>
       <button aria-label="${S} aria name"><svg width="10" height="10"></svg></button>
       <button title=" "><svg width="10" height="10"></svg></button>
       <a href="#"><img alt="${S} alt name" width="10" height="10" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a>
     </main>`,
  );
  await init(page);
  await page.evaluate(() => (window as any).handle.snapshot());
  await expect.poll(async () => events(await output(page)).filter((e) => e.type === "ui.finding").length).toBeGreaterThanOrEqual(2);
  const out = await output(page);
  expectValid(out);
  const checks = events(out).filter((e) => e.type === "ui.finding").map((e) => e.data.check);
  expect(checks).toContain("a11y.low_contrast");
  expect(checks).toContain("a11y.unnamed_control");
  const body = out.snapshots[0].body;
  expect(body.contrast.element.length).toBeGreaterThanOrEqual(1);
  // Contrast and name tables hold numbers and booleans only.
  for (const table of [body.contrast, body.unnamed_controls])
    for (const column of Object.values(table) as unknown[][])
      for (const value of column) expect(["number", "boolean"]).toContain(typeof value);
  const everything = [...out.serialized, ...out.snapshots.map((s) => s.serialized)].join("\n");
  expect(everything.toLowerCase()).not.toContain(S.toLowerCase());
  for (const colour of COLOURS) expect(everything, colour).not.toContain(colour);
  for (const word of ["rgb", "rgba", "#1a2b3c", "color("]) expect(everything.toLowerCase(), word).not.toContain(word);
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

test("data-layout-allow-overlap values never reach a batch or snapshot", async ({ page }) => {
  // Names that match an element (whose own test ID the filter drops), match nothing, or are free text.
  await openPage(
    page,
    `<div style="position:relative;margin:40px;height:120px">
       <div data-testid="${S}-avatar" style="position:absolute;left:0;top:0;width:48px;height:48px;background:#ccc"></div>
       <span data-testid="badge" data-layout-allow-overlap="${S}-avatar ${S}-missing" style="position:absolute;left:38px;top:-6px;width:16px;height:16px;background:red"></span>
       <div data-layout-allow-overlap="${S} free text ${S}@example.com" style="position:absolute;left:0;top:60px;width:48px;height:48px;background:#ccc"></div>
       <button data-testid="edit" data-layout-allow-overlap="*" style="position:absolute;left:30px;top:60px;width:60px;height:30px">Edit</button>
     </div>`,
  );
  await init(page);
  await page.evaluate(() => (window as any).handle.snapshot());
  await page.click('[data-testid="edit"]');
  await page.waitForTimeout(200);
  const out = await output(page);
  expectValid(out);
  expect(out.snapshots.length).toBeGreaterThanOrEqual(1);
  // The marker did take effect: the badge's pair was resolved in the page.
  expect(out.snapshots[0].body.allow_overlap.element.length).toBeGreaterThan(0);
  const everything = [...out.serialized, ...out.snapshots.map((s) => s.serialized)].join("\n");
  for (const value of [S.toLowerCase(), "missing", "free text", "example.com", "data-layout-allow-overlap"])
    expect(everything.toLowerCase(), value).not.toContain(value);
});

for (const [name, write] of [
  ["a constant aria-busy", 'element.setAttribute("aria-busy", "false")'],
  ["a toggled aria-busy", 'element.setAttribute("aria-busy", String(element.getAttribute("aria-busy") !== "true"))'],
  ["a toggled disabled", 'element.toggleAttribute("disabled")'],
  [
    "an alternating ID and aria-busy",
    'element.setAttribute("data-testid", window.calls % 2 ? "save-button" : "save-action"); element.setAttribute("aria-busy", String(window.calls % 2 === 0))',
  ],
  [
    "a new busy element",
    'const added = document.createElement("div"); added.setAttribute("aria-busy", "true"); added.setAttribute("data-testid", "added-region"); document.body.append(added)',
  ],
  [
    "a busy clone of itself",
    'const clone = element.cloneNode(true); clone.setAttribute("aria-busy", "true"); element.replaceWith(clone)',
  ],
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
    expect((result as [string, number])[1]).toBeLessThanOrEqual(10);
  });
}

test("tooltip text, class names and styles seen on hover and focus never reach the sink", async ({ page }) => {
  await openPage(
    page,
    `<style>.btn-${S}:hover { background: rgb(1, 2, 3); } .btn-${S}:focus-visible { outline: none; }</style>
     <button id="tipped" class="btn-${S}" aria-describedby="tip-${S}" style="margin:40px">${S} help</button>
     <button id="bare" class="btn-${S}" data-note="${S}">${S} bare</button>
     <script>
       const tipped = document.getElementById("tipped");
       const show = () => {
         const tip = document.createElement("div");
         tip.id = "tip-${S}";
         tip.className = "tip-${S}";
         tip.setAttribute("role", "tooltip");
         tip.setAttribute("aria-label", "${S} label");
         tip.style.cssText = "position:absolute;left:10px;top:90px;font-family:${S}";
         tip.textContent = "${S} tooltip text";
         document.body.append(tip);
         tipped.classList.add("open-${S}");
         tipped.setAttribute("aria-expanded", "true");
       };
       tipped.addEventListener("mouseenter", show);
       tipped.addEventListener("focus", show);
       const hide = () => { document.getElementById("tip-${S}")?.remove(); tipped.classList.remove("open-${S}"); };
       tipped.addEventListener("mouseleave", hide);
       tipped.addEventListener("blur", hide);
     </script>`,
    {},
    `/help/${S}`,
  );
  await init(page, { hoverSettleMs: 150 });
  await page.mouse.move(5, 5);
  await page.hover("#tipped");
  await expect.poll(async () => events(await output(page)).filter((e) => e.type === "ui.hover.settled").length).toBe(1);
  await page.mouse.move(5, 300);
  await page.keyboard.press("Tab");
  await expect.poll(async () => events(await output(page)).filter((e) => e.type === "ui.hover.settled").length).toBe(2);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(300);
  const out = await output(page);
  expectValid(out);
  const hovers = events(out).filter((e) => e.type === "ui.hover.settled");
  expect(hovers.map((e) => e.data.kind)).toEqual(["pointer", "focus"]);
  for (const hover of hovers)
    expect(hover.data).toMatchObject({ overlay_opened: true, class_changed: true, expanded_changed: true });
  expect(out.snapshots.length).toBeGreaterThanOrEqual(1);
  expect(events(out).some((e) => e.type === "ui.finding" && e.data.check === "a11y.no_focus_indicator")).toBe(true);
  const everything = [...out.serialized, ...out.snapshots.map((s) => s.serialized)].join("\n");
  expect(everything.toLowerCase()).not.toContain(S.toLowerCase());
  for (const text of ["tooltip text", "rgb(1, 2, 3)", "font-family", "outline"]) expect(everything).not.toContain(text);
});

// The page script as @codepress/interactions-playwright injects it.
const pageScript = buildSync({
  entryPoints: [resolve(dirname(fileURLToPath(import.meta.url)), "../../src/page-script.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  write: false,
}).outputFiles[0].text;

test("a hover and focus sweep returns no tooltip text, class names, attribute values or data-bearing test IDs", async ({ page }) => {
  await openPage(
    page,
    `<style>
       .wrap-${S} { position: relative; display: inline-block; margin: 40px }
       .tip-${S} { position: absolute; top: 40px; left: 0; width: 200px; visibility: hidden; font-family: ${S} }
       .btn-${S}:hover + .tip-${S} { visibility: visible }
     </style>
     <span class="wrap-${S}"><button class="btn-${S}" data-testid="row-${S}-42" aria-label="${S} label" title="${S} title">${S} help</button><span class="tip-${S}" role="tooltip">${S} tooltip text</span></span>
     <a href="/orders?q=${S}" data-testid="orders" class="btn-${S}">${S} link</a><span class="tip-${S}">${S} more</span>
     <input value="${S}-value" data-testid="search-${S}.com" placeholder="${S}">`,
    {},
    `/help/${S}`,
  );
  const results = await page.evaluate(async (script) => {
    (0, eval)(script);
    const api = (globalThis as any).__codepressInteractions;
    const sweep = api.sweep({ settleMs: 50 });
    const { elements, total } = sweep.controls(10);
    const out: unknown[] = [total];
    for (const element of elements) {
      out.push(sweep.controlId(element), sweep.away());
      sweep.arm(element);
      element.dispatchEvent(new PointerEvent("pointerover", { pointerType: "mouse", bubbles: true, clientX: 50, clientY: 50 }));
      out.push(await sweep.hovered(element));
      sweep.arm(element);
      out.push(await sweep.focus(element));
      sweep.blur(element);
    }
    sweep.stop();
    return out;
  }, pageScript);
  const serialized = JSON.stringify(results);
  // Something was swept: three controls, test IDs kept or dropped by the default filter.
  expect(results[0]).toBe(3);
  expect(serialized).toContain('"orders"');
  expect(serialized).toContain('"reached":true');
  expect(serialized.toLowerCase()).not.toContain(S.toLowerCase());
  for (const text of ["tooltip text", "font-family", "label", "title"]) expect(serialized).not.toContain(text);
});

test("motion findings carry no animation names, property names or values, or text", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openPage(
    page,
    `<style>
      @keyframes ${S}-drop{from{padding-top:0;transform:translateY(-${S.length}px)}to{padding-top:20px;transform:none}}
      .${S}-box{position:relative;width:700px;height:400px;background:#ddd;transition:margin-left 400ms}
      .${S}-box.on{margin-left:13px;animation:${S}-drop 400ms 1}
    </style>
    <div class="${S}-box" id="box" title="${S} title" aria-label="${S} label">${S} animated text</div>`,
  );
  await init(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const box = document.getElementById("box")!;
        let left = 2;
        const done = () => --left === 0 && resolve();
        box.addEventListener("animationend", done, { once: true });
        box.addEventListener("transitionend", done, { once: true });
        box.classList.add("on");
      }),
  );
  await expect
    .poll(async () => events(await output(page)).filter((e) => e.type === "ui.finding").map((e) => e.data.check).sort())
    .toEqual(["a11y.reduced_motion_ignored", "motion.layout_animation"]);
  const out = await output(page);
  expectValid(out);
  const everything = out.serialized.join("\n");
  expect(everything.toLowerCase()).not.toContain(S.toLowerCase());
  for (const name of ["margin-left", "marginLeft", "padding-top", "paddingTop", "translateY", "drop", "13px", "20px"])
    expect(everything, name).not.toContain(name);
});

test("effect contracts: item keys, target test IDs, states, field IDs and values reach no batch, snapshot or sessionStorage", async ({ page }) => {
  // A Remove that does nothing, a Connect that holds until a reload, and a Save the reload undoes.
  const body = `
    <ul>
      <li data-interaction-item="${S}-key" data-testid="row-${S}">${S} row
        <button data-testid="remove-row" data-interaction-removes>Remove</button></li>
    </ul>
    <button data-testid="discard" data-interaction-removes="banner-${S}">Discard</button>
    <div data-testid="banner-${S}">${S} banner</div>
    <div data-testid="conn-${S}" data-state="${S}-off">${S} connection</div>
    <button data-testid="connect" data-interaction-sets="conn-${S}:data-state=${S}-on">Connect</button>
    <input data-testid="field-${S}" id="field" value="${S} old value">
    <button data-testid="save-profile" data-interaction-saves="field-${S}">Save</button>
    <script>
      const by = (id) => document.querySelector('[data-testid="' + id + '"]');
      by("remove-row").addEventListener("click", () => fetch("/api/remove", { method: "POST" }));
      by("discard").addEventListener("click", () => { by("banner-${S}").remove(); return fetch("/api/discard", { method: "POST" }); });
      by("connect").addEventListener("click", async () => {
        await fetch("/api/connect", { method: "POST" });
        by("conn-${S}").dataset.state = "${S}-on";
      });
      by("save-profile").addEventListener("click", () => fetch("/api/save", { method: "POST" }));
    </script>`;
  await openPage(page, body);
  await init(page, { clickSettleMs: 100 });
  await page.evaluate(() => (window as any).handle.snapshot());
  await page.fill("#field", `${S} typed value`);
  const settledCount = async () => events(await output(page)).filter((e) => e.type === "ui.click.settled").length;
  for (const [i, id] of ["remove-row", "discard", "connect", "save-profile"].entries()) {
    await page.click(`[data-testid="${id}"]`);
    await expect.poll(settledCount).toBe(i + 1);
  }
  const first = await output(page);
  const stored = (await page.evaluate(() => sessionStorage.getItem("codepress-interactions:effects")))!;
  // Discard, Connect and Save held at settle and wait for the next load.
  expect(JSON.parse(stored)).toHaveLength(3);
  const storage = await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)));
  await page.reload();
  await init(page, { clickSettleMs: 100 });
  await page.evaluate(() => (window as any).handle.snapshot());
  await expect.poll(async () => events(await output(page)).filter((e) => e.type === "ui.finding" && e.data.check === "click.effect_not_applied").length).toBe(3);
  const second = await output(page);
  expectValid(first);
  expectValid(second);
  const checks = (out: typeof first) =>
    events(out).filter((e) => e.type === "ui.finding" && e.data.check === "click.effect_not_applied").map((e) => e.data.control_id).sort();
  expect(checks(first)).toEqual(["remove-row"]);
  expect(checks(second)).toEqual(["connect", "discard", "save-profile"]);
  const sent = [first, second].flatMap((out) => [...out.serialized, ...out.snapshots.map((s) => s.serialized)]).join("\n");
  for (const text of [sent, storage]) {
    expect(text.toLowerCase()).not.toContain(S.toLowerCase());
    expect(text).not.toContain("typed");
    expect(text).not.toContain("old value");
  }
  // The stored hashes and salt stay in the page.
  const hashes = stored.match(/[0-9a-f]{32}/g) ?? [];
  expect(hashes.length).toBeGreaterThanOrEqual(6);
  for (const digest of hashes) expect(sent, digest).not.toContain(digest);
});

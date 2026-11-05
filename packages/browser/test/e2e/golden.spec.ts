/**
 * Regenerates protocol/v2-batch.json and protocol/v2-snapshot.json from a real
 * browser run: `UPDATE_GOLDEN=1 pnpm --filter @codepress/interactions-browser test:browser golden`.
 * IDs and timestamps are replaced with fixed values so the files are stable.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { events, init, openPage, output, rowOf, validateBatch, validateSnapshot } from "./harness";

const protocol = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../protocol");

test.skip(!process.env.UPDATE_GOLDEN, "set UPDATE_GOLDEN=1 to regenerate the golden fixtures");

test("regenerate golden fixtures", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await openPage(
    page,
    `<header data-testid="toolbar" style="position:sticky;top:0;height:48px;background:#eee;z-index:1">
       <button data-testid="checkout.pay" style="position:absolute;left:16px;top:8px;width:160px;height:32px">Pay now</button>
       <div data-testid="promo.banner" style="position:absolute;left:120px;top:4px;width:140px;height:40px;background:#fc0"></div>
     </header>
     <main style="padding:16px">
       <h1>Checkout</h1>
       <p style="width:240px">Your order ships in two to three business days.</p>
       <button data-testid="checkout.save" id="save">Save</button>
     </main>
     <script>
       document.getElementById("save").addEventListener("click", async () => {
         await fetch("/api/cart", { method: "POST" });
         document.querySelector("h1").textContent = "Saved";
       });
     </script>`,
    {
      api: (route) =>
        route.fulfill({ contentType: "application/json", headers: { "X-Trace-Id": "4bf92f3577b34da6" }, body: "{}" }),
    },
    "/checkout/8f14e45f",
  );
  await page.evaluate(() => {
    const w = window as any;
    w.handle = w.CodepressInteractions.initInteractions({
      sink: w.sink,
      flushIntervalMs: 3_600_000,
      routeSettleMs: 3_600_000,
      clickSettleMs: 100,
      release: "shop-web@1.8.0",
      requestLabel: (url: URL, init?: RequestInit) => `cart.${(init?.method ?? "GET").toLowerCase()}`,
    });
  });
  await page.evaluate(() => (window as any).handle.snapshot());
  await page.click("#save");
  await expect.poll(async () => events(await output(page)).some((e) => e.type === "ui.click.settled")).toBe(true);
  const out = await output(page);
  const golden = out.snapshots[0];
  const body = golden.body;
  expect(JSON.stringify(body)).toBe(golden.serialized);
  expect(validateSnapshot(body)).toBe(true);

  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const ids = new Map<string, string>();
  const fixed = (value: string | null) => {
    if (!value) return value;
    if (!ids.has(value)) ids.set(value, uuid(100 + ids.size));
    return ids.get(value)!;
  };
  const picked = events(out).filter(
    (e) =>
      ["interaction.started", "request.started", "request.completed", "ui.click.settled", "perf.summary"].includes(e.type) ||
      (e.type === "ui.snapshot" && e.data.sha256 === golden.sha256),
  );
  const subject = rowOf(body, "checkout.pay");
  const other = rowOf(body, "promo.banner");
  const ref = (row: number) => ({
    index: row,
    tag: body.dictionaries.tag[body.elements.tag[row]],
    role: body.elements.role[row] === -1 ? null : body.dictionaries.role[body.elements.role[row]],
    test_id: body.dictionaries.test_id[body.elements.test_id[row]],
    x: body.elements.x[row],
    y: body.elements.y[row],
    width: body.elements.width[row],
    height: body.elements.height[row],
    position: body.legend.position[body.elements.position[row]],
    z_index: body.elements.z_index[row],
  });
  const hit = body.hit_tests.element.indexOf(subject);
  const finding = {
    event_id: "",
    schema_version: 2,
    interaction_id: null,
    operation_id: null,
    source: "browser",
    source_instance_id: picked[0].source_instance_id,
    sequence: 0,
    occurred_at: "",
    type: "ui.finding",
    attribution: "inferred",
    data: {
      check: "hit.blocked",
      check_version: 1,
      fingerprint: "9c1185a5c5e9fc54",
      route_template: body.route_template,
      snapshot_sha256: golden.sha256,
      viewport_width: body.viewport.width,
      viewport_height: body.viewport.height,
      subject: ref(subject),
      other: ref(other),
      evidence: {
        blocked_points: body.hit_tests.blocked[hit],
        tested_points: body.hit_tests.tested[hit],
        overlap_px: 2560,
        overlap_ratio: 0.5,
        text_overlap_px: 0,
        same_stacking_context: true,
      },
    },
  };
  const all = [...picked, finding].map((event, index) => ({
    ...event,
    event_id: uuid(index + 1),
    interaction_id: fixed(event.interaction_id),
    source_instance_id: "browser-golden",
    sequence: index + 1,
    occurred_at: new Date(Date.UTC(2026, 10, 1, 12, 0, 0, index * 50)).toISOString(),
  }));
  const batch = {
    batch_id: uuid(1),
    schema_version: 2,
    sdk_version: out.batches[0].sdk_version,
    release: "shop-web@1.8.0",
    events: all,
  };
  expect(validateBatch(batch), JSON.stringify(validateBatch.errors)).toBe(true);
  writeFileSync(resolve(protocol, "v2-snapshot.json"), JSON.stringify(body, null, 2) + "\n");
  writeFileSync(resolve(protocol, "v2-batch.json"), JSON.stringify(batch, null, 2) + "\n");
});

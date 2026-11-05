import { expect, test } from "@playwright/test";
import { APP, events, expectValid, init, openPage, output, validateBatch } from "./harness";

const settled = (out: Parameters<typeof events>[0]) =>
  events(out).filter((e) => e.type === "ui.click.settled");

const PAGE = `
<button data-testid="save" id="save">Save</button>
<button data-testid="slow" id="slow">Slow</button>
<button data-testid="dead" id="dead">Nothing</button>
<button data-testid="open" id="open">Open</button>
<input data-testid="name" id="name">
<div id="out"></div>
<script>
  document.getElementById("save").addEventListener("click", async () => {
    await new Promise((r) => setTimeout(r, 30));
    document.getElementById("out").textContent = "saved";
    await fetch("/api/save", { method: "POST" });
  });
  document.getElementById("slow").addEventListener("click", () => {
    fetch("/api/slow");
  });
  document.getElementById("open").addEventListener("click", () => {
    const d = document.createElement("div");
    d.setAttribute("role", "dialog");
    document.body.append(d);
    document.getElementById("name").focus();
  });
</script>`;

const api = async (route: import("@playwright/test").Route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === "/api/slow") await new Promise((r) => setTimeout(r, 400));
  await route.fulfill({ contentType: "application/json", body: "{}" });
};

test("click follow-through reports feedback, requests, settle time and before/after screens", async ({ page }) => {
  await openPage(page, PAGE, { api });
  await init(page, { clickSettleMs: 150 });
  const before = await page.evaluate(() => (window as any).handle.snapshot());
  await page.click("#save");
  await expect.poll(async () => settled(await output(page)).length).toBe(1);
  await page.click("#dead");
  await expect.poll(async () => settled(await output(page)).length).toBe(2);
  await page.click("#open");
  await expect.poll(async () => settled(await output(page)).length).toBe(3);
  const out = await output(page);
  expectValid(out);
  const [save, dead, open] = settled(out);
  const started = events(out).filter((e) => e.type === "interaction.started");
  expect(save.interaction_id).toBe(started.find((e) => e.data.control_id === "save").interaction_id);
  expect(save.attribution).toBe("inferred");
  expect(save.data).toMatchObject({
    control_id: "save",
    request_count: 1,
    request_failed_count: 0,
    overlapped: false,
    incomplete: false,
    end_reason: "settled",
    before_sha256: before.sha256,
    route_changed: false,
  });
  expect(save.data.first_feedback_ms).toBeGreaterThan(0);
  expect(save.data.settle_ms).toBeGreaterThanOrEqual(save.data.first_feedback_ms);
  expect(save.data.mutation_count).toBeGreaterThan(0);
  expect(save.data.after_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(save.data.after_sha256).not.toBe(before.sha256);
  // A click with no effect: no feedback, nothing counted.
  expect(dead.data).toMatchObject({
    control_id: "dead",
    first_feedback_ms: null,
    mutation_count: 0,
    request_count: 0,
    end_reason: "settled",
    settle_ms: 0,
  });
  expect(open.data).toMatchObject({ dialog_opened: true, focus_moved: true });
  // Request events themselves stay unattributed: the click link is only inferred.
  const request = events(out).find((e) => e.type === "request.started");
  expect(request.interaction_id).toBeNull();
  expect(request.attribution).toBe("unknown");
});

test("a second click before settling marks the first overlapped without sharing counts", async ({ page }) => {
  await openPage(page, PAGE, { api });
  await init(page, { clickSettleMs: 150 });
  await page.click("#slow");
  await page.waitForTimeout(50);
  await page.click("#save");
  await expect.poll(async () => settled(await output(page)).length).toBe(2);
  const out = await output(page);
  expectValid(out);
  const [first, second] = settled(out);
  expect(first.data).toMatchObject({ control_id: "slow", overlapped: true, end_reason: "overlapped", request_count: 1, after_sha256: null });
  expect(second.data).toMatchObject({ control_id: "save", overlapped: true, end_reason: "settled", request_count: 1 });
  expect(first.interaction_id).not.toBe(second.interaction_id);
  // The slow request completing during the second click is not counted there as a failure or new request.
  expect(first.data.request_count + second.data.request_count).toBe(2);
});

test("navigating away before settling reports the click incomplete", async ({ page }) => {
  // Requests sent while a document unloads are invisible to Playwright, so this
  // sink persists each batch synchronously in sessionStorage instead.
  await openPage(page, PAGE, { api });
  await page.evaluate(() => {
    const w = window as any;
    const sink = {
      sendBatch(_batch: unknown, serialized: string, context: { keepalive: boolean }) {
        const saved = JSON.parse(sessionStorage.getItem("batches") ?? "[]");
        saved.push({ serialized, keepalive: context.keepalive });
        sessionStorage.setItem("batches", JSON.stringify(saved));
      },
      sendSnapshot() {},
    };
    w.handle = w.CodepressInteractions.initInteractions({
      sink,
      flushIntervalMs: 3_600_000,
      routeSettleMs: 3_600_000,
      clickSettleMs: 5000,
    });
  });
  await page.click("#slow");
  await page.goto(`${APP}/next`);
  const saved: { serialized: string; keepalive: boolean }[] = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("batches") ?? "[]"),
  );
  const batches = saved.map((entry) => JSON.parse(entry.serialized));
  for (const batch of batches) expect(validateBatch(batch), JSON.stringify(validateBatch.errors)).toBe(true);
  expect(saved.every((entry) => entry.keepalive)).toBe(true);
  const clicks = batches.flatMap((b) => b.events).filter((e: any) => e.type === "ui.click.settled");
  expect(clicks).toHaveLength(1);
  expect(clicks[0].data).toMatchObject({ control_id: "slow", incomplete: true, end_reason: "page_hidden", after_sha256: null, request_count: 1 });
});

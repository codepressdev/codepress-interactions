import { expect, test } from "@playwright/test";
import { expectValid, init, openPage, output, rowOf } from "./harness";

const hitOf = (body: any, testId: string) => {
  const row = rowOf(body, testId);
  const at = body.hit_tests.element.indexOf(row);
  expect(at, `hit test for ${testId}`).toBeGreaterThanOrEqual(0);
  return {
    tested: body.hit_tests.tested[at],
    blocked: body.hit_tests.blocked[at],
    points: body.hit_tests.points[at],
    top: body.hit_tests.top[at],
  };
};

test("hit test reports points blocked by a sibling, not by a pointer-events:none decoration", async ({ page }) => {
  await openPage(
    page,
    `<div style="position:relative;margin:40px;width:400px;height:200px">
      <button data-testid="half" style="position:absolute;left:0;top:0;width:200px;height:40px">Pay</button>
      <div data-testid="cover" style="position:absolute;left:110px;top:0;width:120px;height:40px;background:rgba(0,0,0,.2)"></div>
      <button data-testid="decorated" style="position:absolute;left:0;top:80px;width:200px;height:40px">Save</button>
      <div data-testid="decoration" style="position:absolute;left:0;top:80px;width:200px;height:40px;pointer-events:none;background:rgba(255,0,0,.2)"></div>
      <button data-testid="clear" style="position:absolute;left:0;top:140px;width:200px;height:40px"><span>Clear</span></button>
    </div>`,
  );
  await init(page);
  await page.evaluate(() => (window as any).handle.snapshot());
  const out = await output(page);
  expectValid(out);
  const body = out.snapshots[0].body;

  const half = hitOf(body, "half");
  expect(half.tested).toBe(5);
  // Right inset points (75%: x=150) are under the cover (x >= 110); center (x=100) and left are not.
  expect(half.blocked).toBe(2);
  const names: string[] = body.legend.hit_points;
  const blockedNames = names.filter((_, bit) => half.points & (1 << bit));
  expect(blockedNames).toEqual(["top_right", "bottom_right"]);
  expect(half.top).toBe(rowOf(body, "cover"));

  const decorated = hitOf(body, "decorated");
  expect(decorated).toMatchObject({ tested: 5, blocked: 0, points: 0, top: -1 });
  expect(body.elements.flags[rowOf(body, "decoration")] & body.legend.flags.pointer_events_none).not.toBe(0);

  // A child of the control is not "on top of" it.
  expect(hitOf(body, "clear")).toMatchObject({ tested: 5, blocked: 0 });
  // elementFromPoint is only used for interactive elements.
  expect(body.hit_tests.element.every((row: number) => body.elements.flags[row] & body.legend.flags.interactive)).toBe(true);
});

test("text box covers wrapped text exactly and carries no text", async ({ page }) => {
  const words = "Zephyrine quokkas juxtapose wobbly xylophones beneath vermilion lanterns".split(" ");
  await openPage(
    page,
    `<p data-testid="wrapped" style="width:120px;margin:20px;font-size:16px">${words.join(" ")}</p>
     <div data-testid="boxed" style="width:300px;height:60px;padding:20px"><span data-testid="short">Hi</span></div>
     <div data-testid="over" style="position:absolute;left:200px;top:120px;width:160px;height:40px;background:#0003"></div>`,
  );
  await init(page);
  await page.evaluate(() => (window as any).handle.snapshot());
  const out = await output(page);
  expectValid(out);
  const body = out.snapshots[0].body;
  const expected = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="wrapped"]')!;
    const range = document.createRange();
    range.selectNodeContents(p.firstChild!);
    const r = range.getBoundingClientRect();
    const tops = new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top)));
    const box = p.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, lines: tops.size, boxWidth: box.width };
  });
  expect(expected.lines).toBeGreaterThan(2);
  const row = rowOf(body, "wrapped");
  const at = body.text_boxes.element.indexOf(row);
  expect(at).toBeGreaterThanOrEqual(0);
  for (const key of ["x", "y", "width", "height"] as const)
    expect(Math.abs(body.text_boxes[key][at] - expected[key]), key).toBeLessThanOrEqual(0.005);
  expect(body.text_boxes.lines[at]).toBe(expected.lines);
  expect(body.text_boxes.width[at]).toBeLessThanOrEqual(expected.boxWidth + 0.01);
  expect(body.elements.text_length[row]).toBe(words.join(" ").length);

  // The element box is far larger than its text: overlap with the box need not touch the text.
  const boxed = rowOf(body, "short");
  const shortText = body.text_boxes.element.indexOf(boxed);
  expect(body.text_boxes.width[shortText]).toBeLessThan(body.elements.width[rowOf(body, "boxed")]);
  // Elements without direct text have no text box.
  expect(body.text_boxes.element).not.toContain(rowOf(body, "boxed"));

  const serialized = out.snapshots[0].serialized + out.serialized.join("");
  for (const word of [...words, ">Hi<", "\"Hi\""]) expect(serialized).not.toContain(word);
});

test("DOM mutated during a multi-slice walk marks the snapshot torn", async ({ page }) => {
  await openPage(page, `<div id="list">${'<div style="height:2px"><span></span></div>'.repeat(3000)}</div>`);
  await init(page, { maxSliceMs: 1, maxElements: 10000 });
  const result = await page.evaluate(async () => {
    const w = window as any;
    const quiet = await w.handle.snapshot();
    const pending = w.handle.snapshot();
    // The first slice ran synchronously; mutate while the walk is yielded.
    setTimeout(() => document.getElementById("list")!.append(document.createElement("p")), 0);
    const torn = await pending;
    return { quiet, torn };
  });
  expect(result.quiet.slices).toBeGreaterThan(1);
  expect(result.quiet.torn).toBe(false);
  expect(result.torn.slices).toBeGreaterThan(1);
  expect(result.torn.torn).toBe(true);
  const out = await output(page);
  expectValid(out);
  expect(out.snapshots.find((s) => s.sha256 === result.torn.sha256)!.body.torn).toBe(true);
});

test("20,000-element page stops at maxElements, truncated, checking the clock every batch", async ({ page }) => {
  await openPage(page, `<div id="grid">${'<div style="display:inline-block;width:6px;height:6px"></div>'.repeat(20000)}</div>`);
  await init(page);
  const summary = await page.evaluate(() => (window as any).handle.snapshot());
  const out = await output(page);
  expectValid(out);
  const body = out.snapshots[0].body;
  expect(body.truncated).toBe(true);
  expect(body.element_count).toBe(5000);
  expect(summary.element_count).toBe(5000);
  expect(summary.truncated).toBe(true);
  // Structural bound: every slice that yielded early stopped at a clock check, i.e.
  // after a whole number of batches. So a slice can overrun maxSliceMs by at most
  // the batch in progress when the clock passed it.
  const { slice_elements: elements, slice_ms: durations, check_every: batch } = summary;
  // Visited nodes include skipped ones (script, display:none), so at least the row count.
  expect(elements.reduce((a: number, b: number) => a + b, 0)).toBeGreaterThanOrEqual(5000);
  for (const count of elements.slice(0, -1)) expect(count % batch).toBe(0);
  const perBatch = durations.map((ms: number, i: number) => ms / Math.max(1, elements[i] / batch));
  console.log(
    `[timing] 20k page: ${summary.slices} slices, walk ${summary.walk_ms} ms, ` +
      `max slice ${summary.max_slice_ms} ms (budget 6), ` +
      `max overrun ${Math.max(0, ...durations.map((ms: number) => ms - 6)).toFixed(3)} ms, ` +
      `max per-batch ${Math.max(...perBatch).toFixed(3)} ms, bytes ${summary.bytes}`,
  );
});

test("maxSnapshotBytes drops trailing rows and marks truncated", async ({ page }) => {
  await openPage(page, '<div style="height:4px"></div>'.repeat(2000));
  await init(page, { maxSnapshotBytes: 20000 });
  const summary = await page.evaluate(() => (window as any).handle.snapshot());
  const out = await output(page);
  expectValid(out);
  expect(summary.bytes).toBeLessThanOrEqual(20000);
  expect(summary.truncated).toBe(true);
  expect(out.snapshots[0].body.element_count).toBeLessThan(2000);
  expect(new TextEncoder().encode(out.snapshots[0].serialized).byteLength).toBe(summary.bytes);
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMemorySink,
  defaultTestIdFilter,
  initInteractions,
  type InteractionHandle,
  type InteractionOptions,
} from "../src/index";
import { checkSnapshot } from "../src/detect";

const UUID_ID = "row-3f2a9c1e-7b4d-4e8a-9c21-5d6e7f809a1b";
const DOMAIN_ID = "website-domain-row-acme.com";
const COUNTER_ID = "item-42";
const KEPT = ["save-button", "nav:settings"];
const DROPPED = [UUID_ID, DOMAIN_ID, COUNTER_ID];
const ALL = [...DROPPED, ...KEPT];

let handles: InteractionHandle[] = [];
const start = (options: Partial<InteractionOptions> = {}) => {
  const sink = createMemorySink();
  const handle = initInteractions({
    sink,
    flushIntervalMs: 3_600_000,
    routeSettleMs: 3_600_000,
    // Only the explicit snapshot() calls below.
    resizeSettleMs: 3_600_000,
    visibleSettleMs: 3_600_000,
    ...options,
  });
  handles.push(handle);
  return { handle, sink };
};
const eventsOf = (sink: ReturnType<typeof createMemorySink>) =>
  sink.batches.flatMap((batch) => batch.events) as any[];

/** One 20×20 button per ID in a row, laid out by a stubbed getBoundingClientRect (jsdom has no layout). */
function mount(ids: readonly string[], attribute = "data-testid"): HTMLButtonElement[] {
  document.body.innerHTML = ids
    .map((id, i) => `<button ${attribute}="${id}" data-x="${10 + i * 40}" style="opacity:1">Go</button>`)
    .join("");
  // jsdom computes no opacity; the walk multiplies it down from the root.
  document.documentElement.style.opacity = "1";
  document.body.style.opacity = "1";
  return Array.from(document.querySelectorAll("button"));
}

beforeEach(() => {
  document.body.innerHTML = "";
  window.fetch = vi.fn(async () => new Response("{}")) as typeof fetch;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const x = Number(this.getAttribute("data-x"));
    if (this.tagName === "BUTTON" && Number.isFinite(x))
      return { x, y: 10, left: x, top: 10, right: x + 20, bottom: 30, width: 20, height: 20, toJSON() {} } as DOMRect;
    if (this === document.body || this === document.documentElement)
      return { x: 0, y: 0, left: 0, top: 0, right: 1024, bottom: 768, width: 1024, height: 768, toJSON() {} } as DOMRect;
    return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} } as DOMRect;
  });
});
afterEach(() => {
  handles.forEach((handle) => handle.shutdown());
  handles = [];
  vi.restoreAllMocks();
});

/** Takes a snapshot, clicks every button, and returns what left the page. */
async function capture(options: Partial<InteractionOptions> = {}, ids: readonly string[] = ALL, attribute?: string) {
  const { handle, sink } = start(options);
  const buttons = mount(ids, attribute);
  await handle.snapshot();
  for (const button of buttons) button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await handle.flush();
  const body = sink.snapshots[0]?.body;
  expect(body, "snapshot body").toBeTruthy();
  const controlIds = eventsOf(sink)
    .filter((event) => event.type === "interaction.started")
    .map((event) => event.data.control_id as string);
  // Findings exactly as the runtime computes them from the body (touch on, so
  // every 20 px button is a small tap target with the button as its subject).
  const findings = checkSnapshot(body!, { touch: true, sha256: sink.snapshots[0].sha256 }).filter(
    (finding) => finding.type === "small_tap_target",
  );
  return {
    sink,
    body: body!,
    dictionary: (body!.dictionaries?.test_id ?? []) as string[],
    controlIds,
    stableIds: findings.map((finding) => finding.subject!.stable_id),
    fingerprints: findings.map((finding) => finding.fingerprint),
    payload: JSON.stringify({ batches: sink.batches, snapshots: sink.snapshots.map((s) => s.body) }),
  };
}

describe("defaultTestIdFilter", () => {
  it("drops values with a digit or a long segment, and any value with a dot", () => {
    for (const id of DROPPED) expect(defaultTestIdFilter(id), id).toBeNull();
    for (const id of KEPT) expect(defaultTestIdFilter(id), id).toBe(id);
    expect(defaultTestIdFilter("checkout.pay")).toBeNull();
    expect(defaultTestIdFilter("plan_pro_cta")).toBe("plan_pro_cta");
    expect(defaultTestIdFilter("step2")).toBeNull();
    expect(defaultTestIdFilter(`user-${"a".repeat(33)}`)).toBeNull();
    expect(defaultTestIdFilter(`user-${"a".repeat(32)}`)).toBe(`user-${"a".repeat(32)}`);
    expect(defaultTestIdFilter("secret_name:prod")).toBe("secret_name:prod");
  });
});

describe("test IDs by default", () => {
  it("keeps static IDs and leaves data-bearing ones out of the dictionary, control_id and stable_id", async () => {
    const result = await capture();
    expect(result.dictionary.sort()).toEqual([...KEPT].sort());
    expect(result.controlIds).toHaveLength(ALL.length);
    expect(result.controlIds.filter((id) => KEPT.includes(id)).sort()).toEqual([...KEPT].sort());
    expect(result.stableIds).toHaveLength(ALL.length);
    expect(result.stableIds.filter((id) => KEPT.includes(id)).sort()).toEqual([...KEPT].sort());
    // The dropped ones fall back to the structural path, like an element with no test ID.
    expect(result.controlIds.filter((id) => !KEPT.includes(id))).toEqual(["body/button", "body/button", "body/button"]);
    expect(result.stableIds.filter((id) => !KEPT.includes(id))).toEqual(["html/body/button", "html/body/button", "html/body/button"]);
    for (const id of [...DROPPED, "acme"]) expect(result.payload).not.toContain(id);
  });

  it("applies the same rule to data-interaction-id", async () => {
    const result = await capture({}, ALL, "data-interaction-id");
    expect(result.dictionary.sort()).toEqual([...KEPT].sort());
    expect(result.controlIds.filter((id) => KEPT.includes(id)).sort()).toEqual([...KEPT].sort());
    for (const id of DROPPED) expect(result.payload).not.toContain(id);
  });

  it("falls back to data-testid when data-interaction-id is dropped", async () => {
    const { handle, sink } = start();
    document.body.innerHTML = `<button data-interaction-id="${COUNTER_ID}" data-testid="save-button" data-x="10">Go</button>`;
    document.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await handle.flush();
    expect(eventsOf(sink).find((e) => e.type === "interaction.started").data.control_id).toBe("save-button");
  });

  it("filters the control_id of UI state events", async () => {
    const { handle, sink } = start();
    document.body.innerHTML = `<div role="status" data-testid="${COUNTER_ID}"></div><div role="status" data-testid="save-status"></div>`;
    document.body.firstElementChild!.setAttribute("aria-busy", "true");
    document.body.lastElementChild!.setAttribute("aria-busy", "true");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await handle.flush();
    const ids = eventsOf(sink)
      .filter((e) => e.type === "ui.state.changed" && e.data.feedback_type === "busy")
      .map((e) => e.data.control_id);
    // Each status region reports appearing and turning busy.
    expect(ids).toEqual([undefined, "save-status", undefined, "save-status"]);
    expect(JSON.stringify(sink.batches)).not.toContain(COUNTER_ID);
  });
});

describe("the testId hook", () => {
  it("replaces the default: returning the value unchanged keeps item-42", async () => {
    const result = await capture({ testId: (value) => value });
    expect(result.dictionary.sort()).toEqual([...ALL].sort());
    expect(result.controlIds).toContain(COUNTER_ID);
    expect(result.stableIds).toContain(COUNTER_ID);
  });

  it("receives the element, can map to a static ID and can call the default", async () => {
    const seen: string[] = [];
    const result = await capture({
      testId: (value, element) => {
        seen.push(`${element.tagName}:${value}`);
        return value.startsWith("row-") ? "row" : defaultTestIdFilter(value);
      },
    });
    expect(seen).toContain(`BUTTON:${UUID_ID}`);
    expect(result.dictionary.sort()).toEqual(["nav:settings", "row", "save-button"]);
    expect(result.controlIds).toContain("row");
  });

  it("still requires the result to be a plain identifier", async () => {
    const result = await capture({ testId: () => "has space" }, ["save-button"]);
    expect(result.dictionary).toEqual([]);
    expect(result.controlIds).toEqual(["body/button"]);
  });

  it("returning null for everything: no test ID in any payload, and stable fingerprints across snapshots", async () => {
    const { handle, sink } = start({ testId: () => null });
    mount(ALL);
    await handle.snapshot();
    // A second, different snapshot of the same elements.
    document.body.insertAdjacentHTML("beforeend", "<p>More</p>");
    await handle.snapshot();
    for (const button of document.querySelectorAll("button"))
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await handle.flush();
    expect(sink.snapshots).toHaveLength(2);
    expect(sink.snapshots[0].sha256).not.toBe(sink.snapshots[1].sha256);
    for (const { body } of sink.snapshots) {
      expect(body.dictionaries?.test_id).toEqual([]);
      expect(body.elements.test_id.every((value) => value === -1)).toBe(true);
    }
    const payload = JSON.stringify({ batches: sink.batches, snapshots: sink.snapshots.map((s) => s.body) });
    for (const id of ALL) expect(payload).not.toContain(id);
    expect(
      eventsOf(sink)
        .filter((e) => e.type === "interaction.started")
        .every((e) => e.data.control_id === "body/button"),
    ).toBe(true);
    const fingerprintsOf = (index: number) =>
      checkSnapshot(sink.snapshots[index].body, { touch: true, sha256: sink.snapshots[index].sha256 })
        .filter((f) => f.type === "small_tap_target")
        .map((f) => [f.subject!.stable_id, f.fingerprint]);
    const first = fingerprintsOf(0);
    expect(first).toHaveLength(ALL.length);
    expect(fingerprintsOf(1)).toEqual(first);
  });

  it("a hook that throws drops the ID, never stops capture and logs nothing", async () => {
    const consoleCalls = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const result = await capture({
      testId: (value) => {
        if (value === COUNTER_ID) throw new Error("hook failed");
        return value;
      },
    });
    expect(result.dictionary.sort()).toEqual(ALL.filter((id) => id !== COUNTER_ID).sort());
    expect(result.controlIds).toHaveLength(ALL.length);
    expect(result.controlIds).not.toContain(COUNTER_ID);
    expect(result.controlIds).toContain("body/button");
    expect(result.payload).not.toContain(COUNTER_ID);
    for (const spy of consoleCalls) expect(spy).not.toHaveBeenCalled();
  });

  it("a hook returning a non-string, non-null value drops the ID", async () => {
    const result = await capture({ testId: (() => 42) as unknown as InteractionOptions["testId"] }, KEPT);
    expect(result.dictionary).toEqual([]);
    expect(result.controlIds).toEqual(["body/button", "body/button"]);
  });

  it("is part of the shared-instance identity", () => {
    const sink = createMemorySink();
    const first = initInteractions({ sink, testId: (value) => value });
    handles.push(first);
    const second = initInteractions({ sink, testId: (value) => value });
    handles.push(second);
    expect(first.getDiagnostics().enabled).toBe(true);
    expect(second.getDiagnostics().enabled).toBe(false);
  });
});

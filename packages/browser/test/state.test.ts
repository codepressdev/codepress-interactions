/** UI state (1.5.0): the snapshot `state` table and the state fields of ui.click.settled. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClickEffects } from "../src/click-effects";
import { STATE } from "../src/format";
import { createMemorySink, initInteractions, type InteractionHandle } from "../src/index";
import { PerfSignals } from "../src/perf";
import { normalizePath } from "../src/state";
import { encodeSnapshot, walkSnapshot } from "../src/snapshot";
import type { ClickSettledData } from "../src/types";

const walk = async () =>
  (await walkSnapshot({
    root: document.documentElement,
    maxElements: 50000,
    maxSliceMs: 1000,
    ignoreSelector: "",
    routeTemplate: "/",
    shouldAbort: () => false,
  }))!.body;

/** State bits by data-testid. */
const bitsOf = (body: Awaited<ReturnType<typeof walk>>) => {
  const out: Record<string, number> = {};
  body.state?.element.forEach((row, i) => {
    const id = body.elements.test_id[row];
    if (id >= 0) out[body.dictionaries.test_id[id]] = body.state!.bits[i];
  });
  return out;
};

beforeEach(() => {
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
});

describe("snapshot state table", () => {
  it("records nav current, tab selected, disclosure expanded and checkbox checked", async () => {
    history.replaceState(null, "", "/docs/");
    document.body.innerHTML = `
      <nav>
        <a data-testid="nav-home" href="/">Home</a>
        <a data-testid="nav-docs" href="/docs" aria-current="page">Docs</a>
        <a data-testid="nav-blog" href="/blog/" aria-current="false">Blog</a>
        <a data-testid="nav-ext" href="https://elsewhere.test/docs">Elsewhere</a>
      </nav>
      <div role="tablist">
        <button role="tab" data-testid="tab-a" aria-selected="true">A</button>
        <button role="tab" data-testid="tab-b" aria-selected="false">B</button>
      </div>
      <button data-testid="more" aria-expanded="true">More</button>
      <button data-testid="less" aria-expanded="false">Less</button>
      <input type="checkbox" data-testid="agree" checked>
      <input type="checkbox" data-testid="news">
      <button data-testid="off" disabled>Off</button>
      <button data-testid="toggle" aria-pressed="true">Bold</button>
      <input data-testid="email" aria-invalid="true">
      <div data-testid="feed" aria-busy="true"></div>
      <details data-testid="faq" open><summary>Q</summary>A</details>
      <div data-layout-ignore><button aria-pressed="true" data-testid="ignored">x</button></div>`;
    const body = await walk();
    expect(bitsOf(body)).toEqual({
      "nav-docs": STATE.current | STATE.links_here,
      "tab-a": STATE.selected,
      more: STATE.expanded,
      agree: STATE.checked,
      off: STATE.disabled,
      toggle: STATE.pressed,
      email: STATE.invalid,
      feed: STATE.busy,
      faq: STATE.open,
    });
    expect(body.state!.truncated).toBe(false);
    expect(body.legend.state).toEqual(STATE);
    // Rows ascend, like the other sparse tables.
    expect([...body.state!.element].sort((a, b) => a - b)).toEqual(body.state!.element);
  });

  it("links_here compares paths with the trailing slash dropped, except for /", () => {
    expect(normalizePath("/foo/")).toBe("/foo");
    expect(normalizePath("/foo")).toBe("/foo");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/a/b//")).toBe("/a/b");
  });

  it("a page with no stateful elements sends no state table and no state legend: the 1.4.0 shape", async () => {
    document.body.innerHTML = `<main><h1>Title</h1><p>Text</p><button>Go</button><a href="/elsewhere">x</a></main>`;
    const body = await walk();
    expect("state" in body && body.state !== undefined).toBe(false);
    // Exactly the 1.4.0 keys, in the 1.4.0 order.
    expect(Object.keys(body)).toEqual([
      "schema_version", "route_template", "viewport", "document", "element_count", "truncated", "torn",
      "legend", "dictionaries", "elements", "text_boxes", "hit_tests", "contrast", "unnamed_controls",
    ]);
    expect(Object.keys(body.legend)).toEqual(["position", "flags", "hit_points"]);
    expect(JSON.stringify(body)).not.toContain('"state"');
  });

  it("maxSnapshotBytes drops state rows past the kept elements, and the legend entry with the last one", async () => {
    document.body.innerHTML = `<button aria-pressed="true">A</button>` + Array.from({ length: 200 }, () => "<div></div>").join("") + `<button aria-pressed="true">B</button>`;
    const body = await walk();
    expect(body.state!.element.length).toBe(2);
    const half = encodeSnapshot(structuredClone(body), Math.floor(JSON.stringify(body).length / 2));
    expect(half.body.truncated).toBe(true);
    expect(half.body.state!.element).toEqual([body.state!.element[0]]);
    expect(half.body.legend.state).toEqual(STATE);
    const none = encodeSnapshot(structuredClone(body), 10);
    expect(Object.keys(none.body)).not.toContain("state");
    expect(Object.keys(none.body.legend)).toEqual(["position", "flags", "hit_points"]);
  });

  it("caps the table and says so", async () => {
    document.body.innerHTML = Array.from({ length: 10_005 }, () => `<i aria-busy="true"></i>`).join("");
    const body = await walk();
    expect(body.state!.element.length).toBe(10_000);
    expect(body.state!.truncated).toBe(true);
  });
});

describe("click state fields", () => {
  let clicks: ClickEffects;
  let emitted: ClickSettledData[];
  const start = () => {
    emitted = [];
    clicks = new ClickEffects({
      root: document.documentElement,
      settleMs: 20,
      timeoutMs: 2000,
      perf: new PerfSignals(),
      currentHash: () => null,
      routeTemplate: () => "/",
      snapshotAfter: async () => null,
      emit: (_id, data) => emitted.push(data),
    });
    clicks.start();
  };
  const settled = async () => {
    for (let i = 0; i < 100 && !emitted.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(emitted.length).toBe(1);
    return emitted[0];
  };
  afterEach(() => clicks?.stop());

  it("a state change that reverts before settling records state_reverted", async () => {
    document.body.innerHTML = `<div role="tablist"><button role="tab" id="a" aria-selected="true">A</button><button role="tab" id="b" aria-selected="false">B</button></div>`;
    start();
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    clicks.begin("c1", "tab-b", b, new MouseEvent("click"));
    b.setAttribute("aria-selected", "true");
    a.setAttribute("aria-selected", "false");
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The app undoes it (a failed save, a guard).
    b.setAttribute("aria-selected", "false");
    a.setAttribute("aria-selected", "true");
    const data = await settled();
    expect(data).toMatchObject({
      state_reverted: true,
      state_changes: 0,
      clicked_state_changed: false,
      marked_before: 1,
      marked_after: 1,
    });
  });

  it("a state change that sticks is counted and is not a revert", async () => {
    document.body.innerHTML = `<div role="tablist"><button role="tab" id="a" aria-selected="true">A</button><button role="tab" id="b" aria-selected="false">B</button></div>`;
    start();
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    clicks.begin("c1", "tab-b", b, new MouseEvent("click"));
    b.setAttribute("aria-selected", "true");
    a.setAttribute("aria-selected", "false");
    const data = await settled();
    expect(data).toMatchObject({ state_reverted: false, state_changes: 2, clicked_state_changed: true, marked_before: 1, marked_after: 1 });
  });

  it("a checkbox's checked property counts as the clicked control's state", async () => {
    document.body.innerHTML = `<input type="checkbox" id="c">`;
    start();
    const box = document.getElementById("c") as HTMLInputElement;
    clicks.begin("c1", "c", box, new MouseEvent("click"));
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    const data = await settled();
    expect(data).toMatchObject({ clicked_state_changed: true, state_changes: 1, state_reverted: false });
    expect(data.marked_before).toBeUndefined();
  });

  it("a re-rendered nav: removed and added elements count by their state, and the new nav is found again", async () => {
    document.body.innerHTML = `<header></header><nav id="old"><a id="home" href="/" aria-current="page">Home</a><a id="foo" href="/foo">Foo</a></nav>`;
    start();
    const foo = document.getElementById("foo")!;
    clicks.begin("c1", "foo", foo, new MouseEvent("click"));
    document.getElementById("old")!.replaceWith(
      Object.assign(document.createElement("nav"), {
        innerHTML: `<a href="/">Home</a><a href="/foo" aria-current="page">Foo</a><button aria-pressed="false">x</button>`,
      }),
    );
    const data = await settled();
    // The old Home (current) went away and the new Foo (current) came: two changes; the clicked link left with no state.
    expect(data).toMatchObject({ state_changes: 2, clicked_state_changed: false, marked_before: 1, marked_after: 1 });
  });

  it("links here after a click: counted, and whether they are marked", async () => {
    document.body.innerHTML = `<nav><a id="home" href="/" aria-current="page">Home</a><a id="foo" href="/foo/">Foo</a></nav>`;
    start();
    const foo = document.getElementById("foo")!;
    clicks.begin("c1", "foo", foo, new MouseEvent("click"));
    history.pushState(null, "", "/foo");
    clicks.routeChanged();
    const data = await settled();
    // Nothing moved aria-current: the Dentele nav.
    expect(data).toMatchObject({ links_here_after: 1, links_here_marked_after: 0, marked_before: 1, marked_after: 1 });
  });
});

// Attribute values, hrefs and paths are read in the page to work out the bits; none may leave it.
const S = "Zq7Sentinel";

describe("privacy", () => {
  let handle: InteractionHandle | undefined;
  afterEach(() => handle?.shutdown());

  it("no href, text or attribute value appears in any emitted event or snapshot", async () => {
    history.replaceState(null, "", `/${S}/`);
    document.body.innerHTML = `
      <nav aria-label="${S} nav">
        <a href="/${S}" aria-current="${S}" data-testid="here">${S} here</a>
        <a href="/other/${S}?q=${S}" aria-current="false" id="go">${S} other</a>
      </nav>
      <div role="tablist"><button role="tab" aria-selected="true" aria-controls="${S}-panel">${S} tab</button></div>
      <button aria-expanded="true" aria-controls="${S}">${S}</button>
      <input type="checkbox" checked value="${S}" name="${S}">
      <input aria-invalid="${S}" value="${S}">
      <details open title="${S}"><summary>${S}</summary>${S}</details>`;
    const sink = createMemorySink();
    handle = initInteractions({ sink, flushIntervalMs: 3_600_000, routeSettleMs: 3_600_000, clickSettleMs: 20 });
    await handle.snapshot();
    const go = document.getElementById("go")!;
    go.addEventListener("click", (event) => {
      event.preventDefault();
      go.setAttribute("aria-current", S);
      document.querySelector('[data-testid="here"]')!.setAttribute("aria-current", "false");
    });
    go.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await handle.flush();
    const clicksSeen = sink.batches.flatMap((batch) => batch.events).filter((event) => event.type === "ui.click.settled");
    expect(clicksSeen.length).toBe(1);
    expect(clicksSeen[0].data).toMatchObject({ state_changes: 2, clicked_state_changed: true, marked_before: 1, marked_after: 1 });
    expect(sink.snapshots.some((snapshot) => snapshot.body.state)).toBe(true);
    const everything = [...sink.serializedBatches, ...sink.snapshots.map((snapshot) => snapshot.serialized)].join("\n");
    expect(everything.toLowerCase()).not.toContain(S.toLowerCase());
    expect(everything).not.toContain("/other");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoverEffects, hoveredSelectors, reactHoverHandler, type HoverHost } from "../src/hover-effects";
import type { HoverKind, HoverSettledData } from "../src/types";

// jsdom has no PointerEvent: a MouseEvent with pointerType is what the listener reads.
// Each event is at a new position unless `at` is given: a pointerover where the
// last one was is the page changing under a still pointer, and is ignored.
let position = 0;
function pointer(
  type: "pointerover" | "pointerout" | "pointerdown",
  target: Element,
  pointerType = "mouse",
  relatedTarget: Element | null = null,
  at = ++position,
) {
  const event = new MouseEvent(type, { bubbles: true, relatedTarget, clientX: at, clientY: at });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  target.dispatchEvent(event);
}

function withRole(role: string): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("role", role);
  return element;
}

let effects: HoverEffects;
let emitted: HoverSettledData[];
let silent: HoverKind[];
let snapshots: string[];

function start(options: Partial<HoverHost> = {}) {
  effects = new HoverEffects({
    root: document.documentElement,
    dwellMs: 150,
    settleMs: 200,
    recordIntervalMs: 30000,
    maxPerMinute: 30,
    controlId: (element) => element.getAttribute("data-testid") ?? element.tagName.toLowerCase(),
    routeTemplate: () => "/",
    snapshot: async (trigger) => {
      snapshots.push(trigger);
      return "a".repeat(64);
    },
    emit: (data) => emitted.push(data),
    silent: (kind) => silent.push(kind),
    noFocusIndicator: () => {},
    ...options,
  });
  effects.start();
}

/** Rests the mouse on `control` long enough to commit and settle; `react` adds a tooltip when it arrives. */
async function hover(control: Element, { restMs = 400, react = true } = {}) {
  pointer("pointerover", control);
  if (react) {
    const tip = document.createElement("div");
    tip.setAttribute("role", "tooltip");
    document.body.append(tip);
  }
  await vi.advanceTimersByTimeAsync(restMs);
  pointer("pointerout", control, "mouse", document.body);
  document.querySelectorAll('[role="tooltip"]').forEach((tip) => tip.remove());
  await vi.advanceTimersByTimeAsync(10);
}

beforeEach(() => {
  vi.useFakeTimers();
  emitted = [];
  silent = [];
  snapshots = [];
  document.body.innerHTML = "";
});
afterEach(() => {
  effects?.stop();
  vi.useRealTimers();
});

describe("hover follow-through", () => {
  it("records a resting hover that opened a tooltip, with a hover snapshot", async () => {
    document.body.innerHTML = '<button data-testid="info">Info</button>';
    start();
    await hover(document.querySelector("button")!);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: "pointer",
      control_id: "info",
      route_template: "/",
      overlay_opened: true,
      nodes_added: true,
      snapshot_sha256: "a".repeat(64),
      has_hover_handler: null,
    });
    expect(emitted[0].dwell_ms).toBe(150);
    expect(snapshots).toEqual(["hover"]);
  });

  it("100 hovers on one control within 30 s make one record; after 30 s another is allowed", async () => {
    document.body.innerHTML = '<button data-testid="info">Info</button>';
    start();
    const button = document.querySelector("button")!;
    for (let i = 0; i < 100; i++) await hover(button, { restMs: 250 });
    expect(emitted).toHaveLength(1);
    // Limited hovers are not followed at all, so they are not counted silent either.
    expect(silent).toEqual([]);
    await vi.advanceTimersByTimeAsync(30000);
    await hover(button);
    expect(emitted).toHaveLength(2);
  });

  it("caps records at 30 per minute across controls", async () => {
    document.body.innerHTML = Array.from({ length: 40 }, (_, i) => `<button data-testid="b${i}">B</button>`).join("");
    start();
    for (const button of document.querySelectorAll("button")) await hover(button, { restMs: 250 });
    expect(emitted).toHaveLength(30);
    await vi.advanceTimersByTimeAsync(60000);
    await hover(document.querySelector('[data-testid="b39"]')!);
    expect(emitted).toHaveLength(31);
  });

  it("a pointer that leaves before the dwell records nothing and counts nothing", async () => {
    document.body.innerHTML = '<button data-testid="info">Info</button>';
    start();
    await hover(document.querySelector("button")!, { restMs: 50 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(emitted).toEqual([]);
    expect(silent).toEqual([]);
  });

  it("touch pointers are never hovers", async () => {
    document.body.innerHTML = '<button data-testid="info">Info</button>';
    start();
    const button = document.querySelector("button")!;
    pointer("pointerover", button, "touch");
    document.body.append(withRole("tooltip"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(emitted).toEqual([]);
    expect(silent).toEqual([]);
  });

  it("a hover that changes nothing is counted silent, not recorded", async () => {
    document.body.innerHTML = '<button data-testid="info">Info</button>';
    start();
    await hover(document.querySelector("button")!, { react: false });
    expect(emitted).toEqual([]);
    expect(silent).toEqual(["pointer"]);
  });

  it("a press ends the hover: what the click does is not the hover's", async () => {
    document.body.innerHTML = '<button data-testid="info">Info</button>';
    start();
    const button = document.querySelector("button")!;
    pointer("pointerover", button);
    await vi.advanceTimersByTimeAsync(200);
    pointer("pointerdown", button);
    document.body.append(withRole("dialog"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(emitted).toEqual([]);
    expect(silent).toEqual(["pointer"]);
  });

  it("moving between parts of one control is one hover; a div with no hover reaction is not a control", async () => {
    document.body.innerHTML = '<button data-testid="info"><span>I</span><b>nfo</b></button><div id="plain">x</div>';
    start();
    const [span, bold] = [document.querySelector("span")!, document.querySelector("b")!];
    pointer("pointerover", span);
    await vi.advanceTimersByTimeAsync(100);
    pointer("pointerout", span, "mouse", bold);
    pointer("pointerover", bold);
    await vi.advanceTimersByTimeAsync(100);
    document.body.append(withRole("menu"));
    await vi.advanceTimersByTimeAsync(400);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].control_id).toBe("info");
    pointer("pointerover", document.getElementById("plain")!);
    await vi.advanceTimersByTimeAsync(1000);
    expect(silent).toEqual([]);
  });

  it("with a dwell longer than the settle time, an effect inside the dwell does not end the hover early", async () => {
    document.body.innerHTML = '<button data-testid="info">Info</button>';
    start({ dwellMs: 500, settleMs: 100 });
    pointer("pointerover", document.querySelector("button")!);
    await vi.advanceTimersByTimeAsync(50);
    document.body.append(withRole("tooltip"));
    // Well past settleMs after the effect, still inside the dwell: not settled, not dropped.
    await vi.advanceTimersByTimeAsync(300);
    expect(emitted).toEqual([]);
    expect(silent).toEqual([]);
    // The dwell commits at 500 ms and the window settles settleMs later, with the early effect counted.
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(100);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ kind: "pointer", control_id: "info", dwell_ms: 500, overlay_opened: true, nodes_added: true });
    expect(emitted[0].settle_ms).toBe(50);
    expect(snapshots).toEqual(["hover"]);
  });

  it("a pointerover where the pointer already was is the page changing under it, not a new hover", async () => {
    document.body.innerHTML = '<button data-testid="a">A</button><button data-testid="b">B</button>';
    let ids = 0;
    start({ controlId: (element) => (ids++, element.getAttribute("data-testid")!) });
    const [a, b] = document.querySelectorAll("button");
    pointer("pointerover", a, "mouse", null, 7);
    expect(ids).toBe(1);
    // B replaced the element under a still pointer: ignored, and A's hover goes on.
    pointer("pointerover", b, "mouse", null, 7);
    expect(ids).toBe(1);
    document.body.append(withRole("tooltip"));
    await vi.advanceTimersByTimeAsync(500);
    expect(emitted.map((e) => e.control_id)).toEqual(["a"]);
  });

  it("an element matching a :hover style rule is a control", async () => {
    document.body.innerHTML = '<style>.card:hover .title { color: red }</style><div class="card"><p class="title">T</p></div>';
    start();
    await hover(document.querySelector("p")!, { react: false });
    expect(silent).toEqual(["pointer"]);
  });
});

describe("hoveredSelectors", () => {
  it("keeps the compound that is hovered, without :hover or pseudo-elements", () => {
    expect(hoveredSelectors(".card:hover .title")).toEqual([".card"]);
    expect(hoveredSelectors("nav > a:hover::after, .x")).toEqual(["nav > a"]);
    expect(hoveredSelectors("button:not(:disabled):hover")).toEqual(["button:not(:disabled)"]);
    expect(hoveredSelectors(".group:hover .group-hover\\:block")).toEqual([".group"]);
    expect(hoveredSelectors(".hover\\:bg-blue:hover")).toEqual([".hover\\:bg-blue"]);
  });

  it("drops what does not parse alone or would match everything", () => {
    expect(hoveredSelectors(":hover")).toEqual([]);
    expect(hoveredSelectors("*:hover")).toEqual([]);
    expect(hoveredSelectors("&:hover")).toEqual([]);
    expect(hoveredSelectors(":is(a:hover, b)")).toEqual([]);
    expect(hoveredSelectors(".hover\\:x")).toEqual([]);
  });
});

describe("reactHoverHandler", () => {
  it("true for a hover handler on the element or up to 3 ancestors, false for React without one, null otherwise", () => {
    document.body.innerHTML = "<div><div><div><div><span></span></div></div></div></div>";
    const span = document.querySelector("span")!;
    expect(reactHoverHandler(span)).toBeNull();
    (span as any).__reactProps$abc = { onClick() {} };
    expect(reactHoverHandler(span)).toBe(false);
    (span.parentElement!.parentElement!.parentElement as any).__reactProps$abc = { onPointerEnter() {} };
    expect(reactHoverHandler(span)).toBe(true);
    // Four levels up is past the limit.
    const far = document.createElement("div");
    far.innerHTML = "<a><b><i><u></u></i></b></a>";
    (far as any).__reactProps$x = { onMouseEnter() {} };
    expect(reactHoverHandler(far.querySelector("u")!)).toBeNull();
  });

  it("a throwing props getter is unknown, never an error", () => {
    const element = document.createElement("div");
    Object.defineProperty(element, "__reactProps$x", { enumerable: true, get: () => { throw new Error("no"); } });
    expect(reactHoverHandler(element)).toBeNull();
  });
});

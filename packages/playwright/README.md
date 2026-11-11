# @codepress/interactions-playwright

Playwright helpers that run the [CodePress Interactions](https://github.com/quantfive/codepress-interactions/blob/main/README.md) UI checks on a page under test: overlapping elements, content spilling out of its box, horizontal page scroll, controls out of reach, small tap targets (touch), clipped text and broken images.

```sh
npm install --save-dev @codepress/interactions-playwright
```

```ts
import { test } from "@playwright/test";
import { expectNoFindings, findIssues } from "@codepress/interactions-playwright";

test("checkout has no layout findings", async ({ page }) => {
  await page.goto("/checkout/42");
  await expectNoFindings(page, { routeSegments: ["checkout"] });
});
```

A failure lists one line per finding: the check, the elements (test ID, or a structural path such as `#cart/div/button` when there is none), the measured evidence and the fingerprint.

```
2 UI findings on /checkout/42. Pass a fingerprint in ignoreFingerprints to accept one.
  "layout.overlap checkout × promo on /checkout/:id @1280x800: overlap_px=3520 … subject_blocked_points=5 … center_blocked subject_text_covered … [590f6922417e2a04f8d6c9341daf02c1]"
```

Findings are pointers, not verdicts: each says what was measured, and you decide whether it is a bug. Sorting puts blocked controls first, then covered or clipped text, then the rest, then decorative layers and content-free findings (stacked or cropped images); it never drops one.

## API

- `captureSnapshot(page, options?)` → `{ body, sha256 }`: walks the page with the SDK's snapshot walker in one pass, so the body is never torn.
- `findIssues(page, options?)` → `Finding[]`: the checks on the page as it is now, sorted.
- `expectNoFindings(page, options?)`: fails the test when `findIssues` returns anything.
- `sweepInteractions(page, options?)` → `{ findings, controls, skipped }`: hovers and keyboard-focuses every control, running the checks after each. See [Hover and focus sweep](#hover-and-focus-sweep).
- `expectNoSweepFindings(page, options?)`: fails the test when `sweepInteractions` finds anything, one line per finding as `expectNoFindings` writes them.

Options (all optional):

| Option | Default | |
| --- | --- | --- |
| `root` | whole document | CSS selector of the subtree to walk |
| `ignore` | none | extra selector for subtrees to leave out; `[data-layout-ignore]` always applies (to allow one overlap pair and keep the elements in every other check, use `data-layout-allow-overlap` in the markup instead) |
| `route` | from the URL | route template recorded on findings and used by fingerprints |
| `routeSegments` | `[]` | literal path segments kept in the default route template (others become `:id`) |
| `maxElements` | 50000 | element limit |
| `theme` | the page's `prefers-color-scheme` | `"light"`, `"dark"` or `"unknown"` to record, for apps with their own theme toggle (Playwright's `colorScheme` / `page.emulateMedia` set the default) |
| `testId` | `defaultTestIdFilter` | `(value, element) => string \| null`: which `data-interaction-id` / `data-testid` values to record, as the browser SDK's [`testId` option](https://github.com/quantfive/codepress-interactions/blob/main/packages/browser/README.md#test-ids-and-privacy). It runs in the page, so it must be self-contained, like a `page.evaluate` callback; a name the page does not have fails the capture. A name the page does have, such as a test variable called `status`, or any other runtime error in the hook, drops the ID with no error, so check the snapshot's IDs when you write a hook. Write out the rule your app uses so fingerprints match production, calling `globalThis.__codepressInteractions.defaultTestIdFilter(value)` where it calls the default. `(value) => value` keeps every ID |
| `ignoreFingerprints` | `[]` | fingerprints to leave out (known findings accepted for now) |
| `events` | none | protocol v2 events to run the click and stability checks over too |
| `checks` and thresholds | see [detect options](https://github.com/quantfive/codepress-interactions/blob/main/packages/browser/README.md#ui-checks) | |

Fingerprints are stable across scroll offsets, runs and machines: they hash the check, the route template, the viewport width band and the elements' identities, never coordinates.

## Hover and focus sweep

Some problems only show while something is hovered or focused: a menu that spills out of its bar, a tooltip that covers the button next to it, content that only the mouse can reveal. `sweepInteractions` visits each control and runs the checks in each state.

```ts
import { test } from "@playwright/test";
import { expectNoSweepFindings } from "@codepress/interactions-playwright";

test("settings has no hover or focus findings", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/settings");
  await expectNoSweepFindings(page, { routeSegments: ["settings"] });
});
```

It runs the checks on the page at rest, then for each visible, enabled control in document order (the controls the snapshot marks interactive, outside `ignore`, `[data-layout-ignore]` and `[data-interactions-exclude]`), up to `maxControls`:

1. moves the mouse to a spot with no control under it, scrolls the control into view and waits for the page to go quiet;
2. rests the mouse on the control, waits for the hover to settle (the browser SDK's hover follow-through, then any running transitions), and runs the checks;
3. moves the mouse away, presses Escape, waits for quiet, gives the control keyboard focus (`:focus-visible`), waits for it to settle and runs the checks;
4. presses Escape and blurs the control, to close what it opened.

Each finding is kept once per fingerprint, so a problem seen at rest and in every state is one line. When the hover opened an overlay and the keyboard focus did not, the sweep hovers the control once more, and if the overlay opens again it adds an `a11y.hover_only_content` finding for that control (WCAG 1.4.13 and 2.1.1): keyboard users never see that content. Show the content on `:focus-visible` (or `:focus-within` on a wrapper) as well as `:hover` to fix it.

An overlay is a dialog, tooltip, menu, listbox or open popover, or an absolutely or fixed positioned layer with text or a control, that was not showing before and is tied to the control: inside the control or its parent element, referenced by the control's `aria-describedby`, `aria-controls` or `aria-owns`, or within 16 px of it. A toast, banner or status line elsewhere on the page that appears during a hover is not counted, and one that appears only once is ruled out by the second hover.

Escape between controls closes dialogs and menus, including one the test opened before the sweep, so sweep a screen in its resting state; `root` limits the sweep to part of it. The sweep only hovers and focuses: it never clicks or types.

Options are those of `findIssues`, plus:

| Option | Default | |
| --- | --- | --- |
| `maxControls` | 200 | most controls visited; the rest are counted in `skipped` |
| `hover` | `true` | rest the mouse on each control |
| `focus` | `true` | give each control keyboard focus |
| `settleMs` | 200 | quiet time after the last change before a hover or focus counts as settled. Raise it for tooltips and menus that open after a longer delay: one that opens late on hover is missed, and one that opens late only on focus makes the control look hover-only |

`a11y.hover_only_content` needs both `hover` and `focus`. `controls` is the number visited; `skipped` counts controls past `maxControls` and those that left the page, or could not be hovered, when their turn came. Each control takes about four `settleMs` plus three snapshot walks, about a second at the default, so raise the test's timeout for a long page or lower `maxControls`.

## License

Apache-2.0

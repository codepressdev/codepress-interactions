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

Options (all optional):

| Option | Default | |
| --- | --- | --- |
| `root` | whole document | CSS selector of the subtree to walk |
| `ignore` | none | extra selector for subtrees to leave out; `[data-layout-ignore]` always applies |
| `route` | from the URL | route template recorded on findings and used by fingerprints |
| `routeSegments` | `[]` | literal path segments kept in the default route template (others become `:id`) |
| `maxElements` | 50000 | element limit |
| `theme` | the page's `prefers-color-scheme` | `"light"`, `"dark"` or `"unknown"` to record, for apps with their own theme toggle (Playwright's `colorScheme` / `page.emulateMedia` set the default) |
| `ignoreFingerprints` | `[]` | fingerprints to leave out (known findings accepted for now) |
| `events` | none | protocol v2 events to run the click and stability checks over too |
| `checks` and thresholds | see [detect options](https://github.com/quantfive/codepress-interactions/blob/main/packages/browser/README.md#ui-checks) | |

Fingerprints are stable across scroll offsets, runs and machines: they hash the check, the route template, the viewport width band and the elements' identities, never coordinates.

## License

Apache-2.0

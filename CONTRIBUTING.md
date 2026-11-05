# Contributing

Thanks for helping. Bug reports with a page that reproduces them are the most useful thing you can send; pull requests are welcome too.

## Reporting a bug

Open an issue with the bug template. The most useful details are:

- the package and version, and the browser;
- a minimal page (HTML and CSS, or a small component) that shows it;
- what the SDK reported (the finding line from `formatFinding` or `expectNoFindings`, or the relevant events) and what you expected.

A wrong finding, or a missing one, is a bug: say what is on screen and what the evidence says. Never paste real user data, project keys or tokens into an issue. Batches and snapshots contain no page text by design, so they are safe to attach, but check anything else you attach.

## Reporting a security problem

Do not open a public issue. Use **Report a vulnerability** on the repository's Security tab, which sends a private advisory to the maintainers. Privacy problems count: anything that lets page text, input values, URLs, request bodies or user identifiers reach a batch or snapshot is a security problem here.

## Setting up

You need Node.js 20.19 or later (or 22.12 or later) and pnpm 10 (`corepack enable` gives you the pinned version).

```sh
pnpm install
pnpm build                                  # the React and Playwright packages typecheck and test against the browser package's build
pnpm typecheck
pnpm test                                   # unit tests (Vitest, jsdom and Node)
pnpm --filter @codepress/interactions-browser exec playwright install chromium
pnpm test:browser                           # real-browser tests (Chromium)
```

The Python SDK in `python/` uses [uv](https://docs.astral.sh/uv/): `cd python && uv sync && uv run pytest && uv run ruff check src tests`.

## Making a change

- **Checks** live in `packages/browser/src/detect/` and are pure functions over a snapshot body and events. A new or changed check needs a unit test in `test/detect.test.ts` (build the body with the `body()` helper), and, when it depends on real layout, a browser test in `test/e2e/detect.spec.ts` that compares the browser's findings with Node's (`expectSame`). Evidence holds measured numbers and booleans only, never text, and stays within 32 keys.
- **Privacy** is the contract. A change must not let page text, input or attribute values, URLs, queries, request or response bodies, or user identifiers into a batch or snapshot. `test/e2e/privacy.spec.ts` plants such values in a page and checks they never appear; extend it when you capture something new.
- **Protocol:** edit `protocol/generate-v2.mjs`, never the generated schemas, then run `node protocol/generate-v2.mjs protocol`. Within protocol version 2 a change must be additive (new optional fields, flags or evidence keys). Say in a new field's description which version added it. When the browser output changes, regenerate the samples with `UPDATE_GOLDEN=1 pnpm --filter @codepress/interactions-browser test:browser golden` and review the diff.
- **Overhead:** if a change touches the snapshot walk, the checks or the click path, run `pnpm --filter @codepress/interactions-browser bench` before and after, and put both in the pull request.
- **Docs:** behavior is documented in the package READMEs. Change them with the code, and add a line to `CHANGELOG.md` under an "Unreleased" heading.

Keep pull requests focused, and describe what you changed and how you checked it. CI runs the type check, the unit and browser tests and the package file checks.

## Releasing

A release bumps the npm packages whose code changed. To release:

1. Bump `version` in the `package.json` of each changed package, and, when the browser package changes, `VERSION` in `packages/browser/src/util.ts`; regenerate the golden samples (they record `sdk_version`).
2. Move the "Unreleased" changelog entries under the new version.
3. Merge to `main`. The publish workflows (`.github/workflows/publish-*.yml`) publish each version npm does not have yet, with provenance, through npm Trusted Publishing. No npm token is stored in the repository. The browser package goes first; the React and Playwright workflows do not publish until npm has the browser version they build against, so if they ran first they warn and skip, and you re-run them once the browser package is out.

A package that does not exist on npm yet is skipped with a warning in the workflow run: its first version is published once by hand by an owner of the `@codepress` npm scope, who then adds the workflow as the package's trusted publisher.

## License

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).

// Bundles src/page-script.ts into a string and writes dist/page-script.{js,cjs,d.ts,d.cts}
// exporting PAGE_SCRIPT, for test runners to inject into pages.
import { buildSync } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "../dist");
const code = buildSync({
  entryPoints: [resolve(here, "../src/page-script.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  write: false,
}).outputFiles[0].text;
const literal = JSON.stringify(code);
const doc = "/** Defines globalThis.__codepressInteractions.walk(options) in a page; resolves with a snapshot body. */\n";
mkdirSync(dist, { recursive: true });
writeFileSync(resolve(dist, "page-script.js"), `${doc}export const PAGE_SCRIPT = ${literal};\n`);
writeFileSync(resolve(dist, "page-script.cjs"), `"use strict";\n${doc}exports.PAGE_SCRIPT = ${literal};\n`);
const types = `${doc}export declare const PAGE_SCRIPT: string;\n`;
writeFileSync(resolve(dist, "page-script.d.ts"), types);
writeFileSync(resolve(dist, "page-script.d.cts"), types);
console.log(`page-script: ${code.length} bytes`);

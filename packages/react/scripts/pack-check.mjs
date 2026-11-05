// Checks the files npm would publish: the built entry points, types, license and
// README, and nothing else (no sources, tests or environment files).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [pack] = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }),
);
const files = pack.files.map((file) => file.path).sort();
const required = [
  "LICENSE",
  "README.md",
  "package.json",
  "dist/index.js",
  "dist/index.cjs",
  "dist/index.d.ts",
  "dist/index.d.cts",
];
const missing = required.filter((file) => !files.includes(file));
const unexpected = files.filter(
  (file) => !required.includes(file) && !/^dist\/[\w.-]+\.(js|cjs|d\.ts|d\.cts|map)$/.test(file),
);
console.log(`${pack.name}@${pack.version}: ${files.length} files, ${pack.size} bytes packed`);
for (const file of files) console.log(`  ${file}`);
if (missing.length || unexpected.length) {
  console.error(`missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`);
  process.exit(1);
}

// The published manifest comes from `pnpm pack`, which must turn the workspace
// dependency into a version range npm can install.
const dir = mkdtempSync(join(process.env.RUNNER_TEMP || process.env.TMPDIR || tmpdir(), "pack-"));
try {
  execFileSync("pnpm", ["pack", "--pack-destination", dir], { stdio: "ignore" });
  const tarball = join(dir, readdirSync(dir).find((name) => name.endsWith(".tgz")));
  const manifest = JSON.parse(execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" }));
  const range = manifest.dependencies?.["@codepress/interactions-browser"];
  console.log(`packed dependency: @codepress/interactions-browser ${range}`);
  if (!range || range.startsWith("workspace:")) {
    console.error("the packed manifest still has a workspace: dependency");
    process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

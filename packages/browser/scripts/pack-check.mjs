// Checks the files npm would publish: the built entry points, types, license and
// README, and nothing else (no sources, tests or environment files).
import { execFileSync } from "node:child_process";

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

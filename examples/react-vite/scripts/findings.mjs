// Prints .interactions/findings.json one line per finding, most urgent first.
import { readFile } from "node:fs/promises";
import { formatFinding, sortFindings } from "@codepress/interactions-browser/detect";

const path = new URL("../.interactions/findings.json", import.meta.url);

let findings;
try {
  findings = JSON.parse(await readFile(path, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  console.log("No .interactions/findings.json yet: run `npm run dev`, open the page and wait a few seconds.");
  process.exit(0);
}

for (const finding of sortFindings(findings)) {
  console.log(`${formatFinding(finding)} (last seen ${finding.last_seen})`);
}
console.log(`${findings.length} finding${findings.length === 1 ? "" : "s"}`);

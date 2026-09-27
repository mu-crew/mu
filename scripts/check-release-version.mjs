// Fails unless the pushed tag matches package.json's version.
// Usage: node scripts/check-release-version.mjs v1.2.3
import { readFileSync } from "node:fs";

const { name, version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const tag = (process.argv[2] ?? "").replace(/^refs\/tags\//, "").replace(/^v/, "");
if (tag !== version) {
  console.error(`tag ${process.argv[2] ?? "(missing)"} does not match ${name} ${version}`);
  process.exit(1);
}
console.log(`releasing ${name} ${version}`);

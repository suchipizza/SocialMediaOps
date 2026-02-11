import fs from "node:fs";
import path from "node:path";
import { validateManifest } from "./validate.js";

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error("Usage: node dist/cli.js <path/to/manifest.json>");
  process.exit(1);
}

const raw = fs.readFileSync(path.resolve(manifestPath), "utf-8");
const obj = JSON.parse(raw);

try {
  const validated = validateManifest(obj);
  console.log("✅ Manifest valid:", { slide_count: validated.slide_count, output: validated.output });
} catch (e: any) {
  console.error("❌ Manifest invalid:", e?.message ?? e);
  process.exit(2);
}

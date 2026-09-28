// Neutralize the hardcoded default instances in a COPY of the runtime config so
// mergeStringLists() has nothing to merge back in, then rebuild the API bundle.
// The live config file itself is left alone (force-ytdlp-only.mjs handles that).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] || "off";
const cfgPath = path.join(root, "api", "runtime-config.json");
const stamp = path.join(root, ".logs", "ytdlp-force-config.json");

if (mode === "on") {
  if (!fs.existsSync(stamp)) fs.copyFileSync(cfgPath, stamp);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  cfg.instances = { piped: [], invidious: [] };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  console.log("config instances emptied:", JSON.stringify(cfg.instances));
} else {
  if (fs.existsSync(stamp)) {
    fs.copyFileSync(stamp, cfgPath);
    fs.unlinkSync(stamp);
    console.log("restored runtime-config.json");
  } else {
    console.log("no stamp to restore");
  }
}

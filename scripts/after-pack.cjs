// electron-builder `extraResources` filter drops nested node_modules, so the
// Next standalone server's traced deps never reach the packaged app and
// server.js dies with MODULE_NOT_FOUND. This runs post-pack and copies them
// deterministically. ponytail: if electron-builder ever preserves nested
// node_modules in extraResources, this becomes a redundant overwrite — delete it.
const { cpSync, existsSync } = require("node:fs");
const path = require("node:path");

exports.default = async (context) => {
  const from = path.join(
    context.packager.projectDir, "app", ".next", "standalone", "node_modules"
  );
  const to = path.join(context.appOutDir, "resources", "app", "node_modules");
  if (!existsSync(from)) {
    throw new Error(`missing ${from} — run "npm run build:app" first`);
  }
  cpSync(from, to, { recursive: true });
  console.log(`afterPack: standalone node_modules -> ${to}`);
};

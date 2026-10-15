// electron-builder `extraResources` filter drops nested node_modules, so the
// Next standalone server's traced deps never reach the packaged app and
// server.js dies with MODULE_NOT_FOUND. This runs post-pack and copies them
// deterministically. ponytail: if electron-builder ever preserves nested
// node_modules in extraResources, this becomes a redundant overwrite — delete it.
const { cpSync, existsSync, readdirSync, unlinkSync } = require("node:fs");
const path = require("node:path");

// macOS universal builds only: @electron/universal requires every non-binary
// file to be byte-identical across the x64 and arm64 slices, and the castlabs
// Electron dist ships a per-arch development VMP signature at
// Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/
// Electron Framework.sig. The two slices' signatures differ, so the merge
// aborts with "Expected all non-binary files to have identical SHAs". Removing
// it before the merge is the documented remedy (castlabs FAQ, issue #105): the
// signature is regenerated when the merged package is VMP signed with EVS, and
// this app is unsigned on macOS (build.mac.identity: null), so nothing needs
// it. No-op on every other platform.
const SIG_RELATIVE = path.join(
  "Contents",
  "Frameworks",
  "Electron Framework.framework",
  "Versions",
  "A",
  "Resources",
  "Electron Framework.sig"
);

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

  // appOutDir holds one .app per slice for a universal build
  // (e.g. release/mac-universal-x64-temp), so walk it rather than hardcoding
  // the product name. Never throws on a missing file: that would take down
  // packs for platforms that never had it.
  for (const entry of readdirSync(context.appOutDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;
    const sigPath = path.join(context.appOutDir, entry.name, SIG_RELATIVE);
    if (!existsSync(sigPath)) continue;
    unlinkSync(sigPath);
    console.log(`afterPack: removed per-arch VMP sig from ${entry.name}`);
  }
};

// Ensures app/.env.local exists BEFORE `next build`, because NEXT_PUBLIC_*
// values are inlined into the client JS at compile time — creating the file
// after the build (as prepare-standalone.mjs does) is too late.
//
// Source of truth:
//   1. app/.env.local if it already exists (dev machine, CI secret).
//   2. Otherwise app/.env.local.template (committed; carries only public
//      values — the service-role key stays empty by design and is never in
//      build output).
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const envFile = path.join(root, "app", ".env.local");
const template = path.join(root, "app", ".env.local.template");

if (existsSync(envFile)) {
  console.log("prepare-env: app/.env.local present — using it");
} else if (existsSync(template)) {
  copyFileSync(template, envFile);
  console.log("prepare-env: seeded app/.env.local from template (public values only)");
} else {
  console.log("prepare-env: no app/.env.local or template — build continues without env");
}

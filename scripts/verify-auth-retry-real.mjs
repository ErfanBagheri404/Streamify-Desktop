// Verifies the OTP retry against the REAL supabase-js, not a mock.
//
// Two cases, both through the app's own verifyOtpWithRetry:
//
//   1. dead host  -> a genuine ENOTFOUND/transport failure. The retry must fire
//                    (6 calls, ~12.5s) instead of failing on the first try.
//   2. live host, bogus token_hash -> a genuine otp_expired. This must NOT be
//                    retried: the grant is single-use, so retrying only burns
//                    the backoff window before showing the same error.
//
// Usage: node scripts/verify-auth-retry-real.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, ".logs", "otp-retry-real.mjs");
fs.mkdirSync(path.dirname(tmp), { recursive: true });

// The helper is TypeScript; transpile just it (import-free by design).
// esbuild ships as a .cmd shim on Windows, so run it through the shell.
execFileSync(
  path.join(root, "node_modules", ".bin", "esbuild.cmd"),
  [path.join(root, "app", "app", "lib", "auth", "verify-otp-retry.ts"), "--format=esm", `--outfile=${tmp}`],
  { stdio: "ignore", shell: true }
);
const { verifyOtpWithRetry, isRetryableAuthFetchError } = await import(pathToFileURL(tmp).href);

const { createClient } = await import(
  pathToFileURL(path.join(root, "app", "node_modules", "@supabase", "supabase-js", "dist", "index.mjs")).href
);

const KEY = "test-anon-key-not-a-real-credential";
const LIVE = "https://hrlmsfsifdtvndrgpxth.supabase.co";
const DEAD = "https://no-such-host-9f3a2c1d.supabase.co";
const BOGUS_HASH = "00000000000000000000000000000000";

const clientFor = (url) => createClient(url, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// --- case 1: transport failure must be retried ------------------------------
let calls = 0;
const started1 = Date.now();
const r1 = await verifyOtpWithRetry(() => {
  calls++;
  return clientFor(DEAD).auth.verifyOtp({ token_hash: BOGUS_HASH, type: "magiclink" });
});
const ms1 = Date.now() - started1;
console.log(`dead host: calls=${calls} elapsed=${ms1}ms error=${JSON.stringify(r1.error?.message)}`);

assert.ok(r1.error, "dead host should end in an error");
assert.equal(calls, 6, `expected 6 attempts (the retry must actually fire), got ${calls}`);
assert.ok(ms1 >= 12000, `expected the full ~12.5s backoff window, took only ${ms1}ms`);
assert.ok(
  isRetryableAuthFetchError(r1.error) || /fetch|network/i.test(r1.error.message),
  "the surfaced error should still look like a transport failure"
);

// --- case 2: a real auth failure must NOT be retried -------------------------
let calls2 = 0;
const started2 = Date.now();
const r2 = await verifyOtpWithRetry(() => {
  calls2++;
  return clientFor(LIVE).auth.verifyOtp({ token_hash: BOGUS_HASH, type: "magiclink" });
});
const ms2 = Date.now() - started2;
console.log(`live host: calls=${calls2} elapsed=${ms2}ms error=${JSON.stringify(r2.error?.message)}`);

assert.ok(r2.error, "a bogus token_hash must not yield a session");
assert.equal(calls2, 1, `a real auth error must not be retried, but it was called ${calls2}x`);
assert.ok(ms2 < 5000, `a real auth error should fail fast, took ${ms2}ms`);

fs.rmSync(tmp, { force: true });
console.log("\nRESULT PASS");
// Self-check for the OTP transport retry. No test framework: plain asserts.
// The helper is TypeScript, so esbuild transpiles it to a temp file first and
// this script imports the result.
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SRC = new URL("../app/app/lib/auth/verify-otp-retry.ts", import.meta.url).pathname.replace(/^\//, "");
const out = join(mkdtempSync(join(tmpdir(), "otp-retry-")), "verify-otp-retry.mjs");
await build({
  entryPoints: [SRC],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "neutral",
  logLevel: "silent",
});
const { isRetryableAuthFetchError, verifyOtpWithRetry } = await import(pathToFileURL(out).href);

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` :: ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

// --- classification -----------------------------------------------------------
check("AuthRetryableFetchError is retryable", isRetryableAuthFetchError({ name: "AuthRetryableFetchError" }));
check("status 0 is retryable", isRetryableAuthFetchError({ status: 0 }));
check("503 is retryable", isRetryableAuthFetchError({ status: 503 }));
check("ENOTFOUND cause is retryable", isRetryableAuthFetchError({ cause: { code: "ENOTFOUND" } }));
check("UND_ERR_CONNECT_TIMEOUT is retryable", isRetryableAuthFetchError({ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }));
check("403 is NOT retryable", !isRetryableAuthFetchError({ status: 403, name: "AuthApiError" }));
check("otp_expired is NOT retryable", !isRetryableAuthFetchError({ status: 403, name: "AuthApiError", message: "Email link is invalid or has expired" }));
check("null is NOT retryable", !isRetryableAuthFetchError(null));

// The case actually seen in the field: Chromium's fetch rejects with a bare
// TypeError("Failed to fetch") that supabase-js passed through untouched, so a
// classifier matching only AuthRetryableFetchError would never retry it.
check("bare TypeError('Failed to fetch') is retryable", isRetryableAuthFetchError(new TypeError("Failed to fetch")));
check(
  "plain object {message:'Failed to fetch'} is retryable",
  isRetryableAuthFetchError({ message: "Failed to fetch" })
);
check(
  "'NetworkError when attempting to fetch' is retryable (Chromium wording)",
  isRetryableAuthFetchError(new TypeError("NetworkError when attempting to fetch resource."))
);
check("an unrelated TypeError is NOT retryable", !isRetryableAuthFetchError(new TypeError("x is not a function")));

// --- retry behaviour ----------------------------------------------------------
// Real error object (supabase-js returns, never throws, for transport failures).
{
  let calls = 0;
  const result = await verifyOtpWithRetry(
    async () => {
      calls++;
      if (calls < 3) return { error: { name: "AuthRetryableFetchError", message: "Failed to fetch" } };
      return { error: null, session: { ok: true } };
    },
    [0, 0, 0]
  );
  check("recovers after two transient failures", calls === 3 && result.error === null, `calls=${calls}`);
}

// Exhausted retries surface the last message, not a swallowed success.
{
  let calls = 0;
  const result = await verifyOtpWithRetry(
    async () => {
      calls++;
      return { error: { name: "AuthRetryableFetchError", message: "Failed to fetch" } };
    },
    [0, 0, 0]
  );
  check("gives up after the attempt budget", calls === 3, `calls=${calls}`);
  check("surfaces the failure message", result.error?.message === "Failed to fetch", result.error?.message);
}

// A genuine auth error must not burn retries (the grant is single-use).
{
  let calls = 0;
  const result = await verifyOtpWithRetry(
    async () => {
      calls++;
      return { error: { name: "AuthApiError", status: 403, message: "Email link is invalid or has expired" } };
    },
    [0, 0, 0]
  );
  check("does not retry a real auth error", calls === 1, `calls=${calls}`);
  check("passes the real auth error through", result.error?.message.includes("expired"), result.error?.message);
}

// A thrown retryable error (rather than a returned one) is also handled.
{
  let calls = 0;
  const result = await verifyOtpWithRetry(
    async () => {
      calls++;
      if (calls < 2) throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
      return { error: null };
    },
    [0, 0, 0]
  );
  check("retries a thrown transport error", calls === 2 && result.error === null, `calls=${calls}`);
}

// A thrown non-retryable error propagates instead of being swallowed.
{
  let calls = 0;
  let threw = false;
  try {
    await verifyOtpWithRetry(
      async () => {
        calls++;
        throw new Error("boom");
      },
      [0, 0]
    );
  } catch {
    threw = true;
  }
  check("propagates a non-retryable throw", threw && calls === 1, `calls=${calls} threw=${threw}`);
}

console.log(failures.length ? `\nRESULT FAIL: ${failures.join(", ")}` : "\nRESULT PASS");
process.exit(failures.length ? 1 : 0);
// Retries the Supabase OTP exchange when only the *transport* failed.
//
// The Supabase host resolves unreliably on some networks (main's log shows
// ENOTFOUND and UND_ERR_CONNECT_TIMEOUT for it) and supabase-js reports that as
// AuthRetryableFetchError("Failed to fetch"). Without this the sign-in looks
// finished on the web while the desktop app claims it could not store the
// session. A real auth failure (expired/used grant) is NOT retried: the grant
// is single-use, so retrying it would just waste the backoff window.
//
// Kept free of imports on purpose so it can be unit-checked directly.
//
// ponytail: fixed backoff up to ~1.6s / 4 attempts. Add jitter and a telemetry
// hook only if real failures outlast that window.

const RETRY_DELAYS_MS = [0, 400, 900, 1600];
const RETRYABLE_CODES = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function isRetryableAuthFetchError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name || "";
  const message = (error as { message?: string }).message || "";
  const status = (error as { status?: number }).status;
  const causeCode = (error as { cause?: { code?: string } }).cause?.code;
  if (name === "AuthRetryableFetchError") return true;
  // Chromium's fetch throws TypeError("Failed to fetch") on network failure.
  // supabase-js may or may not wrap it, so match the message directly.
  // Chromium also uses "NetworkError when attempting to fetch resource."
  if (message === "Failed to fetch" || message === "NetworkError when attempting to fetch resource.") return true;
  // A blocked/failed request surfaces as status 0; 5xx is a server blip.
  if (typeof status === "number" && (status === 0 || status >= 500)) return true;
  return Boolean(causeCode && RETRYABLE_CODES.has(causeCode));
}

export async function verifyOtpWithRetry<T extends { error: { message: string } | null }>(
  verify: () => Promise<T>,
  delaysMs: number[] = RETRY_DELAYS_MS
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < delaysMs.length; attempt++) {
    const delay = delaysMs[attempt];
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const result = await verify();
      // Transport failures come back as an error *object*, not a throw.
      if (!result.error || !isRetryableAuthFetchError(result.error)) return result;
      lastError = result.error;
    } catch (error) {
      if (!isRetryableAuthFetchError(error)) throw error;
      lastError = error;
    }
  }
  const message = (lastError as { message?: string } | null)?.message || "Failed to fetch";
  return { error: { message } } as T;
}

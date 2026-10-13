import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * TEMPORARY debug capture: dumps the exact license-proxy request bytes so
 * scripts/license-replay.mjs can replay them. Delete both once the license
 * 403 is diagnosed.
 */
export async function captureLicenseRequest(
  runId: string,
  url: string,
  headers: Record<string, string>,
  body: ArrayBuffer,
): Promise<void> {
  const dir = path.join(process.cwd(), ".logs", "license-capture");
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${runId}.bin`), Buffer.from(body));
    await writeFile(
      path.join(dir, `${runId}.meta.json`),
      JSON.stringify({ runId, url, headers, bytes: body.byteLength }, null, 2),
    );
  } catch {
    // never break a license request because logging failed
  }
}
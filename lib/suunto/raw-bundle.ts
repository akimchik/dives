import { promisify } from "node:util";
import { gunzip, gunzipSync } from "node:zlib";

const gunzipAsync = promisify(gunzip);

// `dives.suunto_original_bundle`/`suunto_imports.original_bundle` are gzip of `{ files }`, one
// file being "workout.sml.json" -- see scripts/suunto-sidecar/server.mjs and
// scripts/backfill-suunto-gas-rate.ts, which this mirrors.
export function extractSmlJson(originalBundle: Buffer): unknown {
  const { files } = JSON.parse(gunzipSync(originalBundle).toString("utf8")) as {
    files: { path: string; contentBase64: string }[];
  };
  const smlFile = files.find((file) => file.path === "workout.sml.json");
  if (!smlFile) throw new Error('bundle has no "workout.sml.json" file');
  return JSON.parse(Buffer.from(smlFile.contentBase64, "base64").toString("utf8"));
}

// Same bundle shape as extractSmlJson, but every file rather than just the SML one -- the dives
// backup zip (lib/backup/dives-zip.ts) archives the raw export verbatim, so a restore isn't limited
// to whatever fields the app happens to parse today.
//
// Async (unlike extractSmlJson, whose sync signature other callers depend on) because the backup
// decodes many bundles in a row: gunzipSync would pin the event loop for the whole batch, which in a
// request handler means every other in-flight request stalls behind it -- and it would also make the
// caller's decode concurrency a no-op, since sync work can't interleave.
export async function extractAllFiles(originalBundle: Buffer): Promise<{ path: string; content: Buffer }[]> {
  const unzipped = await gunzipAsync(originalBundle);
  const { files } = JSON.parse(unzipped.toString("utf8")) as {
    files: { path: string; contentBase64: string }[];
  };
  return files.map((file) => ({ path: file.path, content: Buffer.from(file.contentBase64, "base64") }));
}

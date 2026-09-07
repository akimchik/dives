import { gunzipSync } from "node:zlib";

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

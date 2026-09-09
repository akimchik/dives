import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { extractAllFiles, extractSmlJson } from "@/lib/suunto/raw-bundle";

function bundleOf(files: { path: string; contentBase64: string }[]): Buffer {
  return gzipSync(Buffer.from(JSON.stringify({ files })));
}

describe("extractSmlJson", () => {
  it("gunzips the bundle and parses the workout.sml.json entry", () => {
    const sml = { Data: { Header: { Depth: 12.3 }, Samples: [] } };
    const bundle = bundleOf([
      { path: "workout.sml.json", contentBase64: Buffer.from(JSON.stringify(sml)).toString("base64") },
      { path: "other.txt", contentBase64: Buffer.from("ignored").toString("base64") },
    ]);

    expect(extractSmlJson(bundle)).toEqual(sml);
  });

  it("throws when the bundle has no workout.sml.json file", () => {
    const bundle = bundleOf([{ path: "other.txt", contentBase64: Buffer.from("x").toString("base64") }]);

    expect(() => extractSmlJson(bundle)).toThrow(/workout\.sml\.json/);
  });

  it("throws (rather than silently returning garbage) on a bundle that isn't gzip at all", () => {
    // Mirrors the placeholder bundles integration tests write (see tests/integration/dives.test.ts's
    // stageSuunto helper, which stores a plain "bundle:<workoutKey>" string), which
    // scripts/backfill-suunto-gas-rate.ts already has to skip over rather than crash on.
    const notGzip = Buffer.from("bundle:not-a-real-export");

    expect(() => extractSmlJson(notGzip)).toThrow();
  });
});

describe("extractAllFiles", () => {
  it("returns every file in the bundle with its content base64-decoded", async () => {
    const bundle = bundleOf([
      { path: "workout.sml.json", contentBase64: Buffer.from('{"a":1}').toString("base64") },
      { path: "samples/raw.bin", contentBase64: Buffer.from([0x00, 0xff, 0x10]).toString("base64") },
    ]);

    expect(await extractAllFiles(bundle)).toEqual([
      { path: "workout.sml.json", content: Buffer.from('{"a":1}') },
      { path: "samples/raw.bin", content: Buffer.from([0x00, 0xff, 0x10]) },
    ]);
  });

  it("returns an empty list for a bundle with no files (rather than throwing)", async () => {
    expect(await extractAllFiles(bundleOf([]))).toEqual([]);
  });

  it("rejects on a bundle that isn't gzip at all, like extractSmlJson throws", async () => {
    await expect(extractAllFiles(Buffer.from("bundle:not-a-real-export"))).rejects.toThrow();
  });
});

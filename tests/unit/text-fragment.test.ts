import { describe, expect, it } from "vitest";

import { buildTextFragmentHash } from "@/lib/text-fragment";

describe("buildTextFragmentHash", () => {
  it("percent-encodes the text into a :~:text= directive", () => {
    expect(buildTextFragmentHash("great visibility")).toBe("#:~:text=great%20visibility");
  });

  it("encodes commas, which the spec's grammar treats as a separator", () => {
    expect(buildTextFragmentHash("cold, but clear")).toBe("#:~:text=cold%2C%20but%20clear");
  });
});

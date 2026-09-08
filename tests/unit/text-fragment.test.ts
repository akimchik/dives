import { describe, expect, it } from "vitest";

import { buildTextFragmentHash, findTextOffset, parseBookmarkTextHash } from "@/lib/text-fragment";

describe("buildTextFragmentHash", () => {
  it("pairs a plain bookmark-text= segment with a :~:text= fragment directive", () => {
    expect(buildTextFragmentHash("great visibility")).toBe(
      "#bookmark-text=great%20visibility:~:text=great%20visibility",
    );
  });

  it("encodes commas, which the spec's grammar treats as a separator", () => {
    expect(buildTextFragmentHash("cold, but clear")).toBe(
      "#bookmark-text=cold%2C%20but%20clear:~:text=cold%2C%20but%20clear",
    );
  });
});

describe("parseBookmarkTextHash", () => {
  it("reads back the bookmark-text= segment after the browser has stripped the :~: suffix", () => {
    // Simulates what location.hash actually contains post-navigation (verified against a real
    // Playwright WebKit build): everything from `:~:` onward is gone by the time page JS runs.
    expect(parseBookmarkTextHash("#bookmark-text=great%20visibility")).toBe("great visibility");
  });

  it("returns null when the hash has no bookmark-text= segment", () => {
    expect(parseBookmarkTextHash("#some-section")).toBeNull();
    expect(parseBookmarkTextHash("")).toBeNull();
  });
});

describe("findTextOffset", () => {
  it("finds an exact substring match", () => {
    expect(findTextOffset("Max depth 42 m", "42 m")).toEqual({ start: 10, end: 14 });
  });

  it("returns null when the needle isn't present", () => {
    expect(findTextOffset("Max depth 42 m", "nope")).toBeNull();
  });

  it("returns null for an empty needle", () => {
    expect(findTextOffset("anything", "")).toBeNull();
  });

  it("falls back to a whitespace-collapsed match, returning original-string offsets", () => {
    // Two spaces in the haystack where the bookmarked text only ever had one -- e.g. re-wrapped
    // notes text.
    const haystack = "great  visibility today";
    const match = findTextOffset(haystack, "great visibility");
    expect(match).not.toBeNull();
    expect(haystack.slice(match!.start, match!.end)).toBe("great  visibility");
  });

  it("returns null when even the collapsed haystack doesn't contain the needle", () => {
    expect(findTextOffset("completely different text", "great visibility")).toBeNull();
  });
});

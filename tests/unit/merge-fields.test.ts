import { describe, expect, it } from "vitest";

import { decimalPrecision, mergeFieldHasData, pickMergeSource } from "@/lib/merge-fields";

const NONE = "__none__";

describe("decimalPrecision", () => {
  it("counts digits after the decimal point", () => {
    expect(decimalPrecision("23.7")).toBe(1);
    expect(decimalPrecision("23.75")).toBe(2);
  });

  it("treats a whole number as zero precision", () => {
    expect(decimalPrecision("24")).toBe(0);
  });
});

describe("mergeFieldHasData", () => {
  it("treats booleans and numbers as always populated", () => {
    expect(mergeFieldHasData(false, NONE)).toBe(true);
    expect(mergeFieldHasData(true, NONE)).toBe(true);
    expect(mergeFieldHasData(0, NONE)).toBe(true);
  });

  it("treats null, blank strings and the empty-choice sentinel as unpopulated", () => {
    expect(mergeFieldHasData(null, NONE)).toBe(false);
    expect(mergeFieldHasData("", NONE)).toBe(false);
    expect(mergeFieldHasData("   ", NONE)).toBe(false);
    expect(mergeFieldHasData(NONE, NONE)).toBe(false);
  });

  it("treats a non-blank string as populated", () => {
    expect(mergeFieldHasData("23.7", NONE)).toBe(true);
  });

  it("treats an empty array as unpopulated and a non-empty one as populated", () => {
    expect(mergeFieldHasData([], NONE)).toBe(false);
    expect(mergeFieldHasData(["wreck"], NONE)).toBe(true);
  });

  it("treats a dive site as populated only when some field carries data", () => {
    expect(mergeFieldHasData({ siteId: null, name: "", location: "", lat: "", lng: "" }, NONE)).toBe(false);
    expect(mergeFieldHasData({ siteId: null, name: "Blue Hole", location: "", lat: "", lng: "" }, NONE)).toBe(true);
    expect(mergeFieldHasData({ siteId: 42, name: "", location: "", lat: "", lng: "" }, NONE)).toBe(true);
  });
});

describe("pickMergeSource", () => {
  it("prefers whichever side has data over the side without", () => {
    expect(pickMergeSource("23.7", "", { emptyChoiceValue: NONE, comparePrecision: true })).toBe("import");
    expect(pickMergeSource("", "18.2", { emptyChoiceValue: NONE, comparePrecision: true })).toBe("target");
  });

  it("prefers the more precise reading when both sides have data", () => {
    // Dive computer reading beats a rounder hand-typed value.
    expect(pickMergeSource("23.7", "24", { emptyChoiceValue: NONE, comparePrecision: true })).toBe("import");
    expect(pickMergeSource("24", "18.25", { emptyChoiceValue: NONE, comparePrecision: true })).toBe("target");
  });

  it("does not compare precision for fields where it is not requested", () => {
    // bottomTimeMinutes-style field: both look like whole numbers, comparePrecision is off.
    expect(pickMergeSource("45", "50", { emptyChoiceValue: NONE, comparePrecision: false })).toBe("import");
  });

  it("falls back to import when both sides are equally precise or both empty", () => {
    expect(pickMergeSource("23.7", "18.2", { emptyChoiceValue: NONE, comparePrecision: true })).toBe("import");
    expect(pickMergeSource("", "", { emptyChoiceValue: NONE, comparePrecision: true })).toBe("import");
    expect(pickMergeSource(NONE, NONE, { emptyChoiceValue: NONE, comparePrecision: false })).toBe("import");
  });
});

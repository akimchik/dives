import { describe, expect, it } from "vitest";

import { computeGasConsumption } from "@/lib/gas-consumption";

describe("computeGasConsumption", () => {
  it("computes gas used and SAC rate for a typical recreational dive", () => {
    // 200 bar -> 50 bar on a 12L cylinder = 1800L used. 18m average depth = 2.8 ATA.
    // 40 minutes bottom time: SAC = 1800 / 40 / 2.8 ≈ 16.07 L/min.
    const result = computeGasConsumption({
      startPressure: 200,
      endPressure: 50,
      cylinderSize: 12,
      avgDepth: 18,
      bottomTimeMinutes: 40,
    });

    expect(result).not.toBeNull();
    expect(result!.gasUsedLiters).toBeCloseTo(1800, 5);
    expect(result!.startLiters).toBeCloseTo(2400, 5);
    expect(result!.sacRateLitersPerMin).toBeCloseTo(16.0714, 3);
  });

  it("treats surface (0m) as exactly 1 ATA, not a divide-by-zero", () => {
    const result = computeGasConsumption({
      startPressure: 200,
      endPressure: 150,
      cylinderSize: 10,
      avgDepth: 0,
      bottomTimeMinutes: 10,
    });

    expect(result).not.toBeNull();
    expect(result!.gasUsedLiters).toBe(500);
    expect(result!.startLiters).toBe(2000);
    expect(result!.sacRateLitersPerMin).toBeCloseTo(50, 5);
  });

  it("returns null when any required input is missing", () => {
    const complete = {
      startPressure: 200,
      endPressure: 50,
      cylinderSize: 12,
      avgDepth: 18,
      bottomTimeMinutes: 40,
    };

    for (const key of Object.keys(complete) as (keyof typeof complete)[]) {
      expect(computeGasConsumption({ ...complete, [key]: null })).toBeNull();
    }
  });

  it("returns null for physically impossible or degenerate inputs", () => {
    // End pressure not below start (nothing consumed, or a data-entry mistake) -- not a real rate.
    expect(
      computeGasConsumption({
        startPressure: 100,
        endPressure: 100,
        cylinderSize: 12,
        avgDepth: 18,
        bottomTimeMinutes: 40,
      }),
    ).toBeNull();
    expect(
      computeGasConsumption({
        startPressure: 100,
        endPressure: 150,
        cylinderSize: 12,
        avgDepth: 18,
        bottomTimeMinutes: 40,
      }),
    ).toBeNull();

    // Zero bottom time or cylinder size would divide by zero.
    expect(
      computeGasConsumption({
        startPressure: 200,
        endPressure: 50,
        cylinderSize: 12,
        avgDepth: 18,
        bottomTimeMinutes: 0,
      }),
    ).toBeNull();
    expect(
      computeGasConsumption({
        startPressure: 200,
        endPressure: 50,
        cylinderSize: 0,
        avgDepth: 18,
        bottomTimeMinutes: 40,
      }),
    ).toBeNull();
  });
});

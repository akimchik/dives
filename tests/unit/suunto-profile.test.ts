import { describe, expect, it } from "vitest";

import { compileSuuntoDiveProfile, isSuuntoDiveProfile } from "@/lib/suunto/profile";

const fixture = {
  Data: {
    Samples: [
      {
        TimeISO8601: "2026-08-30T10:40:08.250+02:00",
        Attributes: {
          "suunto/sml": {
            Sample: {
              Depth: 1.42,
              Cylinders: [{ Pressure: 18460938 }],
            },
          },
        },
      },
      {
        TimeISO8601: "2026-08-30T10:41:08.250+02:00",
        Attributes: {
          "suunto/sml": {
            Sample: {
              Depth: 8.82,
              Temperature: 293.02,
              Cylinders: [{ Pressure: 17000000 }],
            },
          },
        },
      },
      {
        TimeISO8601: "2026-08-30T10:42:08.250+02:00",
        Attributes: {
          "suunto/sml": {
            Sample: {
              Depth: 5.1,
              Temperature: 292.1,
              Cylinders: [{ Pressure: 9410938 }],
            },
          },
        },
      },
    ],
  },
  Summary: {
    Samples: [
      {
        Attributes: {
          "suunto/sml": {
            DiveHeader: { Gases: [{ Oxygen: 21, TankFillPressure: 23200000, TankSize: 0.014 }] },
            DiveFooter: { Gases: [{ StartPressure: 18460938, EndPressure: 9410938 }] },
            Windows: [
              {
                DiveTime: 3218.8,
                Duration: 3866.5,
                Depth: [{ Max: 8.82, Avg: 4.2 }],
                Temperature: [{ Avg: 293.2 }],
              },
            ],
          },
        },
      },
    ],
  },
};

describe("compileSuuntoDiveProfile", () => {
  it("extracts depth, temperature, pressure and gas consumption points", () => {
    const result = compileSuuntoDiveProfile("6tv4q2ak4ksqlrth", fixture);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    expect(isSuuntoDiveProfile(result.profile)).toBe(true);
    expect(result.profile.workoutKey).toBe("6tv4q2ak4ksqlrth");
    expect(result.profile.startedAt).toBe("2026-08-30T08:40:08.250Z");
    expect(result.profile.maxDepth).toBe(8.82);
    expect(result.profile.averageDepth).toBe(4.2);
    expect(result.profile.durationMinutes).toBe(53.6);
    expect(result.profile.waterTemperature).toBe(19.9);
    expect(result.profile.waterTemperatureLow).toBe(19);
    expect(result.profile.tankStartPressure).toBe(184.6);
    expect(result.profile.tankEndPressure).toBe(94.1);
    expect(result.profile.tankSizeLitres).toBe(14);
    expect(result.profile.gasMix).toBe("Air 21% O₂");
    expect(result.profile.points.at(-1)).toMatchObject({ depth: 5.1, tankPressure: 94.1, gasConsumption: 90.5 });
    expect(result.profile.depthProfile).toEqual([
      { time: 0, depth: 1.42 },
      { time: 1, depth: 8.82 },
      { time: 2, depth: 5.1 },
    ]);
    expect(result.draftDive).toMatchObject({
      occurredAt: "2026-08-30T08:40:08.250Z",
      maxDepth: 8.82,
      bottomTimeMinutes: 54,
      startPressure: 184.6,
      endPressure: 94.1,
      cylinderSize: 14,
    });
  });

  it("rejects non-dive workouts even when they have Data.Samples", () => {
    const result = compileSuuntoDiveProfile("run", { Data: { Samples: [{ Sample: { Speed: 1 } }] } });
    expect(result).toEqual({ ok: false, error: "Suunto workout does not look like a dive SML export." });
  });
});

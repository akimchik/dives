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
    expect(result.profile.gasMix).toBe("Air");
    expect(result.profile.points.map((point) => point.gasConsumptionRate)).toEqual([null, 14.6, 75.9]);
    expect(result.profile.points.map((point) => point.surfaceConsumptionRate)).toEqual([null, 108.61, 703.71]);
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

  it("combines split summary rows and surfaces Suunto GPS coordinates", () => {
    const result = compileSuuntoDiveProfile("split", {
      Data: fixture.Data,
      Summary: {
        Samples: [
          { Attributes: { "suunto/sml": { DiveHeader: { Gases: [{ Oxygen: 21, TankFillPressure: 23200000, TankSize: 0.014 }] } } } },
          {
            Attributes: {
              "suunto/sml": {
                DiveFooter: {
                  Gases: [{ StartPressure: 18460938, EndPressure: 9410938 }],
                  DiveLocation: { Stop: { Latitude: 0.9031027318196329, Longitude: 0.0678412674202727 } },
                  LastKnownCoordinates: { Latitude: 0.9140264491565633, Longitude: 0.09079550612994425 },
                },
              },
            },
          },
          { Attributes: { "suunto/sml": { Windows: [{ Type: "Dive", DiveTime: 3218.8, Depth: [{ Avg: 2.32, Max: 8.82 }] }] } } },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    expect(result.profile.averageDepth).toBe(2.32);
    expect(result.profile.durationMinutes).toBe(53.6);
    expect(result.profile.tankEndPressure).toBe(94.1);
    expect(result.profile.gasMix).toBe("Air");
    expect(result.profile.location).toEqual({ lat: 51.743975, lng: 3.887018 });
    expect(result.draftDive.site).toMatchObject({
      name: "Suunto GPS 51.7440, 3.8870",
      location: "51.743975, 3.887018",
      lat: 51.743975,
      lng: 3.887018,
    });
  });

  it("ignores lone LastKnownCoordinates because they can be stale from another workout", () => {
    const result = compileSuuntoDiveProfile("stale-location", {
      Data: {
        Samples: [
          {
            TimeISO8601: "2026-08-30T10:40:08.250+02:00",
            Attributes: {
              "suunto/sml": {
                Sample: {
                  Depth: 1,
                  DiveRouteOrigin: { Latitude: 0, Longitude: 0 },
                },
              },
            },
          },
          {
            TimeISO8601: "2026-08-30T10:41:08.250+02:00",
            Attributes: { "suunto/sml": { Sample: { Depth: 8 } } },
          },
        ],
      },
      Summary: {
        Samples: [
          {
            Attributes: {
              "suunto/sml": {
                DiveFooter: {
                  DiveLocation: {
                    Start: { Latitude: null, Longitude: null },
                    Stop: { Latitude: null, Longitude: null },
                  },
                  LastKnownCoordinates: { Latitude: 0.9140264491565633, Longitude: 0.09079550612994425 },
                },
                Windows: [{ Type: "Dive", DiveTime: 1800, Depth: [{ Max: 8, Avg: 4 }] }],
              },
            },
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.profile.location).toBeNull();
    expect(result.draftDive.site).toBeNull();
  });

  it("prefers workout-scoped route coordinates over footer LastKnownCoordinates", () => {
    const result = compileSuuntoDiveProfile("route-location", {
      Data: {
        Samples: [
          {
            TimeISO8601: "2026-08-30T10:40:08.250+02:00",
            Attributes: {
              "suunto/sml": {
                Sample: {
                  Depth: 1,
                  DiveRouteOrigin: { Latitude: 51.70314025878906, Longitude: 4.0082502365112305 },
                },
              },
            },
          },
          {
            TimeISO8601: "2026-08-30T10:41:08.250+02:00",
            Attributes: { "suunto/sml": { Sample: { Depth: 8 } } },
          },
        ],
      },
      Summary: {
        Samples: [
          {
            Attributes: {
              "suunto/sml": {
                DiveFooter: {
                  LastKnownCoordinates: { Latitude: 0.9140264491565633, Longitude: 0.09079550612994425 },
                },
                Windows: [{ Type: "Dive", DiveTime: 1800, Depth: [{ Max: 8, Avg: 4 }] }],
              },
            },
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.profile.location).toEqual({ lat: 51.70314, lng: 4.00825 });
  });

  it("rejects non-dive workouts even when they have Data.Samples", () => {
    const result = compileSuuntoDiveProfile("run", { Data: { Samples: [{ Sample: { Speed: 1 } }] } });
    expect(result).toEqual({ ok: false, error: "Suunto workout does not look like a dive SML export." });
  });

  it("windows gasConsumptionRate over a real trailing minute instead of just adjacent samples", () => {
    // Dense (20s) sampling at a constant 30 bar/min burn, plus a final sample after a 90s gap --
    // wide enough that no prior sample falls inside its trailing 1-minute window. A naive
    // adjacent-sample diff would report a rate at every point (including a wrong ~20 bar/min at
    // the 90s-gap sample); the real two-pointer window should instead report null until a full
    // minute of history exists, and null again once the gap exceeds the window.
    const pressureSample = (secondsOffset: number, bar: number) => ({
      TimeISO8601: new Date(Date.parse("2026-08-30T10:40:08.250+02:00") + secondsOffset * 1000).toISOString(),
      Attributes: {
        "suunto/sml": { Sample: { Depth: 10, Cylinders: [{ Pressure: bar * 100000 }] } },
      },
    });

    const result = compileSuuntoDiveProfile("dense-window", {
      Data: {
        Samples: [
          pressureSample(0, 250),
          pressureSample(20, 240),
          pressureSample(40, 230),
          pressureSample(60, 220),
          pressureSample(150, 190),
        ],
      },
      Summary: {
        Samples: [
          {
            Attributes: {
              "suunto/sml": {
                DiveFooter: { Gases: [{ StartPressure: 25000000, EndPressure: 19000000 }] },
                Windows: [{ Type: "Dive", DiveTime: 150, Depth: [{ Max: 10, Avg: 10 }] }],
              },
            },
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.profile.points.map((point) => point.gasConsumptionRate)).toEqual([
      null, // t=0: no history at all
      null, // t=20s: less than a full minute of history -- suppressed, not a noisy partial rate
      null, // t=40s: same
      30, // t=60s: first full 1-minute window, correctly averages to the true 30 bar/min rate
      null, // t=150s: nearest prior sample is 90s back, outside the 1-minute window -- no rate
    ]);
    // This fixture's DiveHeader has no TankSize, so surfaceConsumptionRate can't be converted to
    // L/min -- it must degrade to null across the board rather than silently mixing units with a
    // missing conversion factor, even at t=60s where gasConsumptionRate itself is a real 30.
    expect(result.profile.points.every((point) => point.surfaceConsumptionRate === null)).toBe(true);
  });

  it("normalizes the surface consumption rate by depth so it isn't just a rescaled gasConsumptionRate", () => {
    // Same 30 bar/min burn as the dense-window fixture above, but now with a TankSize so
    // surfaceConsumptionRate (SAC, L/min) can be computed, and two different depths at the two
    // points that actually get a gasConsumptionRate -- proving the depth-normalization (ataAtDepth)
    // is really applied per-point rather than using one fixed depth for the whole dive.
    const pressureSample = (secondsOffset: number, bar: number, depth: number) => ({
      TimeISO8601: new Date(Date.parse("2026-08-30T10:40:08.250+02:00") + secondsOffset * 1000).toISOString(),
      Attributes: {
        "suunto/sml": { Sample: { Depth: depth, Cylinders: [{ Pressure: bar * 100000 }] } },
      },
    });

    const result = compileSuuntoDiveProfile("surface-rate", {
      Data: {
        Samples: [
          pressureSample(0, 250, 20),
          pressureSample(60, 220, 20), // ata(20m) = 3
          pressureSample(120, 190, 40), // ata(40m) = 5
        ],
      },
      Summary: {
        Samples: [
          {
            Attributes: {
              "suunto/sml": {
                DiveHeader: { Gases: [{ TankFillPressure: 25000000, TankSize: 0.012 }] },
                DiveFooter: { Gases: [{ StartPressure: 25000000, EndPressure: 19000000 }] },
                Windows: [{ Type: "Dive", DiveTime: 120, Depth: [{ Max: 40, Avg: 30 }] }],
              },
            },
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.profile.tankSizeLitres).toBe(12);
    // Both points burn gas at the same 30 bar/min, so with a fixed depth the two surface rates
    // would be identical -- they aren't, because ata(20m)=3 and ata(40m)=5 pull them apart.
    expect(result.profile.points.map((point) => point.gasConsumptionRate)).toEqual([null, 30, 30]);
    expect(result.profile.points.map((point) => point.surfaceConsumptionRate)).toEqual([null, 120, 72]);
  });
});

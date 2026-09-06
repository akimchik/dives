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
});

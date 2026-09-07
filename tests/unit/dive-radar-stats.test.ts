import { describe, expect, it } from "vitest";

import { buildDiveRadarStats } from "@/lib/dive-radar-stats";
import type { DiveRecord } from "@/lib/dives";

// A minimal, fully-populated dive so each test only needs to override the fields it cares about --
// mirrors the fixture-factory pattern used by tests/unit/merge-fields.test.ts's NONE sentinel, but
// for the wider DiveRecord shape.
function makeDive(overrides: Partial<DiveRecord>): DiveRecord {
  return {
    id: 1,
    title: null,
    occurred_at: new Date("2026-01-15T09:00:00Z"),
    max_depth: null,
    avg_depth: null,
    bottom_time_minutes: null,
    water_temp: null,
    water_temp_low: null,
    air_temp: null,
    visibility: null,
    gas_mix: null,
    tank_info: null,
    cylinder_size: null,
    start_pressure: null,
    end_pressure: null,
    weight: null,
    weight_feedback: null,
    suit_type: null,
    hood: null,
    gloves: null,
    boots: null,
    buddy: null,
    dive_shop: null,
    current: null,
    surge: null,
    waves: null,
    weather: null,
    water_type: null,
    body_of_water: null,
    entry_type: null,
    notes: null,
    rating: null,
    depth_profile: null,
    depth_profile_raw: null,
    created_at: new Date("2026-01-15T09:00:00Z"),
    updated_at: new Date("2026-01-15T09:00:00Z"),
    padi_dive_id: null,
    dive_number: null,
    padi_member_number: null,
    adventure_dive: null,
    dive_type: null,
    log_type: null,
    log_course: null,
    padi_status: null,
    padi_needs_update: false,
    padi_last_compared_at: null,
    suunto_workout_key: null,
    suunto_profile: null,
    tags: [],
    site_name: null,
    site_location: null,
    site_lat: null,
    site_lng: null,
    dive_site_id: null,
    ...overrides,
  };
}

describe("buildDiveRadarStats", () => {
  it("returns twelve zeroed months and a domain of [0, 1] when there are no dives", () => {
    const stats = buildDiveRadarStats([]);

    expect(stats.divesPerMonth.data).toHaveLength(12);
    expect(stats.divesPerMonth.data.every((point) => point.value === 0)).toBe(true);
    expect(stats.divesPerMonth.domain).toEqual([0, 1]);
    expect(stats.depthPerMonth.data.every((point) => point.value === null)).toBe(true);
  });

  it("buckets dives by calendar month regardless of year", () => {
    const stats = buildDiveRadarStats([
      makeDive({ occurred_at: new Date("2023-03-10T00:00:00Z") }),
      makeDive({ occurred_at: new Date("2026-03-20T00:00:00Z") }),
      makeDive({ occurred_at: new Date("2026-07-01T00:00:00Z") }),
    ]);

    const march = stats.divesPerMonth.data.find((point) => point.month === "Mar")!;
    const july = stats.divesPerMonth.data.find((point) => point.month === "Jul")!;
    const jan = stats.divesPerMonth.data.find((point) => point.month === "Jan")!;

    expect(march.value).toBe(2);
    expect(july.value).toBe(1);
    expect(jan.value).toBe(0);
  });

  it("averages numeric properties per month and adds 10% headroom to the domain max", () => {
    const stats = buildDiveRadarStats([
      makeDive({ occurred_at: new Date("2026-01-05T00:00:00Z"), max_depth: "20" }),
      makeDive({ occurred_at: new Date("2026-01-20T00:00:00Z"), max_depth: "30" }),
    ]);

    const jan = stats.depthPerMonth.data.find((point) => point.month === "Jan")!;
    expect(jan.value).toBeCloseTo(25, 5);
    expect(stats.depthPerMonth.domain).toEqual([0, 30 * 1.1]);
  });

  it("scales duration as 5 minutes .. longest dive + 15 minutes, per issue #7", () => {
    const stats = buildDiveRadarStats([
      makeDive({ occurred_at: new Date("2026-05-01T00:00:00Z"), bottom_time_minutes: 45 }),
    ]);

    expect(stats.durationPerMonth.domain).toEqual([5, 60]);
  });

  it("floors the duration domain at 5 minutes even with no dives", () => {
    const stats = buildDiveRadarStats([]);
    expect(stats.durationPerMonth.domain).toEqual([5, 20]);
  });

  it("computes SAC rate per dive before averaging by month", () => {
    // 200 -> 50 bar on a 12L cylinder at 18m avg depth for 40 min => 16.0714 L/min (see
    // gas-consumption.test.ts for the same worked example).
    const stats = buildDiveRadarStats([
      makeDive({
        occurred_at: new Date("2026-02-01T00:00:00Z"),
        start_pressure: "200",
        end_pressure: "50",
        cylinder_size: "12",
        avg_depth: "18",
        bottom_time_minutes: 40,
      }),
    ]);

    const feb = stats.sacRatePerMonth.data.find((point) => point.month === "Feb")!;
    expect(feb.value).toBeCloseTo(16.0714, 3);
  });

  it("pairs high and low water temperature series by month", () => {
    const stats = buildDiveRadarStats([
      makeDive({
        occurred_at: new Date("2026-08-01T00:00:00Z"),
        water_temp: "28",
        water_temp_low: "24",
      }),
    ]);

    const aug = stats.waterTempPerMonth.data.find((point) => point.month === "Aug")!;
    expect(aug.high).toBe(28);
    expect(aug.low).toBe(24);
    expect(stats.waterTempPerMonth.domain).toEqual([0, 28 * 1.1]);
  });

  it("normalises conditions to a 0-100 share of each metric's own scale", () => {
    const stats = buildDiveRadarStats([
      makeDive({ current: "Strong", surge: "None", rating: 5, air_temp: "20" }),
      makeDive({ current: "Strong", surge: "Moderate", rating: 3, air_temp: "30" }),
    ]);

    const byMetric = Object.fromEntries(stats.conditions.data.map((point) => [point.metric, point]));

    // Strong (index 3) both times -> 100% of the 0..3 intensity scale.
    expect(byMetric["Current"].value).toBeCloseTo(100, 5);
    // None (0) and Moderate (2) average to 1, i.e. 1/3 of the scale.
    expect(byMetric["Surge"].value).toBeCloseTo((1 / 3) * 100, 5);
    // Rating averages to 4/5 = 80%.
    expect(byMetric["Rating"].value).toBeCloseTo(80, 5);
    // Air temp is normalised against its own observed max (30), so the average (25) is ~83.3%.
    expect(byMetric["Air temp"].value).toBeCloseTo((25 / 30) * 100, 3);
    // Waves was never recorded on either dive.
    expect(byMetric["Waves"].value).toBeNull();
    expect(stats.conditions.domain).toEqual([0, 100]);
  });

  it("ignores dives that never recorded a given property instead of treating them as zero", () => {
    const stats = buildDiveRadarStats([
      makeDive({ occurred_at: new Date("2026-04-01T00:00:00Z"), max_depth: null }),
      makeDive({ occurred_at: new Date("2026-04-02T00:00:00Z"), max_depth: "18" }),
    ]);

    const apr = stats.depthPerMonth.data.find((point) => point.month === "Apr")!;
    expect(apr.value).toBe(18);
  });
});

import "server-only";

import type { DiveRecord } from "@/lib/dives";
import { mapDiveToPadiUpdatePayload, type PadiUpdatePayload } from "./create";
import type { PadiLogbookDetail } from "./field-map";

type ComparablePayload = Omit<PadiUpdatePayload, "id">;
type ComparableValue = string | number | boolean | null;

function first<T>(items: T[] | null | undefined): Partial<T> {
  return items?.[0] ?? {};
}

function padiDateForUpdate(diveDate: string | null): string | null {
  if (!diveDate) return null;
  const date = new Date(`${diveDate}Z`);
  if (Number.isNaN(date.getTime())) return null;
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${month}/${day}/${date.getUTCFullYear()}`;
}

function padiAdditionalEquipment(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const ordered = ["Hood", "Gloves", "Boots"].filter((item) => value.includes(item));
  return ordered.length > 0 ? `{${ordered.join(",")}}` : null;
}

function remoteComparable(record: PadiLogbookDetail): ComparablePayload {
  const depthTime = first(record.depth_times);
  const conditions = first(record.conditions);
  const equipment = first(record.equipment);
  const experience = first(record.experiences);

  return {
    general: {
      log_type: record.log_type ?? null,
      log_course: record.log_course ?? null,
      log_number: record.log_number ?? null,
      dive_type: record.dive_type ?? null,
      dive_title: record.dive_title ?? null,
      dive_location: record.dive_location ?? null,
      dive_date: padiDateForUpdate(record.dive_date),
      status: record.status ?? null,
      memsys_member_number: record.memsys_member_number ?? null,
      adventure_dive: record.adventure_dive ? true : null,
    },
    depthTime: {
      bottom_time: depthTime.bottom_time ?? null,
      max_depth: depthTime.max_depth ?? null,
    },
    conditions: {
      water_type: conditions.water_type ?? null,
      body_of_water: conditions.body_of_water ?? null,
      weather: conditions.weather ?? null,
      air_temp: conditions.air_temp ?? null,
      surface_water_temp: conditions.surface_water_temp ?? null,
      bottom_water_temp: conditions.bottom_water_temp ?? null,
      visibility: conditions.visibility ?? null,
      visibility_distance: conditions.visibility_distance ?? null,
      wave_condition: conditions.wave_condition ?? null,
      current: conditions.current ?? null,
      surge: conditions.surge ?? null,
    },
    equipment: {
      starting_pressure: equipment.starting_pressure ?? null,
      ending_pressure: equipment.ending_pressure ?? null,
      suit_type: equipment.suit_type ?? null,
      weight: equipment.weight ?? null,
      weight_type: equipment.weight_type ?? null,
      additional_equipment: padiAdditionalEquipment(equipment.additional_equipment),
      cylinder_type: equipment.cylinder_type ?? null,
      cylinder_size: equipment.cylinder_size ?? null,
      gas_mixture: equipment.gas_mixture ?? null,
      oxygen: equipment.oxygen ?? null,
      nitrogen: equipment.nitrogen ?? null,
      helium: equipment.helium ?? null,
    },
    experience: {
      feeling: experience.feeling ?? null,
      notes: experience.notes ?? null,
      buddies: experience.buddies ?? null,
      dive_center: experience.dive_center ?? null,
    },
  };
}

function localComparable(dive: DiveRecord, affiliateId: string | number): ComparablePayload | null {
  const payload = mapDiveToPadiUpdatePayload(dive, affiliateId, new Date("2000-01-01T00:00:00.000Z"));
  if (!payload) return null;

  const { general, ...rest } = payload;
  const { affiliate_id: _affiliateId, update_date: _updateDate, ...comparableGeneral } = general;
  return { general: comparableGeneral, ...rest };
}

function normalizeValue(value: ComparableValue): ComparableValue {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
  }
  return value;
}

function equalValues(left: ComparableValue, right: ComparableValue): boolean {
  const normalizedLeft = normalizeValue(left);
  const normalizedRight = normalizeValue(right);
  if (typeof normalizedLeft === "number" && typeof normalizedRight === "number") {
    return Math.abs(normalizedLeft - normalizedRight) < 0.001;
  }
  return normalizedLeft === normalizedRight;
}

export function isPadiRecreationalRecord(record: Pick<PadiLogbookDetail, "log_type" | "log_course">): boolean {
  return record.log_type === "Recreational" && record.log_course === null;
}

export function padiDiffersFromLocal(dive: DiveRecord, record: PadiLogbookDetail, affiliateId: string | number): boolean {
  const local = localComparable(dive, affiliateId);
  if (!local) return false;

  const remote = remoteComparable(record);
  const sections: Array<keyof ComparablePayload> = ["general", "depthTime", "conditions", "equipment", "experience"];

  return sections.some((section) => {
    const localSection = local[section];
    const remoteSection = remote[section];
    return Object.entries(localSection).some(([key, localValue]) => {
      const remoteValue = remoteSection[key] ?? null;
      return !equalValues(localValue, remoteValue as ComparableValue);
    });
  });
}

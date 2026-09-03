// Presentation helpers shared by the logbook list, detail and dashboard screens.
//
// Numeric dive columns come back from `pg` as strings (numeric(5,2) is not silently coerced to a
// JS float, so precision is preserved), which means "12.40" must be tidied for display rather than
// printed raw. Everything here tolerates null, because almost every dive column is optional.

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDiveDate(value: Date | string): string {
  return dateFormatter.format(new Date(value));
}

export function formatDiveTime(value: Date | string): string {
  return timeFormatter.format(new Date(value));
}

/** "12.40" -> "12.4", "12.00" -> "12"; null/blank stays null so callers can render an em dash. */
export function trimNumeric(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;

  return String(numeric);
}

/** Appends a unit only when there is actually a value to append it to. */
export function formatMeasurement(
  value: string | number | null | undefined,
  unit: string,
): string | null {
  const trimmed = trimNumeric(value);
  return trimmed === null ? null : `${trimmed}${unit}`;
}

/** 95 -> "1h 35m", 45 -> "45m", 120 -> "2h". */
export function formatMinutes(total: number | null | undefined): string | null {
  if (total === null || total === undefined || !Number.isFinite(total)) return null;

  const minutes = Math.max(0, Math.round(total));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

/** The `datetime-local` input's value format ("2026-09-03T14:30") in the *viewer's* local time. */
export function toDateTimeLocalValue(value: Date | string): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

// Deciding which side of a Suunto-import merge should be preselected, before the user overrides
// anything by hand. A field with data always beats an empty one, and between two populated
// numeric readings the one recorded with more decimal precision wins (a dive computer's "23.7"
// beats a hand-typed "24") -- trimNumeric has already stripped trailing zeros by the time these
// strings reach here, so decimal digits reflect actually-recorded precision, not formatting noise.

export type MergeSource = "import" | "target";

type SiteLikeValue = {
  siteId: number | null;
  name: string;
  location: string;
  lat: string;
  lng: string;
};

export type MergeFieldValue = string | number | boolean | string[] | SiteLikeValue | null;

export function decimalPrecision(value: string): number {
  const dot = value.indexOf(".");
  return dot === -1 ? 0 : value.length - dot - 1;
}

export function mergeFieldHasData(value: MergeFieldValue, emptyChoiceValue: string): boolean {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return true;
  if (value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value !== emptyChoiceValue && value.trim() !== "";

  return Boolean(value.siteId !== null || value.name.trim() || value.location.trim() || value.lat.trim() || value.lng.trim());
}

export function pickMergeSource(
  importValue: MergeFieldValue,
  targetValue: MergeFieldValue,
  options: { emptyChoiceValue: string; comparePrecision: boolean },
): MergeSource {
  const importHasData = mergeFieldHasData(importValue, options.emptyChoiceValue);
  const targetHasData = mergeFieldHasData(targetValue, options.emptyChoiceValue);
  if (importHasData !== targetHasData) return importHasData ? "import" : "target";
  if (!importHasData) return "import";

  if (options.comparePrecision && typeof importValue === "string" && typeof targetValue === "string") {
    const importPrecision = decimalPrecision(importValue);
    const targetPrecision = decimalPrecision(targetValue);
    if (importPrecision !== targetPrecision) return importPrecision > targetPrecision ? "import" : "target";
  }

  return "import";
}

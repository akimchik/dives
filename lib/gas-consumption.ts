// Surface Air Consumption (SAC) rate: the standard way divers normalise gas use across dives of
// different depth/duration so they're actually comparable. Metric convention: pressure in bar,
// cylinder size in litres, depth in metres, +1 atmosphere absolute (ATA) per 10m of seawater.
export type GasConsumptionInput = {
  startPressure: number | null;
  endPressure: number | null;
  cylinderSize: number | null;
  avgDepth: number | null;
  bottomTimeMinutes: number | null;
};

export type GasConsumptionResult = {
  gasUsedLiters: number;
  sacRateLitersPerMin: number;
};

/** Ambient pressure in atmospheres absolute at a given depth in metres of seawater. */
export function ataAtDepth(depthMetres: number): number {
  return depthMetres / 10 + 1;
}

/** Returns null whenever any required input is missing or the numbers can't produce a real rate. */
export function computeGasConsumption(input: GasConsumptionInput): GasConsumptionResult | null {
  const { startPressure, endPressure, cylinderSize, avgDepth, bottomTimeMinutes } = input;

  if (
    startPressure === null ||
    endPressure === null ||
    cylinderSize === null ||
    avgDepth === null ||
    bottomTimeMinutes === null
  ) {
    return null;
  }

  if (startPressure <= endPressure || cylinderSize <= 0 || bottomTimeMinutes <= 0 || avgDepth < 0) {
    return null;
  }

  const gasUsedLiters = (startPressure - endPressure) * cylinderSize;
  const sacRateLitersPerMin = gasUsedLiters / bottomTimeMinutes / ataAtDepth(avgDepth);

  return { gasUsedLiters, sacRateLitersPerMin };
}

/** Display-only number formatting. Never feed the result back into a payload. */
export function formatNumber(value: number, maxDecimals = 6): string {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Number(value.toFixed(maxDecimals));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** Coordinates in millimetres: rounds float noise (1.0000000000000002, -1.2e-16) and trims zeros. */
export function formatCoordinates(values: readonly number[] | null | undefined, maxDecimals = 6): string {
  return values ? values.map((v) => formatNumber(v, maxDecimals)).join(", ") : "unknown";
}

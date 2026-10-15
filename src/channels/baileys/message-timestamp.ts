/** Convert Baileys/protobuf timestamp values to numeric Unix seconds. */
export function messageTimestampToSeconds(value: unknown, fallback: number): number {
  const asFiniteNumber = (candidate: unknown): number | undefined =>
    typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;

  const parseString = (candidate: string): number | undefined => {
    const trimmed = candidate.trim();
    if (!trimmed) return undefined;
    return asFiniteNumber(Number(trimmed));
  };

  if (typeof value === "number") return asFiniteNumber(value) ?? fallback;
  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : fallback;
  }
  if (typeof value === "string") return parseString(value) ?? fallback;
  if (typeof value !== "object" || value === null) return fallback;

  const longValue = value as { toNumber?: unknown; toString?: unknown };
  if (typeof longValue.toNumber === "function") {
    try {
      const converted = asFiniteNumber(longValue.toNumber.call(value));
      if (converted !== undefined) return converted;
    } catch {
      // Fall through to the string representation used by protobuf Long values.
    }
  }

  if (typeof longValue.toString === "function") {
    try {
      const converted = parseString(longValue.toString.call(value));
      if (converted !== undefined) return converted;
    } catch {
      // Use the caller's fallback for values without a usable timestamp representation.
    }
  }

  return fallback;
}

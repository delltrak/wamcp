function timestampToNumber(value: unknown): number | undefined {
  const asFiniteNumber = (candidate: unknown): number | undefined =>
    typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
  const parseString = (candidate: string): number | undefined => {
    const trimmed = candidate.trim();
    if (!trimmed) return undefined;
    return asFiniteNumber(Number(trimmed));
  };

  if (typeof value === "number") return asFiniteNumber(value);
  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : undefined;
  }
  if (typeof value === "string") return parseString(value);
  if (typeof value !== "object" || value === null) return undefined;

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
      return parseString(longValue.toString.call(value));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/** Convert Baileys/protobuf timestamp values to numeric Unix seconds. */
export function messageTimestampToSeconds(value: unknown, fallback: number): number {
  return timestampToNumber(value) ?? fallback;
}

/** Convert Baileys/protobuf timestamps to milliseconds for fetchMessageHistory. */
export function messageTimestampToMilliseconds(value: unknown, fallback: number): number {
  const timestamp = timestampToNumber(value);
  if (timestamp === undefined) return fallback;
  return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
}

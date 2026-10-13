import { DEFAULT_REDIS_URL } from "../constants.js";

export function getRedisConnectionOptions(url = process.env.WA_REDIS_URL ?? DEFAULT_REDIS_URL): {
  host: string;
  port: number;
  maxRetriesPerRequest: null;
} {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || "localhost",
    port: parseInt(parsed.port || "6379", 10),
    maxRetriesPerRequest: null,
  };
}

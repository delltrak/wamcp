import { describe, it, expect } from "vitest";
import {
  VERSION,
  SERVER_NAME,
  DEFAULT_TRANSPORT,
  DEFAULT_PORT,
  DEFAULT_REDIS_URL,
  DEFAULT_LOG_LEVEL,
  DEFAULT_BAILEYS_RATE_LIMIT,
  DEFAULT_CLOUD_RATE_LIMIT,
  DEFAULT_MESSAGE_RETENTION_DAYS,
  DEFAULT_MEDIA_CACHE_MAX_MB,
  DEFAULT_CLOUD_WEBHOOK_PORT,
  DEFAULT_AUTO_RECONNECT,
  DEFAULT_VERSION_CHECK,
  QUEUE_RETRY_ATTEMPTS,
  QUEUE_RETRY_DELAY_MS,
  QUEUE_COMPLETED_AGE_S,
  QUEUE_FAILED_AGE_S,
  DEFAULT_JOB_PRIORITY,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  DEDUP_TTL_HOURS,
  PRUNE_MESSAGES_CRON,
  PRUNE_DEDUP_CRON,
  CHECK_VERSION_CRON,
  HEALTH_CHECK_INTERVAL_MS,
  INSTANCE_ID_PREFIX,
  MAX_TEXT_LENGTH,
  MEDIA_LIMITS,
  MCP_ENDPOINT,
  HEALTH_ENDPOINT,
} from "../src/constants.js";

describe("Constants", () => {
  it("VERSION is a non-empty string", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION.length).toBeGreaterThan(0);
  });

  it("SERVER_NAME is a non-empty string", () => {
    expect(typeof SERVER_NAME).toBe("string");
    expect(SERVER_NAME.length).toBeGreaterThan(0);
  });

  it("DEFAULT_TRANSPORT is a valid transport type", () => {
    expect(["http", "stdio"]).toContain(DEFAULT_TRANSPORT);
  });

  it("DEFAULT_PORT is a valid port number", () => {
    expect(typeof DEFAULT_PORT).toBe("number");
    expect(DEFAULT_PORT).toBeGreaterThan(0);
    expect(DEFAULT_PORT).toBeLessThanOrEqual(65535);
  });

  it("DEFAULT_REDIS_URL is a non-empty string", () => {
    expect(typeof DEFAULT_REDIS_URL).toBe("string");
    expect(DEFAULT_REDIS_URL).toMatch(/^redis:\/\//);
  });

  it("DEFAULT_LOG_LEVEL is a valid log level", () => {
    expect(["trace", "debug", "info", "warn", "error", "fatal"]).toContain(DEFAULT_LOG_LEVEL);
  });

  it("rate limits are positive numbers", () => {
    expect(DEFAULT_BAILEYS_RATE_LIMIT).toBeGreaterThan(0);
    expect(DEFAULT_CLOUD_RATE_LIMIT).toBeGreaterThan(0);
    expect(DEFAULT_CLOUD_RATE_LIMIT).toBeGreaterThan(DEFAULT_BAILEYS_RATE_LIMIT);
  });

  it("DEFAULT_MESSAGE_RETENTION_DAYS is positive", () => {
    expect(DEFAULT_MESSAGE_RETENTION_DAYS).toBeGreaterThan(0);
  });

  it("DEFAULT_MEDIA_CACHE_MAX_MB is positive", () => {
    expect(DEFAULT_MEDIA_CACHE_MAX_MB).toBeGreaterThan(0);
  });

  it("DEFAULT_CLOUD_WEBHOOK_PORT is a valid port", () => {
    expect(DEFAULT_CLOUD_WEBHOOK_PORT).toBeGreaterThan(0);
    expect(DEFAULT_CLOUD_WEBHOOK_PORT).toBeLessThanOrEqual(65535);
  });

  it("boolean defaults are booleans", () => {
    expect(typeof DEFAULT_AUTO_RECONNECT).toBe("boolean");
    expect(typeof DEFAULT_VERSION_CHECK).toBe("boolean");
  });

  it("queue settings are positive numbers", () => {
    expect(QUEUE_RETRY_ATTEMPTS).toBeGreaterThan(0);
    expect(QUEUE_RETRY_DELAY_MS).toBeGreaterThan(0);
    expect(QUEUE_COMPLETED_AGE_S).toBeGreaterThan(0);
    expect(QUEUE_FAILED_AGE_S).toBeGreaterThan(0);
    expect(DEFAULT_JOB_PRIORITY).toBeGreaterThan(0);
  });

  it("reconnect settings are sensible", () => {
    expect(RECONNECT_INITIAL_DELAY_MS).toBeGreaterThan(0);
    expect(RECONNECT_MAX_DELAY_MS).toBeGreaterThan(RECONNECT_INITIAL_DELAY_MS);
    expect(RECONNECT_MAX_ATTEMPTS).toBeGreaterThan(0);
  });

  it("DEDUP_TTL_HOURS is positive", () => {
    expect(DEDUP_TTL_HOURS).toBeGreaterThan(0);
  });

  it("cron expressions are non-empty strings", () => {
    expect(typeof PRUNE_MESSAGES_CRON).toBe("string");
    expect(PRUNE_MESSAGES_CRON.length).toBeGreaterThan(0);
    expect(typeof PRUNE_DEDUP_CRON).toBe("string");
    expect(PRUNE_DEDUP_CRON.length).toBeGreaterThan(0);
    expect(typeof CHECK_VERSION_CRON).toBe("string");
    expect(CHECK_VERSION_CRON.length).toBeGreaterThan(0);
  });

  it("HEALTH_CHECK_INTERVAL_MS is positive", () => {
    expect(HEALTH_CHECK_INTERVAL_MS).toBeGreaterThan(0);
  });

  it("INSTANCE_ID_PREFIX is a non-empty string", () => {
    expect(typeof INSTANCE_ID_PREFIX).toBe("string");
    expect(INSTANCE_ID_PREFIX.length).toBeGreaterThan(0);
  });

  it("MAX_TEXT_LENGTH is positive", () => {
    expect(MAX_TEXT_LENGTH).toBeGreaterThan(0);
  });

  it("MEDIA_LIMITS has expected keys with positive byte values", () => {
    expect(MEDIA_LIMITS).toHaveProperty("image");
    expect(MEDIA_LIMITS).toHaveProperty("video");
    expect(MEDIA_LIMITS).toHaveProperty("audio");
    expect(MEDIA_LIMITS).toHaveProperty("document");
    expect(MEDIA_LIMITS).toHaveProperty("sticker");

    expect(MEDIA_LIMITS.image).toBeGreaterThan(0);
    expect(MEDIA_LIMITS.video).toBeGreaterThan(0);
    expect(MEDIA_LIMITS.audio).toBeGreaterThan(0);
    expect(MEDIA_LIMITS.document).toBeGreaterThan(0);
    expect(MEDIA_LIMITS.sticker).toBeGreaterThan(0);
    expect(MEDIA_LIMITS.document).toBeGreaterThan(MEDIA_LIMITS.image);
  });

  it("endpoint constants are non-empty strings starting with /", () => {
    expect(MCP_ENDPOINT).toMatch(/^\//);
    expect(HEALTH_ENDPOINT).toMatch(/^\//);
  });
});

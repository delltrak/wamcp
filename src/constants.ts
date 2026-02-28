// ============================================================
// WA MCP — Constants & Defaults
// ============================================================

export const VERSION = "1.0.0";
export const SERVER_NAME = "wa-mcp";

// Transport
export const DEFAULT_TRANSPORT = "http" as const;
export const DEFAULT_PORT = 3000;

// Redis
export const DEFAULT_REDIS_URL = "redis://localhost:6379";

// Logging
export const DEFAULT_LOG_LEVEL = "info";

// Rate Limits (messages per minute)
export const DEFAULT_BAILEYS_RATE_LIMIT = 20;
export const DEFAULT_CLOUD_RATE_LIMIT = 80;

// Message Retention
export const DEFAULT_MESSAGE_RETENTION_DAYS = 30;

// Media
export const DEFAULT_MEDIA_CACHE_MAX_MB = 500;

// Cloud API Webhook
export const DEFAULT_CLOUD_WEBHOOK_PORT = 3001;

// Auto-reconnect
export const DEFAULT_AUTO_RECONNECT = true;

// Version check
export const DEFAULT_VERSION_CHECK = true;

// Queue settings
export const QUEUE_RETRY_ATTEMPTS = 3;
export const QUEUE_RETRY_DELAY_MS = 2000;
export const QUEUE_COMPLETED_AGE_S = 3600; // 1 hour
export const QUEUE_FAILED_AGE_S = 86400; // 24 hours
export const DEFAULT_JOB_PRIORITY = 5;

// Reconnect settings
export const RECONNECT_INITIAL_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 30000;
export const RECONNECT_MAX_ATTEMPTS = 10;

// Dedup
export const DEDUP_TTL_HOURS = 24;

// Maintenance schedules
export const PRUNE_MESSAGES_CRON = "0 3 * * *"; // Daily at 3 AM
export const PRUNE_DEDUP_CRON = "0 * * * *"; // Hourly
export const CHECK_VERSION_CRON = "0 6 * * *"; // Daily at 6 AM
export const HEALTH_CHECK_INTERVAL_MS = 300_000; // 5 minutes

// Instance ID prefix
export const INSTANCE_ID_PREFIX = "inst_";

// Message limits
export const MAX_TEXT_LENGTH = 65536;

// Media size limits (bytes)
export const MEDIA_LIMITS = {
  image: 16 * 1024 * 1024, // 16 MB
  video: 16 * 1024 * 1024, // 16 MB
  audio: 16 * 1024 * 1024, // 16 MB
  document: 100 * 1024 * 1024, // 100 MB
  sticker: 500 * 1024, // 500 KB
} as const;

// MCP endpoint
export const MCP_ENDPOINT = "/mcp";
export const HEALTH_ENDPOINT = "/health";

// Max base64 media size (bytes)
export const MAX_BASE64_MEDIA_BYTES = 100 * 1024 * 1024; // 100 MB

// ============================================================
// WA MCP — Constants & Defaults
// ============================================================

export const VERSION = "2.0.0";
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

// Baileys history requests (per chat)
export const DEFAULT_BAILEYS_HISTORY_SYNC_MAX_MESSAGES = 100;

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

// Scheduled sends. The worker stays off until WA_SCHEDULER_ENABLED=true.
export const DEFAULT_SCHEDULER_TIMEZONE = "America/Bahia";
export const DEFAULT_SCHEDULER_MISSED_POLICY = "skip";
/** Active, paused, and running rows per instance. Override with WA_SCHEDULER_MAX_ACTIVE. */
export const DEFAULT_SCHEDULER_MAX_ACTIVE = 100;
/** scheduledAt, and the first matching slot, must fall inside this window. */
export const SCHEDULER_MAX_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;
export const SCHEDULER_POLL_MS = 5_000;
/** Due times older than this are missed runs. A short restart still sends. */
export const SCHEDULER_ON_TIME_SLACK_MS = 120_000;
export const SCHEDULER_LEASE_MS = 120_000;
export const SCHEDULER_MAX_ATTEMPTS = 5;
export const SCHEDULER_RETRY_DELAY_MS = 30_000;
export const SCHEDULER_MAX_PER_TICK = 50;
/** Matches the BullMQ outbound limiter window (messages per minute). */
export const SCHEDULER_RATE_WINDOW_MS = 60_000;

// Instance ID prefix
export const INSTANCE_ID_PREFIX = "inst_";

// Message limits
export const MAX_TEXT_LENGTH = 65536;
export const MAX_GROUP_PARTICIPANTS = 1024;

// Media size limits (bytes)
export const MEDIA_LIMITS = {
  image: 16 * 1024 * 1024, // 16 MB
  video: 16 * 1024 * 1024, // 16 MB
  audio: 16 * 1024 * 1024, // 16 MB
  document: 100 * 1024 * 1024, // 100 MB
  stickerStatic: 100 * 1024, // 100 KB
  stickerAnimated: 500 * 1024, // 500 KB
} as const;

// MCP endpoint
export const MCP_ENDPOINT = "/mcp";
export const HEALTH_ENDPOINT = "/health";

// Max base64 media size (bytes)
export const MAX_BASE64_MEDIA_BYTES = 100 * 1024 * 1024; // 100 MB

// Read-buffer ceiling for the stdio transport.
// MCP SDK 1.30.0 added a 10 MB default to StdioServerTransport; a single message
// over it makes the transport call close(), killing the whole session rather than
// failing one request. Base64 inflates by 4/3, so a MAX_BASE64_MEDIA_BYTES payload
// needs that much on the wire, plus room for the JSON-RPC envelope and escaping.
export const STDIO_MAX_BUFFER_BYTES = Math.ceil((MAX_BASE64_MEDIA_BYTES * 4) / 3) + 4 * 1024 * 1024;

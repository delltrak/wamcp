// ============================================================
// WA MCP — Structured Logger with Request Tracing
// ============================================================

import pino from "pino";
import { SERVER_NAME, DEFAULT_LOG_LEVEL } from "../constants.js";
import { PROXY_URL_ENV, redactProxyCredentials } from "./proxy-redact.js";

const logLevel = process.env.WA_LOG_LEVEL ?? DEFAULT_LOG_LEVEL;
const isStdio = process.env.WA_TRANSPORT === "stdio";

export const logger = pino(
  {
    name: SERVER_NAME,
    level: logLevel,
    transport:
      process.env.NODE_ENV !== "production"
        ? { target: "pino-pretty", options: { colorize: true, destination: isStdio ? 2 : 1 } }
        : undefined,
    redact: [
      "headers.authorization",
      "*.accessToken",
      "*.cloudAccessToken",
      "*.cloud_access_token",
      "*.apiKey",
      "params.accessToken",
      "params.apiKey",
      "req.headers.authorization",
      "req.headers['x-api-key']",
    ],
    hooks: {
      streamWrite(line: string): string {
        return redactProxyCredentials(line, process.env[PROXY_URL_ENV]);
      },
    },
  },
  pino.destination(isStdio ? 2 : 1),
);

export type Logger = pino.Logger;

export function createChildLogger(context: Record<string, unknown>): pino.Logger {
  return logger.child(context);
}

export function createRequestLogger(toolName: string, instanceId?: string): pino.Logger {
  return logger.child({
    requestId: crypto.randomUUID(),
    tool: toolName,
    ...(instanceId ? { instanceId } : {}),
  });
}

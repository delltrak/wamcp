import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  VERSION,
  SERVER_NAME,
  DEFAULT_TRANSPORT,
  DEFAULT_PORT,
  MCP_ENDPOINT,
  HEALTH_ENDPOINT,
} from "./constants.js";
import { InstanceManager } from "./services/instance-manager.js";
import { MessageQueue } from "./services/message-queue.js";
import { MaintenanceService } from "./services/maintenance.js";
import { createMcpServer } from "./server/mcp.js";
import { verifyWebhookSignature } from "./channels/cloud-api/cloud.auth.js";
import { normalizeWebhookPayload } from "./channels/cloud-api/cloud.events.js";
import type { MetaWebhookPayload } from "./channels/cloud-api/cloud.events.js";
import { logger } from "./utils/logger.js";

const CLOUD_WEBHOOK_PATH = "/cloud-webhook";

const transport = process.env.WA_TRANSPORT ?? DEFAULT_TRANSPORT;
const port = parseInt(process.env.WA_MCP_PORT ?? String(DEFAULT_PORT), 10);

/** Timing-safe API key comparison to prevent timing attacks */
function verifyApiKey(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** Check API key from request headers. Returns true if valid, or no key is configured. */
function checkApiKey(req: IncomingMessage, res: ServerResponse): boolean {
  const apiKey = process.env.WA_MCP_API_KEY;
  if (!apiKey) return true; // No key configured, allow

  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers["x-api-key"] as string | undefined;

  let provided: string | undefined;

  if (authHeader?.startsWith("Bearer ")) {
    provided = authHeader.slice(7);
  } else if (apiKeyHeader) {
    provided = apiKeyHeader;
  }

  if (!provided || !verifyApiKey(provided, apiKey)) {
    logger.warn("Unauthorized request: invalid or missing API key");
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return false;
  }

  return true;
}

async function initServices() {
  // Initialize services
  const instanceManager = new InstanceManager();
  const messageQueue = new MessageQueue();

  // Wire them together
  instanceManager.setMessageQueue(messageQueue);

  // Load existing instances from DB and reconnect
  await instanceManager.init();

  // Start maintenance jobs (pruning, version checks, health checks)
  const maintenance = new MaintenanceService(instanceManager);
  await maintenance.start();

  logger.info("Services initialized");

  return { instanceManager, messageQueue };
}

async function startHttp(): Promise<void> {
  const { instanceManager, messageQueue } = await initServices();
  const mcpServer = createMcpServer(instanceManager, messageQueue);
  const startTime = Date.now();

  // Map to track transports by session ID
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // Health endpoint
    if (url.pathname === HEALTH_ENDPOINT && req.method === "GET") {
      const allInstances = instanceManager.getAllInstances();
      const connected = allInstances.filter((i) => i.status === "connected").length;
      const health = {
        status: "ok",
        uptime: Math.floor((Date.now() - startTime) / 1000),
        instances: {
          total: allInstances.length,
          connected,
          disconnected: allInstances.length - connected,
        },
        version: VERSION,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health));
      return;
    }

    // MCP endpoint
    if (url.pathname === MCP_ENDPOINT) {
      // Authenticate before processing MCP requests
      if (!checkApiKey(req, res)) return;

      // Extract session ID from header
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (req.method === "POST") {
        // For new sessions or existing sessions
        let mcpTransport: StreamableHTTPServerTransport;

        if (sessionId && transports.has(sessionId)) {
          mcpTransport = transports.get(sessionId)!;
        } else {
          // Create new transport for new session
          mcpTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (newSessionId) => {
              transports.set(newSessionId, mcpTransport);
              logger.info({ sessionId: newSessionId }, "MCP session initialized");
            },
          });

          mcpTransport.onclose = () => {
            const sid = Array.from(transports.entries()).find(([, t]) => t === mcpTransport)?.[0];
            if (sid) {
              transports.delete(sid);
              logger.info({ sessionId: sid }, "MCP session closed");
            }
          };

          await mcpServer.connect(mcpTransport);
        }

        await mcpTransport.handleRequest(req, res);
        return;
      }

      if (req.method === "GET") {
        // SSE stream for notifications
        if (sessionId && transports.has(sessionId)) {
          const mcpTransport = transports.get(sessionId)!;
          await mcpTransport.handleRequest(req, res);
          return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing or invalid session ID" }));
        return;
      }

      if (req.method === "DELETE") {
        if (sessionId && transports.has(sessionId)) {
          const mcpTransport = transports.get(sessionId)!;
          await mcpTransport.handleRequest(req, res);
          return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing or invalid session ID" }));
        return;
      }

      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    // Cloud API Webhook endpoint
    if (url.pathname === CLOUD_WEBHOOK_PATH) {
      // GET — Meta webhook verification (hub.challenge)
      if (req.method === "GET") {
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        const verifyToken = process.env.WA_CLOUD_VERIFY_TOKEN;

        if (mode === "subscribe" && token === verifyToken && challenge) {
          logger.info("Cloud webhook verified");
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(challenge);
        } else {
          logger.warn("Cloud webhook verification failed");
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Verification failed" }));
        }
        return;
      }

      // POST — Incoming webhook events
      if (req.method === "POST") {
        // Read body
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        const rawBody = Buffer.concat(chunks);

        // Verify signature if secret is configured
        const webhookSecret = process.env.WA_CLOUD_WEBHOOK_SECRET;
        if (webhookSecret) {
          const signature = req.headers["x-hub-signature-256"] as string | undefined;
          if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
            logger.warn("Cloud webhook signature verification failed");
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid signature" }));
            return;
          }
        }

        // Return 200 immediately — Meta requires a response within 5 seconds
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));

        // Process asynchronously
        try {
          const payload = JSON.parse(rawBody.toString()) as MetaWebhookPayload;
          const events = normalizeWebhookPayload(payload);

          for (const evt of events) {
            const match = instanceManager.findCloudAdapterByPhoneNumberId(evt.phoneNumberId);
            if (!match) {
              logger.warn(
                { phoneNumberId: evt.phoneNumberId },
                "No Cloud API instance found for phone number ID",
              );
              continue;
            }

            // Set instanceId on the payload
            (evt.payload as unknown as { instanceId: string }).instanceId = match.instanceId;

            match.adapter.emit(evt.event, evt.payload);
          }
        } catch (err) {
          logger.error({ err }, "Failed to process cloud webhook payload");
        }
        return;
      }

      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(port, () => {
    logger.info(
      { port, transport: "http", version: VERSION },
      `${SERVER_NAME} started on port ${port}`,
    );
  });
}

async function startStdio(): Promise<void> {
  const { instanceManager, messageQueue } = await initServices();
  const mcpServer = createMcpServer(instanceManager, messageQueue);
  const stdioTransport = new StdioServerTransport();
  await mcpServer.connect(stdioTransport);
  logger.info({ transport: "stdio", version: VERSION }, `${SERVER_NAME} started on stdio`);
}

async function main(): Promise<void> {
  logger.info({ transport, version: VERSION }, "Starting WA MCP server");

  if (transport === "stdio") {
    await startStdio();
  } else {
    await startHttp();
  }
}

main().catch((err) => {
  logger.fatal(err, "Failed to start WA MCP server");
  process.exit(1);
});

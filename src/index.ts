import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpHttpSessionManager } from "./server/http-session.js";
import {
  VERSION,
  SERVER_NAME,
  DEFAULT_TRANSPORT,
  DEFAULT_PORT,
  MCP_ENDPOINT,
  HEALTH_ENDPOINT,
  STDIO_MAX_BUFFER_BYTES,
} from "./constants.js";
import { InstanceManager } from "./services/instance-manager.js";
import { MessageQueue } from "./services/message-queue.js";
import { EventWebhookService } from "./services/event-webhook.js";
import { MaintenanceService } from "./services/maintenance.js";
import { createMcpServer } from "./server/mcp.js";
import { verifyWebhookSignature } from "./channels/cloud-api/cloud.auth.js";
import { normalizeWebhookPayload } from "./channels/cloud-api/cloud.events.js";
import type { MetaWebhookPayload } from "./channels/cloud-api/cloud.events.js";
import { installShutdownHandlers, SHUTDOWN_TIMEOUT_MS } from "./utils/shutdown.js";
import { logger } from "./utils/logger.js";
import { getAutoReadMode } from "./services/auto-read.js";
import { loadPresencePulseConfig, PresencePulseScheduler } from "./services/presence-pulse.js";
import { loadAutoMarkPlayedConfig } from "./services/auto-mark-played.js";
import { bootEventWebhook, getEventWebhookStatus } from "./services/event-webhook-config.js";
import { buildHealthBody, renderHealthBody } from "./server/health.js";
import { parseBaileysProxyUrl } from "./channels/baileys/proxy.js";

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
  const presencePulseConfig = loadPresencePulseConfig();
  loadAutoMarkPlayedConfig();
  getAutoReadMode();

  // Initialize services
  const instanceManager = new InstanceManager();
  const messageQueue = new MessageQueue();
  const eventWebhook = new EventWebhookService();

  // Wire them together
  instanceManager.setMessageQueue(messageQueue);
  eventWebhook.start(instanceManager);

  // Load existing instances from DB and reconnect
  await instanceManager.init();

  // Start maintenance jobs (pruning, version checks, health checks)
  const maintenance = new MaintenanceService(instanceManager);
  await maintenance.start();

  const presencePulse = new PresencePulseScheduler({
    config: presencePulseConfig,
    listDevices: () =>
      instanceManager.listBaileysAdapters().map(({ instanceId, adapter }) => ({
        id: instanceId,
        isReady: () => adapter.getStatus() === "connected",
        runPulse: (durationMs: number) => adapter.runPresencePulse(durationMs),
      })),
  });
  presencePulse.start();

  logger.info({ presencePulse: presencePulseConfig.enabled }, "Services initialized");

  return { instanceManager, messageQueue, eventWebhook, maintenance, presencePulse };
}

async function startHttp(): Promise<void> {
  const { instanceManager, messageQueue, eventWebhook, maintenance, presencePulse } =
    await initServices();
  const mcpSessions = new McpHttpSessionManager(instanceManager, messageQueue, eventWebhook);
  const startTime = Date.now();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // Health endpoint
    if (url.pathname === HEALTH_ENDPOINT && req.method === "GET") {
      const allInstances = instanceManager.getAllInstances();
      const connected = allInstances.filter((i) => i.status === "connected").length;
      const health = buildHealthBody({
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
        instances: {
          total: allInstances.length,
          connected,
          disconnected: allInstances.length - connected,
        },
        version: VERSION,
        webhook: getEventWebhookStatus(),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(renderHealthBody(health));
      return;
    }

    // MCP endpoint
    if (url.pathname === MCP_ENDPOINT) {
      // Authenticate before processing MCP requests
      if (!checkApiKey(req, res)) return;
      await mcpSessions.handleRequest(req, res);
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

  let servicesClosePromise: Promise<void> | null = null;
  const closeServices = (): Promise<void> => {
    presencePulse.stop();
    servicesClosePromise ??= Promise.all([
      messageQueue.close(),
      eventWebhook.close(),
      maintenance.stop(),
    ]).then(() => undefined);
    return servicesClosePromise;
  };
  httpServer.on("close", () => {
    void closeServices().catch((err: unknown) => {
      logger.error({ err }, "Failed to close server services");
    });
  });

  installShutdownHandlers(
    async (signal) => {
      logger.info({ signal }, "Stopping HTTP server");
      try {
        const serverClosed = new Promise<void>((resolve, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        });
        await Promise.all([serverClosed, mcpSessions.closeAll()]);
      } finally {
        await closeServices();
      }
    },
    {
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
      onError: (err) => logger.error({ err }, "Failed to shut down HTTP server"),
    },
  );

  httpServer.listen(port, () => {
    logger.info(
      { port, transport: "http", version: VERSION },
      `${SERVER_NAME} started on port ${port}`,
    );
  });
}

async function startStdio(): Promise<void> {
  const { instanceManager, messageQueue, eventWebhook, maintenance, presencePulse } =
    await initServices();
  const { server: mcpServer } = createMcpServer(instanceManager, messageQueue, eventWebhook);
  const onServerClose = mcpServer.server.onclose;
  let servicesClosePromise: Promise<void> | null = null;
  const closeServices = (): Promise<void> => {
    presencePulse.stop();
    servicesClosePromise ??= Promise.all([
      messageQueue.close(),
      eventWebhook.close(),
      maintenance.stop(),
    ]).then(() => undefined);
    return servicesClosePromise;
  };
  mcpServer.server.onclose = () => {
    onServerClose?.();
    void closeServices().catch((err: unknown) => {
      logger.error({ err }, "Failed to close server services");
    });
  };
  installShutdownHandlers(
    async (signal) => {
      logger.info({ signal }, "Stopping stdio server");
      await mcpServer.close();
      await closeServices();
    },
    {
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
      onError: (err) => logger.error({ err }, "Failed to shut down stdio server"),
    },
  );
  const stdioTransport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: STDIO_MAX_BUFFER_BYTES,
  });
  await mcpServer.connect(stdioTransport);
  logger.info({ transport: "stdio", version: VERSION }, `${SERVER_NAME} started on stdio`);
}

async function main(): Promise<void> {
  parseBaileysProxyUrl(process.env.WA_PROXY_URL);
  logger.info({ transport, version: VERSION }, "Starting WA MCP server");
  bootEventWebhook();

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

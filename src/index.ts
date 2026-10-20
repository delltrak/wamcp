import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpHttpSessionManager } from "./server/http-session.js";
import {
  VERSION,
  SERVER_NAME,
  DEFAULT_TRANSPORT,
  DEFAULT_PORT,
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
import { bootEventWebhook, type EventWebhookStatus } from "./services/event-webhook-config.js";
import { buildHealthBody } from "./server/health.js";
import { AuthAttemptLimiter } from "./server/auth-limiter.js";
import {
  credentialFingerprint,
  findBasicUser,
  verifyBasicCredentials,
} from "./server/basic-auth.js";
import {
  loadHttpTransportConfigForTransport,
  type HttpTransportConfig,
} from "./server/http-config.js";
import { createHttpRequestHandler } from "./server/http-listener.js";
import { authorizeMcpHttpRequest } from "./server/mcp-auth.js";
import { createMcpOAuthServer, type McpOAuthServer } from "./server/oauth/server.js";

const transport = process.env.WA_TRANSPORT ?? DEFAULT_TRANSPORT;
const port = parseInt(process.env.WA_MCP_PORT ?? String(DEFAULT_PORT), 10);

async function initServices() {
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

  logger.info("Services initialized");

  return { instanceManager, messageQueue, eventWebhook, maintenance };
}

function openOAuth(
  httpConfig: HttpTransportConfig,
  limiter: AuthAttemptLimiter,
): McpOAuthServer | null {
  if (!httpConfig.oauth.enabled) return null;
  return createMcpOAuthServer({
    issuerUrl: httpConfig.oauth.issuerUrl,
    resourceUrl: httpConfig.oauth.resourceUrl,
    dbPath: httpConfig.oauth.dbPath,
    dynamicRegistration: httpConfig.oauth.dynamicRegistration,
    redirectHostAllowlist: httpConfig.oauth.redirectHostAllowlist,
    ...(httpConfig.apiKey ? { apiKey: httpConfig.apiKey } : {}),
    limiter,
    validateCredential: (username, password) =>
      verifyBasicCredentials(httpConfig.basicUsers, username, password),
    resolveCredentialVersion: (username) => {
      const user = findBasicUser(httpConfig.basicUsers, username);
      return user ? credentialFingerprint(user) : undefined;
    },
  });
}

async function handleCloudWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  instanceManager: InstanceManager,
): Promise<void> {
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

  if (req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks);

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

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));

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
}

async function startHttp(
  webhookStatus: EventWebhookStatus,
  httpConfig: HttpTransportConfig,
): Promise<void> {
  const signInLimiter = new AuthAttemptLimiter();
  const oauth = openOAuth(httpConfig, signInLimiter);
  let services: Awaited<ReturnType<typeof initServices>>;
  try {
    services = await initServices();
  } catch (error) {
    oauth?.close();
    throw error;
  }
  const { instanceManager, messageQueue, eventWebhook, maintenance } = services;
  const mcpSessions = new McpHttpSessionManager(instanceManager, messageQueue);
  const startTime = Date.now();
  const handleRequest = createHttpRequestHandler({
    routes: httpConfig.routes,
    oauth,
    authorize: (req, res) =>
      authorizeMcpHttpRequest(
        req,
        res,
        {
          ...(httpConfig.apiKey ? { apiKey: httpConfig.apiKey } : {}),
          basicUsers: httpConfig.basicUsers,
          limiter: signInLimiter,
        },
        oauth,
      ),
    health: (_req, res) => {
      const allInstances = instanceManager.getAllInstances();
      const connected = allInstances.filter((instance) => instance.status === "connected").length;
      const health = buildHealthBody({
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
        instances: {
          total: allInstances.length,
          connected,
          disconnected: allInstances.length - connected,
        },
        version: VERSION,
        webhook: webhookStatus,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health));
    },
    mcp: (req, res) => mcpSessions.handleRequest(req, res),
    webhook: (req, res, url) => handleCloudWebhook(req, res, url, instanceManager),
  });

  const httpServer = createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      logger.error({ err }, "HTTP request failed");
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  let servicesClosePromise: Promise<void> | null = null;
  const closeServices = (): Promise<void> => {
    servicesClosePromise ??= Promise.all([
      messageQueue.close(),
      eventWebhook.close(),
      maintenance.stop(),
      Promise.resolve().then(() => oauth?.close()),
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
      {
        port,
        transport: "http",
        version: VERSION,
        basePath: httpConfig.basePath || "/",
        oauth: httpConfig.oauth.enabled,
        basicAuthUsers: httpConfig.basicUsers.length,
      },
      `${SERVER_NAME} started on port ${port}`,
    );
  });
}

async function startStdio(): Promise<void> {
  const { instanceManager, messageQueue, eventWebhook, maintenance } = await initServices();
  const { server: mcpServer } = createMcpServer(instanceManager, messageQueue);
  const onServerClose = mcpServer.server.onclose;
  let servicesClosePromise: Promise<void> | null = null;
  const closeServices = (): Promise<void> => {
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
  const httpConfig = loadHttpTransportConfigForTransport(transport, process.env);
  logger.info({ transport, version: VERSION }, "Starting WA MCP server");
  const webhookStatus = bootEventWebhook();

  if (!httpConfig) {
    await startStdio();
    return;
  }
  await startHttp(webhookStatus, httpConfig);
}

main().catch((err) => {
  logger.fatal(err, "Failed to start WA MCP server");
  process.exit(1);
});

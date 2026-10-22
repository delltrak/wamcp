// ============================================================
// WA MCP — Stateful HTTP MCP sessions
// ============================================================

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import type { EventWebhookService } from "../services/event-webhook.js";
import { logger } from "../utils/logger.js";
import { createMcpServer } from "./mcp.js";

interface HttpMcpSession {
  sessionId?: string;
  transport: StreamableHTTPServerTransport;
  mcpServer: ReturnType<typeof createMcpServer>;
}

/** Routes each stateful HTTP request to the MCP server for its session. */
export class McpHttpSessionManager {
  private readonly sessions = new Map<string, HttpMcpSession>();

  constructor(
    private readonly instanceManager: InstanceManager,
    private readonly messageQueue: MessageQueue,
    private readonly eventWebhook?: EventWebhookService,
  ) {}

  get sessionCount(): number {
    return this.sessions.size;
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
          this.writeError(res, 404, "Missing or invalid session ID");
          return;
        }
        await session.transport.handleRequest(req, res);
        return;
      }

      await this.handleNewSessionRequest(req, res);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (!sessionId) {
        this.writeError(res, 400, "Missing or invalid session ID");
        return;
      }

      const session = this.sessions.get(sessionId);
      if (!session) {
        this.writeError(res, 404, "Missing or invalid session ID");
        return;
      }

      await session.transport.handleRequest(req, res);
      return;
    }

    this.writeError(res, 405, "Method not allowed");
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.mcpServer.close()));
  }

  private async handleNewSessionRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = this.createSession();

    try {
      await session.mcpServer.server.connect(session.transport);
      await session.transport.handleRequest(req, res);

      if (session.sessionId) {
        // The transport dispatches MCP requests without awaiting their handlers.
        // Give initialize handling a turn to populate the client capabilities.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      // Requests without a successful initialize must not leave an unused MCP
      // server and event subscription behind.
      if (session.mcpServer.server.server.getClientCapabilities() === undefined) {
        this.removeSession(session);
        await session.mcpServer.close();
      }
    } catch (error) {
      await session.mcpServer.close();
      throw error;
    }
  }

  private createSession(): HttpMcpSession {
    const mcpServer = createMcpServer(this.instanceManager, this.messageQueue, this.eventWebhook);
    const sessionRef: { current?: HttpMcpSession } = {};

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        const session = sessionRef.current;
        if (!session) throw new Error("MCP session was not ready during initialization");
        session.sessionId = sessionId;
        this.sessions.set(sessionId, session);
        logger.info({ sessionId }, "MCP session initialized");
      },
    });

    const session = { transport, mcpServer };
    sessionRef.current = session;
    transport.onclose = () => {
      this.removeSession(session);
    };

    return session;
  }

  private removeSession(session: HttpMcpSession): void {
    const sessionId = session.sessionId;
    if (sessionId && this.sessions.get(sessionId) === session) {
      this.sessions.delete(sessionId);
      logger.info({ sessionId }, "MCP session closed");
    }
    session.mcpServer.dispose();
  }

  private writeError(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

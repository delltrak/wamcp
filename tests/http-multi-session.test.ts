import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import { McpHttpSessionManager } from "../src/server/http-session.js";

describe("MCP HTTP sessions", () => {
  let httpServer: Server | undefined;
  let sessionManager: McpHttpSessionManager | undefined;
  let eventSubscribers: Set<unknown> | undefined;
  let serverErrors: unknown[] | undefined;

  afterEach(async () => {
    await sessionManager?.closeAll();
    if (httpServer?.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps two interleaved sessions connected and releases them on DELETE", async () => {
    eventSubscribers = new Set();
    serverErrors = [];
    const instanceManager = {
      onAnyEvent(handler: unknown) {
        eventSubscribers!.add(handler);
        return () => eventSubscribers!.delete(handler);
      },
    } as unknown as InstanceManager;
    const messageQueue = {} as MessageQueue;
    sessionManager = new McpHttpSessionManager(instanceManager, messageQueue);

    httpServer = createServer((req, res) => {
      void sessionManager!.handleRequest(req, res).catch((error: unknown) => {
        serverErrors!.push(error);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      });
    });

    const address = await new Promise<{ port: number }>((resolve, reject) => {
      httpServer!.once("error", reject);
      httpServer!.listen(0, "127.0.0.1", () => {
        const boundAddress = httpServer!.address();
        if (!boundAddress || typeof boundAddress === "string") {
          reject(new Error("Expected a TCP address"));
          return;
        }
        resolve(boundAddress);
      });
    });
    const endpoint = `http://127.0.0.1:${address.port}/mcp`;
    const requestHeaders = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-03-26",
    };
    const readSseMessage = async <T>(response: Response): Promise<T> => {
      const eventStream = await response.text();
      const data = eventStream
        .split(/\r?\n/)
        .find((line) => line.startsWith("data:"))
        ?.slice("data:".length)
        .trim();
      if (!data) throw new Error(`Expected an MCP message in SSE response: ${eventStream}`);
      return JSON.parse(data) as T;
    };

    const initialize = async (clientName: string): Promise<string> => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: clientName, version: "1.0.0" },
          },
        }),
      });

      expect(response.status).toBe(200);
      const sessionId = response.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      const body = await readSseMessage<{
        result?: { serverInfo?: { name?: string } };
      }>(response);
      expect(body.result?.serverInfo?.name).toBeTruthy();
      return sessionId!;
    };

    const firstSessionId = await initialize("first-client");
    const secondSessionId = await initialize("second-client");
    expect(secondSessionId).not.toBe(firstSessionId);
    expect(sessionManager.sessionCount).toBe(2);
    expect(eventSubscribers.size).toBe(2);

    const initializeSession = (sessionId: string) =>
      fetch(endpoint, {
        method: "POST",
        headers: { ...requestHeaders, "mcp-session-id": sessionId },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
    const [firstInitialized, secondInitialized] = await Promise.all([
      initializeSession(firstSessionId),
      initializeSession(secondSessionId),
    ]);
    expect(firstInitialized.status).toBe(202);
    expect(secondInitialized.status).toBe(202);

    const toolsList = async (sessionId: string) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { ...requestHeaders, "mcp-session-id": sessionId },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      expect(response.status).toBe(200);
      return readSseMessage<{ result?: { tools?: Array<{ name: string }> } }>(response);
    };

    // Both initialized sessions remain live while their tools/list requests run
    // concurrently and are routed by their individual session headers.
    const [firstTools, secondTools] = await Promise.all([
      toolsList(firstSessionId),
      toolsList(secondSessionId),
    ]);
    expect(firstTools.result?.tools?.some((tool) => tool.name === "wa_create_instance")).toBe(true);
    expect(secondTools.result?.tools?.some((tool) => tool.name === "wa_create_instance")).toBe(
      true,
    );

    const closeSession = (sessionId: string) =>
      fetch(endpoint, {
        method: "DELETE",
        headers: { ...requestHeaders, "mcp-session-id": sessionId },
      });
    const [firstClose, secondClose] = await Promise.all([
      closeSession(firstSessionId),
      closeSession(secondSessionId),
    ]);

    expect(firstClose.status).toBe(200);
    expect(secondClose.status).toBe(200);
    expect(sessionManager.sessionCount).toBe(0);
    expect(eventSubscribers.size).toBe(0);
    expect(serverErrors).toEqual([]);
  });
});

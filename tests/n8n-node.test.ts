import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const protocol = require("../integrations/n8n-nodes-wamcp/lib/protocol.cjs") as {
  callWamcpTool: (
    transport: (request: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    }) => Promise<{ headers: Record<string, string>; body: unknown }>,
    options: {
      baseUrl: string;
      apiKey?: string;
      tool: string;
      arguments?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
  filterTriggerEvents: (body: unknown, events: string) => Array<Record<string, unknown>>;
  isDirectIncomingEvent: (item: unknown) => boolean;
  verifyEventSignature: (input: {
    secret?: string;
    rawBody?: unknown;
    timestamp?: string;
    signature?: string;
    nowSeconds?: number;
  }) => boolean;
};
const { Wamcp } = require("../integrations/n8n-nodes-wamcp/nodes/Wamcp/Wamcp.node.js") as {
  Wamcp: new () => { description: { name: string; properties: Array<{ name: string }> } };
};
const { WamcpTrigger } =
  require("../integrations/n8n-nodes-wamcp/nodes/WamcpTrigger/WamcpTrigger.node.js") as {
    WamcpTrigger: new () => {
      description: {
        name: string;
        webhooks: Array<{ path: string; httpMethod: string }>;
        properties: Array<{ name: string }>;
      };
      webhook: () => Promise<{
        workflowData: Array<Array<{ json: Record<string, unknown> }>>;
        webhookResponse?: { statusCode?: number };
      }>;
      getNodeParameter: (name: string) => string;
      getHeaderData: () => Record<string, string>;
      getRequestObject: () => { rawBody?: Buffer };
      getResponseObject: () => {
        status: (code: number) => { json: (body: unknown) => unknown };
      };
      getBodyData: () => unknown;
    };
  };

describe("n8n WA MCP nodes", () => {
  it("exposes send actions and an event trigger", () => {
    const action = new Wamcp();
    const trigger = new WamcpTrigger();
    expect(action.description.name).toBe("wamcp");
    expect(action.description.properties.map((property) => property.name)).toEqual(
      expect.arrayContaining(["operation", "instanceId", "to", "text"]),
    );
    expect(trigger.description.name).toBe("wamcpTrigger");
    expect(trigger.description.webhooks[0]).toMatchObject({ httpMethod: "POST", path: "wamcp" });
    expect(trigger.description.properties.map((property) => property.name)).toContain(
      "webhookSecret",
    );
  });

  it("calls wa_send_text over the MCP HTTP session", async () => {
    const requests: Array<{
      method: string;
      body?: { method?: string; params?: { name?: string } };
    }> = [];
    const result = await protocol.callWamcpTool(
      async (request) => {
        requests.push(request);
        if (request.body?.method === "initialize") {
          return {
            headers: { "mcp-session-id": "sess-1" },
            body: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } },
          };
        }
        if (request.body?.method === "tools/call") {
          return {
            headers: {},
            body: {
              jsonrpc: "2.0",
              id: 2,
              result: { content: [{ type: "text", text: '{"status":"queued","jobId":"job-1"}' }] },
            },
          };
        }
        return { headers: {}, body: "" };
      },
      {
        baseUrl: "http://localhost:3000/",
        apiKey: "local-key",
        tool: "wa_send_text",
        arguments: {
          instanceId: "inst_0123abcd",
          to: "15551234567@s.whatsapp.net",
          text: "Hello",
        },
      },
    );

    expect(result).toEqual({ status: "queued", jobId: "job-1" });
    expect(requests.map((request) => request.method)).toEqual(["POST", "POST", "POST", "DELETE"]);
    expect(requests[0]?.body?.method).toBe("initialize");
    expect(requests[2]?.body?.params?.name).toBe("wa_send_text");
    expect(requests[2]).toMatchObject({
      url: "http://localhost:3000/mcp",
      headers: { authorization: "Bearer local-key", "mcp-session-id": "sess-1" },
    });
  });

  it("fires the example reply flow from a message event", () => {
    const flow = JSON.parse(
      readFileSync(
        new URL("../integrations/n8n-nodes-wamcp/examples/reply-on-message.json", import.meta.url),
        "utf8",
      ),
    ) as {
      nodes: Array<{ name: string; type: string; parameters: Record<string, string> }>;
      connections: Record<string, { main: Array<Array<{ node: string }>> }>;
    };
    const trigger = flow.nodes.find((node) => node.type === "n8n-nodes-wamcp.wamcpTrigger");
    const filter = flow.nodes.find((node) => node.name === "Direct chats only");
    const send = flow.nodes.find((node) => node.type === "n8n-nodes-wamcp.wamcp");
    expect(trigger?.parameters.events).toBe("message.received");
    expect(trigger?.parameters.webhookSecret).toBeTruthy();
    expect(filter?.parameters.jsCode).toContain("@g.us");
    expect(filter?.parameters.jsCode).toContain("isFromMe");
    expect(filter?.parameters.jsCode).toContain("@broadcast");
    expect(filter?.parameters.jsCode).toContain("@newsletter");
    expect(send?.parameters).toMatchObject({
      operation: "sendText",
      instanceId: "={{$json.instanceId}}",
      to: "={{$json.chat}}",
    });
    expect(send?.parameters.text).not.toContain("Received:");
    expect(flow.connections["WhatsApp event"]?.main[0]?.[0]?.node).toBe("Direct chats only");
    expect(flow.connections["Direct chats only"]?.main[0]?.[0]?.node).toBe("Send text");

    const items = protocol.filterTriggerEvents(
      {
        events: [
          {
            event: "message.received",
            instanceId: "inst_0123abcd",
            chat: "15551234567@s.whatsapp.net",
            text: "Hello",
          },
          { event: "instance.connected", instanceId: "inst_0123abcd" },
        ],
      },
      "message.received",
    );
    expect(items).toEqual([
      expect.objectContaining({
        event: "message.received",
        chat: "15551234567@s.whatsapp.net",
        text: "Hello",
      }),
    ]);

    const grok = protocol.filterTriggerEvents(
      { instanceId: "inst_0123abcd", chatId: "15551234567@s.whatsapp.net", text: "Hello" },
      "message.received",
    );
    expect(grok[0]).toMatchObject({
      event: "message.received",
      chat: "15551234567@s.whatsapp.net",
    });
    expect(protocol.isDirectIncomingEvent(items[0])).toBe(true);
    expect(
      protocol.isDirectIncomingEvent({ chat: "120363000000000001@g.us", isFromMe: false }),
    ).toBe(false);
    expect(
      protocol.isDirectIncomingEvent({ chat: "status@broadcast", isFromMe: false }),
    ).toBe(false);
    expect(
      protocol.isDirectIncomingEvent({ chat: "123456789012345@newsletter", isFromMe: false }),
    ).toBe(false);
    expect(
      protocol.isDirectIncomingEvent({
        chat: "15551234567@s.whatsapp.net",
        isFromMe: true,
      }),
    ).toBe(false);
  });

  it("rejects a trigger delivery whose x-wa-event-signature does not match", async () => {
    const secret = "event-webhook-secret";
    const rawBody = Buffer.from('{"event":"message.received","text":"Hello"}');
    const nowSeconds = Math.floor(Date.now() / 1000);
    const timestamp = String(nowSeconds);
    const signature = `sha256=${createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex")}`;
    expect(
      protocol.verifyEventSignature({
        secret,
        rawBody,
        timestamp,
        signature,
        nowSeconds,
      }),
    ).toBe(true);
    expect(
      protocol.verifyEventSignature({
        secret,
        rawBody,
        timestamp,
        signature,
        nowSeconds: nowSeconds + 301,
      }),
    ).toBe(false);
    expect(
      protocol.verifyEventSignature({
        secret,
        rawBody: { event: "message.received" },
        timestamp,
        signature,
        nowSeconds,
      }),
    ).toBe(false);

    const trigger = new WamcpTrigger();
    trigger.getNodeParameter = (name) => (name === "webhookSecret" ? secret : "message.received");
    trigger.getHeaderData = () => ({
      "x-wa-event-timestamp": timestamp,
      "x-wa-event-signature": signature,
    });
    trigger.getRequestObject = () => ({ rawBody });
    trigger.getBodyData = () => ({
      event: "message.received",
      chat: "15551234567@s.whatsapp.net",
      text: "Hello",
      isFromMe: false,
    });
    const accepted = await trigger.webhook();
    expect(accepted.workflowData[0]?.[0]?.json).toMatchObject({ text: "Hello" });

    const response = {
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
    };
    trigger.getResponseObject = () => response;
    trigger.getRequestObject = () => ({});
    const rejected = await trigger.webhook();
    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({ error: "Unauthorized" });
    expect(rejected).toEqual({ noWebhookResponse: true });
    expect("workflowData" in rejected).toBe(false);
  });
});

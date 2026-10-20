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
};
const { Wamcp } = require("../integrations/n8n-nodes-wamcp/nodes/Wamcp/Wamcp.node.js") as {
  Wamcp: new () => { description: { name: string; properties: Array<{ name: string }> } };
};
const { WamcpTrigger } =
  require("../integrations/n8n-nodes-wamcp/nodes/WamcpTrigger/WamcpTrigger.node.js") as {
    WamcpTrigger: new () => {
      description: { name: string; webhooks: Array<{ path: string; httpMethod: string }> };
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
    const send = flow.nodes.find((node) => node.type === "n8n-nodes-wamcp.wamcp");
    expect(trigger?.parameters.events).toBe("message.received");
    expect(send?.parameters).toMatchObject({
      operation: "sendText",
      instanceId: "={{$json.instanceId}}",
      to: "={{$json.chat}}",
      text: "=Received: {{$json.text}}",
    });
    expect(flow.connections["WhatsApp event"]?.main[0]?.[0]?.node).toBe("Send text");

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
  });
});

"use strict";

const { filterTriggerEvents, headerValue, verifyEventSignature } = require("../../lib/protocol.cjs");

class WamcpTrigger {
  constructor() {
    this.description = {
      displayName: "WA MCP Trigger",
      name: "wamcpTrigger",
      icon: "file:wamcp.svg",
      group: ["trigger"],
      version: 1,
      subtitle: '={{$parameter["events"]}}',
      description: "Start a workflow from a WA MCP event webhook",
      defaults: { name: "WA MCP Trigger" },
      inputs: [],
      outputs: ["main"],
      webhooks: [
        {
          name: "default",
          httpMethod: "POST",
          responseMode: "onReceived",
          path: "wamcp",
        },
      ],
      properties: [
        {
          displayName: "Events",
          name: "events",
          type: "string",
          default: "message.received",
          description:
            "Comma-separated event names. Point WA_EVENT_WEBHOOK_URL at this node's production URL and select the same events there.",
        },
        {
          displayName: "Webhook Secret",
          name: "webhookSecret",
          type: "string",
          typeOptions: { password: true },
          default: "",
          required: true,
          description:
            "WA_EVENT_WEBHOOK_SECRET for this destination. The node checks x-wa-event-signature over the raw body.",
        },
      ],
    };
  }

  async webhook() {
    const secret = this.getNodeParameter("webhookSecret");
    const headers = this.getHeaderData();
    const request = this.getRequestObject();
    const authorized = verifyEventSignature({
      secret,
      rawBody: request && request.rawBody,
      timestamp: headerValue(headers, "x-wa-event-timestamp"),
      signature: headerValue(headers, "x-wa-event-signature"),
    });
    if (!authorized) {
      return {
        webhookResponse: { statusCode: 401, body: { error: "Unauthorized" } },
        workflowData: [[]],
      };
    }
    const events = this.getNodeParameter("events");
    const matched = filterTriggerEvents(this.getBodyData(), events);
    return { workflowData: [matched.map((json) => ({ json }))] };
  }
}

module.exports = { WamcpTrigger };

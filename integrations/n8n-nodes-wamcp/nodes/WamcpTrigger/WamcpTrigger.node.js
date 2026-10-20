"use strict";

const { filterTriggerEvents } = require("../../lib/protocol.cjs");

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
      ],
    };
  }

  async webhook() {
    const events = this.getNodeParameter("events");
    const matched = filterTriggerEvents(this.getBodyData(), events);
    return { workflowData: [matched.map((json) => ({ json }))] };
  }
}

module.exports = { WamcpTrigger };

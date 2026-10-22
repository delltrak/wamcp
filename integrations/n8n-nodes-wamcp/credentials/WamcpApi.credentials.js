"use strict";

class WamcpApi {
  constructor() {
    this.name = "wamcpApi";
    this.displayName = "WA MCP API";
    this.documentationUrl =
      "https://github.com/delltrak/wamcp/blob/main/integrations/n8n-nodes-wamcp/README.md";
    this.properties = [
      {
        displayName: "Base URL",
        name: "baseUrl",
        type: "string",
        default: "http://localhost:3000",
        required: true,
        description: "WA MCP HTTP origin, without the /mcp path",
      },
      {
        displayName: "API Key",
        name: "apiKey",
        type: "string",
        typeOptions: { password: true },
        default: "",
        description: "Value of WA_MCP_API_KEY. Leave empty when the server has no API key.",
      },
      {
        displayName: "Default Instance ID",
        name: "instanceId",
        type: "string",
        default: "",
        description: "Used when a node does not set its own instance ID",
      },
    ];
  }
}

module.exports = { WamcpApi };

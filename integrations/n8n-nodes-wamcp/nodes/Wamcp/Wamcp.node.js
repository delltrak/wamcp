"use strict";

const { callWamcpTool, testWamcpConnection } = require("../../lib/protocol.cjs");

function show(operation) {
  return { show: { operation } };
}

class Wamcp {
  constructor() {
    this.description = {
      displayName: "WA MCP",
      name: "wamcp",
      icon: "file:wamcp.svg",
      group: ["output"],
      version: 1,
      subtitle: '={{$parameter["operation"]}}',
      description: "Send WhatsApp messages through a WA MCP server",
      defaults: { name: "WA MCP" },
      inputs: ["main"],
      outputs: ["main"],
      credentials: [{ name: "wamcpApi", required: true, testedBy: "wamcpApiTest" }],
      properties: [
        {
          displayName: "Operation",
          name: "operation",
          type: "options",
          noDataExpression: true,
          options: [
            { name: "Send Text", value: "sendText", action: "Send a text message" },
            { name: "Send Image", value: "sendImage", action: "Send an image" },
            { name: "Send Audio", value: "sendAudio", action: "Send audio" },
            { name: "Send Document", value: "sendDocument", action: "Send a document" },
            { name: "Get Instance Status", value: "getStatus", action: "Get instance status" },
          ],
          default: "sendText",
        },
        {
          displayName: "Instance ID",
          name: "instanceId",
          type: "string",
          default: "",
          description: "WhatsApp instance ID. Falls back to the credential default.",
        },
        {
          displayName: "Recipient",
          name: "to",
          type: "string",
          default: "",
          required: true,
          displayOptions: show(["sendText", "sendImage", "sendAudio", "sendDocument"]),
          description: "Phone number or chat JID",
        },
        {
          displayName: "Text",
          name: "text",
          type: "string",
          default: "",
          required: true,
          displayOptions: show(["sendText"]),
        },
        {
          displayName: "Image URL or Base64",
          name: "image",
          type: "string",
          default: "",
          required: true,
          displayOptions: show(["sendImage"]),
        },
        {
          displayName: "Caption",
          name: "caption",
          type: "string",
          default: "",
          displayOptions: show(["sendImage"]),
        },
        {
          displayName: "Audio URL or Base64",
          name: "audio",
          type: "string",
          default: "",
          required: true,
          displayOptions: show(["sendAudio"]),
        },
        {
          displayName: "Document URL or Base64",
          name: "document",
          type: "string",
          default: "",
          required: true,
          displayOptions: show(["sendDocument"]),
        },
        {
          displayName: "File Name",
          name: "fileName",
          type: "string",
          default: "file.bin",
          required: true,
          displayOptions: show(["sendDocument"]),
        },
        {
          displayName: "MIME Type",
          name: "mimeType",
          type: "string",
          default: "application/octet-stream",
          required: true,
          displayOptions: show(["sendDocument"]),
        },
      ],
    };
  }

  methods = {
    credentialTest: {
      async wamcpApiTest(credential) {
        try {
          await testWamcpConnection(async (request) => {
            const response = await this.helpers.httpRequest({
              ...request,
              json: true,
              returnFullResponse: true,
              timeout: 10000,
              disableFollowRedirect: true,
            });
            return { headers: response.headers, body: response.body };
          }, credential.data || {});
          return { status: "OK", message: "WA MCP API authentication succeeded" };
        } catch {
          return {
            status: "Error",
            message:
              "WA MCP API authentication or connection failed. Check the Base URL and API Key.",
          };
        }
      },
    },
  };

  async execute() {
    const items = this.getInputData();
    const credentials = await this.getCredentials("wamcpApi");
    const returnData = [];

    for (let index = 0; index < items.length; index += 1) {
      const operation = this.getNodeParameter("operation", index);
      const instanceId = String(
        this.getNodeParameter("instanceId", index) || credentials.instanceId || "",
      ).trim();
      const args = operation === "getStatus" ? {} : { instanceId };
      if (operation !== "getStatus" && !instanceId) {
        throw new Error("Instance ID is required");
      }
      if (operation === "getStatus" && instanceId) args.instanceId = instanceId;

      if (operation === "sendText") {
        args.to = this.getNodeParameter("to", index);
        args.text = this.getNodeParameter("text", index);
      } else if (operation === "sendImage") {
        args.to = this.getNodeParameter("to", index);
        args.image = this.getNodeParameter("image", index);
        const caption = this.getNodeParameter("caption", index);
        if (caption) args.caption = caption;
      } else if (operation === "sendAudio") {
        args.to = this.getNodeParameter("to", index);
        args.audio = this.getNodeParameter("audio", index);
      } else if (operation === "sendDocument") {
        args.to = this.getNodeParameter("to", index);
        args.document = this.getNodeParameter("document", index);
        args.fileName = this.getNodeParameter("fileName", index);
        args.mimeType = this.getNodeParameter("mimeType", index);
      }

      const tools = {
        sendText: "wa_send_text",
        sendImage: "wa_send_image",
        sendAudio: "wa_send_audio",
        sendDocument: "wa_send_document",
        getStatus: "wa_get_instance_status",
      };
      const tool = tools[operation];
      if (!tool) throw new Error(`Unsupported WA MCP operation: ${operation}`);

      const json = await callWamcpTool(
        async (request) => {
          const response = await this.helpers.httpRequest({
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: request.body,
            json: true,
            returnFullResponse: true,
            timeout: 10000,
            disableFollowRedirect: true,
          });
          return { headers: response.headers, body: response.body };
        },
        {
          baseUrl: credentials.baseUrl,
          apiKey: credentials.apiKey,
          tool,
          arguments: args,
        },
      );
      returnData.push({ json, pairedItem: { item: index } });
    }

    return [returnData];
  }
}

module.exports = { Wamcp };

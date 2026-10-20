// ============================================================
// WA MCP — Per-instance outgoing event webhook tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EventWebhookService } from "../services/event-webhook.js";
import {
  readInstanceWebhook,
  removeInstanceWebhook,
  setInstanceWebhook,
} from "../services/instance-webhook.js";
import {
  DeleteInstanceWebhookSchema,
  GetInstanceWebhookSchema,
  SetInstanceWebhookSchema,
} from "../schemas/instance.schema.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";
import { createRequestLogger } from "../utils/logger.js";

export function registerInstanceWebhookTools(
  server: McpServer,
  eventWebhook?: EventWebhookService,
): void {
  server.registerTool(
    "wa_set_instance_webhook",
    {
      description:
        "Replace the outgoing event webhook stored for one instance. Saves the URL, an optional auth header, and an optional event list. Omit events to inherit WA_EVENT_WEBHOOK_EVENTS. The auth value is stored for delivery and is not returned. WA_EVENT_WEBHOOK_INSTANCE_MERGE_GLOBAL defaults to false, so this webhook replaces the global destinations for this instance only. Set that variable to true to also deliver to the global destinations; a duplicate URL is sent once, using this instance's auth header and events.",
      inputSchema: SetInstanceWebhookSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_set_instance_webhook", params.instanceId);
      const start = Date.now();
      try {
        const webhook = setInstanceWebhook(params);
        eventWebhook?.sync();
        log.info(
          {
            duration: Date.now() - start,
            authConfigured: webhook.authConfigured,
            eventCount: webhook.events?.length ?? null,
          },
          "Instance webhook saved",
        );
        return toolSuccess(webhook);
      } catch (err) {
        return handleToolError("wa_set_instance_webhook", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_get_instance_webhook",
    {
      description:
        "Read the outgoing event webhook stored for one instance. Returns the URL, auth header name, whether auth is configured, and the event list. Null events mean this instance inherits WA_EVENT_WEBHOOK_EVENTS. The auth value is never returned. When no webhook is stored, the instance uses the global destinations.",
      inputSchema: GetInstanceWebhookSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_get_instance_webhook", params.instanceId);
      const start = Date.now();
      try {
        const webhook = readInstanceWebhook(params.instanceId);
        log.info(
          {
            duration: Date.now() - start,
            configured: webhook.configured,
            authConfigured: webhook.configured ? webhook.authConfigured : false,
          },
          "Instance webhook read",
        );
        return toolSuccess(webhook);
      } catch (err) {
        return handleToolError("wa_get_instance_webhook", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_delete_instance_webhook",
    {
      description:
        "Remove the outgoing event webhook stored for one instance. Later events for this instance use the global destinations again.",
      inputSchema: DeleteInstanceWebhookSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_delete_instance_webhook", params.instanceId);
      const start = Date.now();
      try {
        const result = removeInstanceWebhook(params.instanceId);
        eventWebhook?.sync();
        log.info(
          { duration: Date.now() - start, deleted: result.deleted },
          "Instance webhook removed",
        );
        return toolSuccess({ instanceId: params.instanceId, deleted: result.deleted });
      } catch (err) {
        return handleToolError("wa_delete_instance_webhook", err, params.instanceId);
      }
    },
  );
}

// ============================================================
// WA MCP — Contact Management Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";
import { createRequestLogger } from "../utils/logger.js";
import {
  CheckNumberExistsSchema,
  BlockContactSchema,
  UnblockContactSchema,
  GetBusinessProfileSchema,
  SearchContactSchema,
} from "../schemas/contact.schema.js";

export function registerContactTools(
  server: McpServer,
  instanceManager: InstanceManager,
  _messageQueue: MessageQueue,
): void {
  server.registerTool(
    "wa_check_number_exists",
    {
      description:
        "Check if a phone number is registered on WhatsApp. Returns the JID if the number exists.",
      inputSchema: CheckNumberExistsSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_check_number_exists", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const result = await adapter.checkNumberExists(params.phoneNumber);
        log.info({ duration: Date.now() - start, exists: result.exists }, "Number check completed");
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_check_number_exists", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_block_contact",
    {
      description: "Block a WhatsApp contact. Blocked contacts cannot send you messages.",
      inputSchema: BlockContactSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_block_contact", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.blockContact(params.jid);
        log.info({ duration: Date.now() - start }, "Contact blocked");
        return toolSuccess({ success: true, blocked: true });
      } catch (err) {
        return handleToolError("wa_block_contact", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_unblock_contact",
    {
      description: "Unblock a previously blocked WhatsApp contact.",
      inputSchema: UnblockContactSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_unblock_contact", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.unblockContact(params.jid);
        log.info({ duration: Date.now() - start }, "Contact unblocked");
        return toolSuccess({ success: true, blocked: false });
      } catch (err) {
        return handleToolError("wa_unblock_contact", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_get_business_profile",
    {
      description: "Fetch the business profile information for a WhatsApp Business contact.",
      inputSchema: GetBusinessProfileSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_get_business_profile", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const profile = await adapter.getBusinessProfile(params.jid);
        log.info({ duration: Date.now() - start }, "Business profile retrieved");
        return toolSuccess(profile);
      } catch (err) {
        return handleToolError("wa_get_business_profile", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_search_contact",
    {
      description:
        "Search contacts by name or phone number. Returns matching contacts from the local cache.",
      inputSchema: SearchContactSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_search_contact", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const contacts = await adapter.getContacts(params.query);
        log.info(
          { duration: Date.now() - start, found: contacts.length },
          "Contact search completed",
        );
        return toolSuccess({ query: params.query, count: contacts.length, contacts });
      } catch (err) {
        return handleToolError("wa_search_contact", err, params.instanceId);
      }
    },
  );
}

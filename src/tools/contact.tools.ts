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
  ResyncContactsSchema,
  ListBlockedContactsSchema,
  GetContactAboutSchema,
  SaveContactSchema,
  RemoveContactSchema,
  GetDisappearingDurationSchema,
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

  server.registerTool(
    "wa_resync_contacts",
    {
      description:
        "Refresh contacts for an already connected Baileys session without pairing again. Resyncs app-state collections and recovers individual contacts from locally stored chats and messages.",
      inputSchema: ResyncContactsSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_resync_contacts", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const result = await adapter.resyncContacts();
        const failedCollections = result.sources.appState.collections.filter(
          (collection) => !collection.success,
        ).length;
        log.info(
          {
            duration: Date.now() - start,
            contactsBefore: result.contactsBefore,
            contactsAfter: result.contactsAfter,
            added: result.added,
            failedCollections,
          },
          "Contact resync completed",
        );
        return toolSuccess(result);
      } catch (err) {
        return handleToolError("wa_resync_contacts", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_list_blocked_contacts",
    {
      description:
        "List contact JIDs in the WhatsApp blocklist. Baileys reads the blocklist through an IQ query; Cloud API does not expose it.",
      inputSchema: ListBlockedContactsSchema,
    },
    async (params) => {
      try {
        const blocked = await instanceManager.getAdapter(params.instanceId).getBlocklist();
        return toolSuccess({ count: blocked.length, blocked });
      } catch (err) {
        return handleToolError("wa_list_blocked_contacts", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_get_contact_about",
    {
      description:
        "Read a contact's About text with Baileys fetchStatus. This is a USync read; Cloud API does not support it.",
      inputSchema: GetContactAboutSchema,
    },
    async (params) => {
      try {
        const about = await instanceManager
          .getAdapter(params.instanceId)
          .getContactAbout(params.jid);
        return toolSuccess({ jid: params.jid, about });
      } catch (err) {
        return handleToolError("wa_get_contact_about", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_save_contact",
    {
      description:
        "Add or edit a contact in WhatsApp app state (addOrEditContact). This writes WhatsApp app state and is blocked unless WA_APP_STATE_WRITES_ENABLED=true. Baileys only.",
      inputSchema: SaveContactSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_save_contact", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.saveContact({
          jid: params.jid,
          fullName: params.fullName,
          ...(params.firstName ? { firstName: params.firstName } : {}),
          ...(params.username ? { username: params.username } : {}),
          ...(params.saveOnPrimaryAddressbook !== undefined
            ? { saveOnPrimaryAddressbook: params.saveOnPrimaryAddressbook }
            : {}),
        });
        log.info({ duration: Date.now() - start }, "Contact saved to app state");
        return toolSuccess({ success: true, jid: params.jid, fullName: params.fullName });
      } catch (err) {
        return handleToolError("wa_save_contact", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_remove_contact",
    {
      description:
        "Remove a contact from WhatsApp app state (removeContact). This writes WhatsApp app state and is blocked unless WA_APP_STATE_WRITES_ENABLED=true. Baileys only.",
      inputSchema: RemoveContactSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_remove_contact", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.removeContact(params.jid);
        log.info({ duration: Date.now() - start }, "Contact removed from app state");
        return toolSuccess({ success: true, jid: params.jid, removed: true });
      } catch (err) {
        return handleToolError("wa_remove_contact", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_get_disappearing_duration",
    {
      description:
        "Query default disappearing-message duration settings for one or more contacts via Baileys USync fetchDisappearingDuration. Read-only; Baileys only.",
      inputSchema: GetDisappearingDurationSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_get_disappearing_duration", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const results = await adapter.getDisappearingDuration(params.jids);
        log.info(
          { duration: Date.now() - start, count: results.length },
          "Disappearing durations read",
        );
        return toolSuccess({ count: results.length, results });
      } catch (err) {
        return handleToolError("wa_get_disappearing_duration", err, params.instanceId);
      }
    },
  );
}

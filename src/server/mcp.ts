// ============================================================
// WA MCP — MCP Server Setup
// Creates the McpServer and registers all tools, resources,
// and notification handlers.
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_NAME, VERSION } from "../constants.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";

// Tools
import { registerInstanceTools } from "../tools/instance.tools.js";
import { registerMessagingTools } from "../tools/messaging.tools.js";
import { registerChatTools } from "../tools/chat.tools.js";
import { registerGroupTools } from "../tools/group.tools.js";
import { registerContactTools } from "../tools/contact.tools.js";
import { registerProfileTools } from "../tools/profile.tools.js";
import { registerStatusTools } from "../tools/status.tools.js";
import { registerCallTools } from "../tools/call.tools.js";
import { registerNewsletterTools } from "../tools/newsletter.tools.js";

// Resources
import { registerInstancesResource } from "../resources/instances.resource.js";
import { registerContactsResource } from "../resources/contacts.resource.js";
import { registerChatsResource } from "../resources/chats.resource.js";
import { registerGroupsResource } from "../resources/groups.resource.js";
import { registerMessagesResource } from "../resources/messages.resource.js";
import { registerProfileResource } from "../resources/profile.resource.js";
import { registerPrivacyResource } from "../resources/privacy.resource.js";
import { registerBlocklistResource } from "../resources/blocklist.resource.js";

// Notifications
import { registerEventNotifications } from "../notifications/events.js";

export function createMcpServer(
  instanceManager: InstanceManager,
  messageQueue: MessageQueue,
): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: VERSION,
  });

  // Register tools
  registerInstanceTools(server, instanceManager, messageQueue);
  registerMessagingTools(server, instanceManager, messageQueue);
  registerChatTools(server, instanceManager, messageQueue);
  registerGroupTools(server, instanceManager, messageQueue);
  registerContactTools(server, instanceManager, messageQueue);
  registerProfileTools(server, instanceManager, messageQueue);
  registerStatusTools(server, instanceManager, messageQueue);
  registerCallTools(server, instanceManager, messageQueue);
  registerNewsletterTools(server, instanceManager, messageQueue);

  // Register resources
  registerInstancesResource(server, instanceManager, messageQueue);
  registerContactsResource(server, instanceManager);
  registerChatsResource(server, instanceManager);
  registerGroupsResource(server, instanceManager);
  registerMessagesResource(server, instanceManager);
  registerProfileResource(server, instanceManager);
  registerPrivacyResource(server, instanceManager);
  registerBlocklistResource(server, instanceManager);

  // Register event notifications
  registerEventNotifications(server, instanceManager);

  return server;
}

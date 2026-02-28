// ============================================================
// WA MCP — Instance Management Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";
import { createRequestLogger } from "../utils/logger.js";
import {
  CreateInstanceSchema,
  ConnectInstanceSchema,
  DisconnectInstanceSchema,
  DeleteInstanceSchema,
  RestartInstanceSchema,
  GetQrCodeSchema,
  GetPairingCodeSchema,
  SetCloudCredentialsSchema,
} from "../schemas/instance.schema.js";

export function registerInstanceTools(
  server: McpServer,
  instanceManager: InstanceManager,
  _messageQueue: MessageQueue,
): void {
  server.tool(
    "wa_create_instance",
    "Create a new WhatsApp instance. Specify a name and channel type (baileys for WhatsApp Web protocol, cloud for Meta Cloud API).",
    CreateInstanceSchema.shape,
    async (params) => {
      const log = createRequestLogger("wa_create_instance");
      const start = Date.now();
      try {
        const instance = await instanceManager.createInstance(params.name, params.channel);
        log.info({ duration: Date.now() - start }, "Instance created");
        return toolSuccess(instance);
      } catch (err) {
        return handleToolError("wa_create_instance", err);
      }
    },
  );

  server.tool(
    "wa_connect_instance",
    "Connect a WhatsApp instance. For Baileys instances, this starts the WebSocket connection and generates a QR code for authentication.",
    ConnectInstanceSchema.shape,
    async (params) => {
      const log = createRequestLogger("wa_connect_instance", params.instanceId);
      const start = Date.now();
      try {
        await instanceManager.connectInstance(params.instanceId);
        log.info({ duration: Date.now() - start }, "Instance connecting");
        return toolSuccess({ instanceId: params.instanceId, status: "connecting" });
      } catch (err) {
        return handleToolError("wa_connect_instance", err, params.instanceId);
      }
    },
  );

  server.tool(
    "wa_disconnect_instance",
    "Gracefully disconnect a WhatsApp instance. The session is preserved for reconnection.",
    DisconnectInstanceSchema.shape,
    async (params) => {
      const log = createRequestLogger("wa_disconnect_instance", params.instanceId);
      const start = Date.now();
      try {
        await instanceManager.disconnectInstance(params.instanceId);
        log.info({ duration: Date.now() - start }, "Instance disconnected");
        return toolSuccess({ instanceId: params.instanceId, status: "disconnected" });
      } catch (err) {
        return handleToolError("wa_disconnect_instance", err, params.instanceId);
      }
    },
  );

  server.tool(
    "wa_delete_instance",
    "Permanently delete a WhatsApp instance and all its data including auth state, messages, contacts, and queue. This action cannot be undone.",
    DeleteInstanceSchema.shape,
    async (params) => {
      const log = createRequestLogger("wa_delete_instance", params.instanceId);
      const start = Date.now();
      try {
        await instanceManager.deleteInstance(params.instanceId);
        log.info({ duration: Date.now() - start }, "Instance deleted");
        return toolSuccess({ instanceId: params.instanceId, deleted: true });
      } catch (err) {
        return handleToolError("wa_delete_instance", err, params.instanceId);
      }
    },
  );

  server.tool(
    "wa_restart_instance",
    "Disconnect and reconnect a WhatsApp instance. Useful for recovering from errors.",
    RestartInstanceSchema.shape,
    async (params) => {
      const log = createRequestLogger("wa_restart_instance", params.instanceId);
      const start = Date.now();
      try {
        await instanceManager.restartInstance(params.instanceId);
        log.info({ duration: Date.now() - start }, "Instance restarted");
        return toolSuccess({ instanceId: params.instanceId, status: "connecting" });
      } catch (err) {
        return handleToolError("wa_restart_instance", err, params.instanceId);
      }
    },
  );

  server.tool(
    "wa_get_qr_code",
    "Get the QR code as a base64 image for authenticating a Baileys instance. Returns null if no QR code is available (already authenticated or not yet connecting).",
    GetQrCodeSchema.shape,
    async (params) => {
      const log = createRequestLogger("wa_get_qr_code", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const qr = await adapter.getQrCode();
        log.info({ duration: Date.now() - start, hasQr: !!qr }, "QR code retrieved");
        if (qr) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ instanceId: params.instanceId, qrCode: qr }),
              },
            ],
          };
        }
        return toolSuccess({
          instanceId: params.instanceId,
          qrCode: null,
          message: "No QR code available",
        });
      } catch (err) {
        return handleToolError("wa_get_qr_code", err, params.instanceId);
      }
    },
  );

  server.tool(
    "wa_get_pairing_code",
    "Get a numeric pairing code for authenticating a Baileys instance. The code is entered on the phone in WhatsApp > Linked Devices > Link with phone number.",
    GetPairingCodeSchema.shape,
    async (params) => {
      const log = createRequestLogger("wa_get_pairing_code", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const code = await adapter.getPairingCode(params.phoneNumber);
        log.info({ duration: Date.now() - start }, "Pairing code retrieved");
        return toolSuccess({ instanceId: params.instanceId, pairingCode: code });
      } catch (err) {
        return handleToolError("wa_get_pairing_code", err, params.instanceId);
      }
    },
  );

  server.tool(
    "wa_set_cloud_credentials",
    "Configure Meta Cloud API credentials for a Cloud API instance. Required before connecting a Cloud API instance.",
    SetCloudCredentialsSchema.shape,
    async (params) => {
      const log = createRequestLogger("wa_set_cloud_credentials", params.instanceId);
      const start = Date.now();
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.setCredentials({
          accessToken: params.accessToken,
          phoneNumberId: params.phoneNumberId,
          businessId: params.businessId,
        });
        log.info({ duration: Date.now() - start }, "Cloud credentials configured");
        return toolSuccess({ instanceId: params.instanceId, configured: true });
      } catch (err) {
        return handleToolError("wa_set_cloud_credentials", err, params.instanceId);
      }
    },
  );
}

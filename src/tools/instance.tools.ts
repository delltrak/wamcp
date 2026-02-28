// ============================================================
// WA MCP — Instance Management Tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../services/instance-manager.js";
import type { MessageQueue } from "../services/message-queue.js";
import { toolSuccess, toolError } from "../types/mcp.types.js";
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
      try {
        const instance = await instanceManager.createInstance(params.name, params.channel);
        return toolSuccess(instance);
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_connect_instance",
    "Connect a WhatsApp instance. For Baileys instances, this starts the WebSocket connection and generates a QR code for authentication.",
    ConnectInstanceSchema.shape,
    async (params) => {
      try {
        await instanceManager.connectInstance(params.instanceId);
        return toolSuccess({ instanceId: params.instanceId, status: "connecting" });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_disconnect_instance",
    "Gracefully disconnect a WhatsApp instance. The session is preserved for reconnection.",
    DisconnectInstanceSchema.shape,
    async (params) => {
      try {
        await instanceManager.disconnectInstance(params.instanceId);
        return toolSuccess({ instanceId: params.instanceId, status: "disconnected" });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_delete_instance",
    "Permanently delete a WhatsApp instance and all its data including auth state, messages, contacts, and queue. This action cannot be undone.",
    DeleteInstanceSchema.shape,
    async (params) => {
      try {
        await instanceManager.deleteInstance(params.instanceId);
        return toolSuccess({ instanceId: params.instanceId, deleted: true });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_restart_instance",
    "Disconnect and reconnect a WhatsApp instance. Useful for recovering from errors.",
    RestartInstanceSchema.shape,
    async (params) => {
      try {
        await instanceManager.restartInstance(params.instanceId);
        return toolSuccess({ instanceId: params.instanceId, status: "connecting" });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_get_qr_code",
    "Get the QR code as a base64 image for authenticating a Baileys instance. Returns null if no QR code is available (already authenticated or not yet connecting).",
    GetQrCodeSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const qr = await adapter.getQrCode();
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
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_get_pairing_code",
    "Get a numeric pairing code for authenticating a Baileys instance. The code is entered on the phone in WhatsApp > Linked Devices > Link with phone number.",
    GetPairingCodeSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        const code = await adapter.getPairingCode(params.phoneNumber);
        return toolSuccess({ instanceId: params.instanceId, pairingCode: code });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );

  server.tool(
    "wa_set_cloud_credentials",
    "Configure Meta Cloud API credentials for a Cloud API instance. Required before connecting a Cloud API instance.",
    SetCloudCredentialsSchema.shape,
    async (params) => {
      try {
        const adapter = instanceManager.getAdapter(params.instanceId);
        await adapter.setCredentials({
          accessToken: params.accessToken,
          phoneNumberId: params.phoneNumberId,
          businessId: params.businessId,
        });
        return toolSuccess({ instanceId: params.instanceId, configured: true });
      } catch (err) {
        return toolError((err as Error).message);
      }
    },
  );
}

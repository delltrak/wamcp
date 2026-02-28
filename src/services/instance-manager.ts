// ============================================================
// WA MCP — Instance Manager (Core Orchestrator)
// ============================================================

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { db } from "../db/client.js";
import { instances, authKeys, queueStats } from "../db/schema.js";
import { BaileysAdapter } from "../channels/baileys/baileys.adapter.js";
import { CloudApiAdapter } from "../channels/cloud-api/cloud.adapter.js";
import type { ChannelAdapter } from "../channels/channel.interface.js";
import type { ChannelType, ChannelEvent, ChannelEventPayload } from "../types/channel.types.js";
import type { InstanceEntity } from "../types/db.types.js";
import { INSTANCE_ID_PREFIX } from "../constants.js";
import type { MessageQueue } from "./message-queue.js";

const logger = pino({ name: "instance-manager" });

interface ManagedInstance {
  adapter: ChannelAdapter;
  channel: ChannelType;
}

type InstanceEventHandler = <E extends ChannelEvent>(
  event: E,
  instanceId: string,
  payload: ChannelEventPayload[E],
) => void;

export class InstanceManager {
  private readonly adapters = new Map<string, ManagedInstance>();
  private readonly globalHandlers = new Set<InstanceEventHandler>();
  private messageQueue: MessageQueue | null = null;

  /** Wire up the message queue for adapter resolution */
  setMessageQueue(mq: MessageQueue): void {
    this.messageQueue = mq;
    mq.setAdapterResolver((id) => this.getAdapter(id));
  }

  /** Register a global event handler that receives all instance events */
  onAnyEvent(handler: InstanceEventHandler): void {
    this.globalHandlers.add(handler);
  }

  /** Initialize: load existing instances from DB and reconnect those with status "open"/connected */
  async init(): Promise<void> {
    const rows = db.select().from(instances).all();
    for (const row of rows) {
      if (row.status === "connected" || row.status === "connecting") {
        try {
          const adapter = this.createAdapter(row.id, row.channel as ChannelType);
          this.adapters.set(row.id, { adapter, channel: row.channel as ChannelType });
          this.bindAdapterEvents(row.id, adapter);
          await adapter.connect();
          logger.info({ instanceId: row.id }, "Reconnected instance on startup");
        } catch (err) {
          logger.error({ instanceId: row.id, err }, "Failed to reconnect instance on startup");
          db.update(instances)
            .set({ status: "disconnected", updatedAt: Date.now() })
            .where(eq(instances.id, row.id))
            .run();
        }
      }
    }
  }

  // ---- Instance CRUD ----

  async createInstance(name: string, channel: ChannelType = "baileys"): Promise<InstanceEntity> {
    const id = `${INSTANCE_ID_PREFIX}${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    db.insert(instances)
      .values({
        id,
        name,
        channel,
        status: "disconnected",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.insert(queueStats)
      .values({ instanceId: id, messagesSent: 0, messagesFailed: 0 })
      .onConflictDoNothing()
      .run();

    return this.getInstanceFromDb(id);
  }

  async connectInstance(id: string): Promise<void> {
    const row = this.getInstanceFromDb(id);
    let managed = this.adapters.get(id);

    if (!managed) {
      const adapter = this.createAdapter(id, row.channel as ChannelType);
      managed = { adapter, channel: row.channel as ChannelType };
      this.adapters.set(id, managed);
      this.bindAdapterEvents(id, adapter);
    }

    db.update(instances)
      .set({ status: "connecting", updatedAt: Date.now() })
      .where(eq(instances.id, id))
      .run();

    await managed.adapter.connect();
  }

  async disconnectInstance(id: string): Promise<void> {
    const managed = this.adapters.get(id);
    if (managed) {
      await managed.adapter.disconnect();
    }
    db.update(instances)
      .set({
        status: "disconnected",
        lastDisconnected: Date.now(),
        updatedAt: Date.now(),
      })
      .where(eq(instances.id, id))
      .run();
  }

  async deleteInstance(id: string): Promise<void> {
    // Disconnect first
    const managed = this.adapters.get(id);
    if (managed) {
      await managed.adapter.disconnect();
      this.adapters.delete(id);
    }

    // Clean up queue
    if (this.messageQueue) {
      await this.messageQueue.removeInstanceQueue(id);
    }

    // Delete auth keys
    db.delete(authKeys).where(eq(authKeys.instanceId, id)).run();

    // Delete instance (cascades to messages, contacts, groups, chats, queue_stats)
    db.delete(instances).where(eq(instances.id, id)).run();
  }

  async restartInstance(id: string): Promise<void> {
    await this.disconnectInstance(id);
    // Clear adapter so a fresh one is created
    this.adapters.delete(id);
    await this.connectInstance(id);
  }

  // ---- Adapter access ----

  getAdapter(id: string): ChannelAdapter {
    const managed = this.adapters.get(id);
    if (!managed) {
      throw new Error(`Instance ${id} not found or not initialized`);
    }
    return managed.adapter;
  }

  getInstanceChannel(id: string): ChannelType {
    const managed = this.adapters.get(id);
    if (managed) return managed.channel;
    const row = this.getInstanceFromDb(id);
    return row.channel as ChannelType;
  }

  // ---- DB reads ----

  getAllInstances(): InstanceEntity[] {
    return db.select().from(instances).all() as InstanceEntity[];
  }

  getInstance(id: string): InstanceEntity {
    return this.getInstanceFromDb(id);
  }

  private getInstanceFromDb(id: string): InstanceEntity {
    const row = db.select().from(instances).where(eq(instances.id, id)).get();
    if (!row) {
      throw new Error(`Instance ${id} not found`);
    }
    return row as InstanceEntity;
  }

  /** Find a Cloud API adapter by its phone number ID (for webhook routing). */
  findCloudAdapterByPhoneNumberId(phoneNumberId: string): { instanceId: string; adapter: CloudApiAdapter } | null {
    for (const [instanceId, managed] of this.adapters) {
      if (managed.channel === "cloud") {
        const cloudAdapter = managed.adapter as CloudApiAdapter;
        if (cloudAdapter.getPhoneNumberId() === phoneNumberId) {
          return { instanceId, adapter: cloudAdapter };
        }
      }
    }
    return null;
  }

  // ---- Private helpers ----

  private createAdapter(instanceId: string, channel: ChannelType): ChannelAdapter {
    switch (channel) {
      case "baileys":
        return new BaileysAdapter(instanceId);
      case "cloud":
        return new CloudApiAdapter(instanceId);
      default:
        throw new Error(`Unknown channel type: ${channel}`);
    }
  }

  private bindAdapterEvents(instanceId: string, adapter: ChannelAdapter): void {
    const events: ChannelEvent[] = [
      "message.received",
      "message.updated",
      "message.deleted",
      "message.reaction",
      "message.edited",
      "presence.updated",
      "chat.updated",
      "group.updated",
      "group.participants_changed",
      "contact.updated",
      "connection.changed",
      "call.received",
    ];

    for (const event of events) {
      adapter.on(event, (payload: ChannelEventPayload[typeof event]) => {
        // Update instance status on connection changes
        if (event === "connection.changed") {
          const connPayload = payload as ChannelEventPayload["connection.changed"];
          const statusMap: Record<string, string> = {
            open: "connected",
            close: "disconnected",
            connecting: "connecting",
          };
          const dbStatus = statusMap[connPayload.status] ?? "disconnected";
          const updateFields: Record<string, unknown> = {
            status: dbStatus,
            updatedAt: Date.now(),
          };
          if (connPayload.status === "open") {
            updateFields.lastConnected = Date.now();
          }
          if (connPayload.status === "close") {
            updateFields.lastDisconnected = Date.now();
          }
          db.update(instances).set(updateFields).where(eq(instances.id, instanceId)).run();
        }

        // Forward to global handlers
        for (const handler of this.globalHandlers) {
          try {
            handler(event, instanceId, payload);
          } catch (err) {
            logger.error({ err, event, instanceId }, "Error in global event handler");
          }
        }
      });
    }
  }
}

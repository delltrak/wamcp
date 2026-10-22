import { InstanceNotFoundError, InstanceNotInitializedError } from "../utils/instance-errors.js";
// ============================================================
// WA MCP — Instance Manager (Core Orchestrator)
// ============================================================

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/client.js";
import { instances, authKeys, queueStats } from "../db/schema.js";
import { BaileysAdapter } from "../channels/baileys/baileys.adapter.js";
import { CloudApiAdapter } from "../channels/cloud-api/cloud.adapter.js";
import type { ChannelAdapter } from "../channels/channel.interface.js";
import {
  CHANNEL_EVENTS,
  type ChannelType,
  type ChannelEvent,
  type ChannelEventPayload,
  type InstanceRuntimeStatus,
} from "../types/channel.types.js";
import type { InstanceEntity } from "../types/db.types.js";
import { INSTANCE_ID_PREFIX } from "../constants.js";
import { createChildLogger } from "../utils/logger.js";
import type { MessageQueue } from "./message-queue.js";
import { touchInstanceWebhookStorage } from "./instance-webhook-store.js";

const logger = createChildLogger({ service: "instance-manager" });

interface ManagedInstance {
  adapter: ChannelAdapter;
  channel: ChannelType;
}

type InstanceEventHandler = <E extends ChannelEvent>(
  event: E,
  instanceId: string,
  payload: ChannelEventPayload[E],
) => void;

export interface InstanceLifecycleStatusSnapshot {
  instanceId: string;
  name: string;
  channel: ChannelType;
  state: string;
  phone: string | null;
  lid: string | null;
  pushName: string | null;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  disconnectReason: string | null;
  disconnectStatusCode: number | null;
  pendingChallenge: InstanceRuntimeStatus["pendingChallenge"];
  presenceMode: string | null;
}

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
  onAnyEvent(handler: InstanceEventHandler): () => void {
    this.globalHandlers.add(handler);
    return () => this.globalHandlers.delete(handler);
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

  /**
   * Return the adapter for an instance, creating and binding it if this is the
   * first time it is needed. Unlike getAdapter(), this does not require the
   * instance to have been connected — configuration steps (Cloud API
   * credentials) have to run before a connection is possible.
   */
  ensureAdapter(id: string): ChannelAdapter {
    const managed = this.adapters.get(id);
    if (managed) return managed.adapter;

    const row = this.getInstanceFromDb(id);
    const adapter = this.createAdapter(id, row.channel as ChannelType);
    this.adapters.set(id, { adapter, channel: row.channel as ChannelType });
    this.bindAdapterEvents(id, adapter);
    return adapter;
  }

  async connectInstance(id: string): Promise<void> {
    const adapter = this.ensureAdapter(id);
    try {
      await adapter.connect();
    } finally {
      this.syncStoredStatus(id, adapter);
    }
  }

  /** True when the in-memory adapter owns a socket that is not a cleared disconnect. */
  hasLiveSocket(id: string): boolean {
    const managed = this.adapters.get(id);
    if (!managed) return false;
    if (managed.adapter.hasLiveSocket) return managed.adapter.hasLiveSocket();
    const status = managed.adapter.getStatus();
    return status === "connected" || status === "connecting" || status === "qr_pending";
  }

  private syncStoredStatus(id: string, adapter: ChannelAdapter): void {
    const adapterStatus = adapter.getStatus();
    const live = this.hasLiveSocket(id);
    const status =
      !live && (adapterStatus === "connecting" || adapterStatus === "connected")
        ? "disconnected"
        : adapterStatus;
    db.update(instances).set({ status, updatedAt: Date.now() }).where(eq(instances.id, id)).run();
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

    // Delete instance (cascades to messages, contacts, groups, chats, queue_stats, instance_webhooks)
    db.delete(instances).where(eq(instances.id, id)).run();
    touchInstanceWebhookStorage();
  }

  async restartInstance(id: string): Promise<void> {
    await this.disconnectInstance(id);
    // Clear adapter so a fresh one is created
    this.adapters.delete(id);
    await this.connectInstance(id);
  }

  // ---- Adapter access ----

  /** Connected or created Baileys adapters. Cloud API instances are omitted. */
  listBaileysAdapters(): Array<{ instanceId: string; adapter: BaileysAdapter }> {
    const adapters: Array<{ instanceId: string; adapter: BaileysAdapter }> = [];
    for (const [instanceId, managed] of this.adapters) {
      if (managed.channel === "baileys") {
        adapters.push({ instanceId, adapter: managed.adapter as BaileysAdapter });
      }
    }
    return adapters;
  }

  getAdapter(id: string): ChannelAdapter {
    const managed = this.adapters.get(id);
    if (!managed) {
      throw new InstanceNotInitializedError(id);
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

  /** Return lifecycle metadata without selecting credential or session columns. */
  getInstanceLifecycleStatuses(id?: string): InstanceLifecycleStatusSnapshot[] {
    const select = db
      .select({
        id: instances.id,
        name: instances.name,
        channel: instances.channel,
        status: instances.status,
        phoneNumber: instances.phoneNumber,
        lastConnected: instances.lastConnected,
        lastDisconnected: instances.lastDisconnected,
        lastDisconnectReason: instances.lastDisconnectReason,
        lastDisconnectStatusCode: instances.lastDisconnectStatusCode,
      })
      .from(instances);
    const rows = id ? select.where(eq(instances.id, id)).all() : select.all();
    if (id && rows.length === 0) throw new InstanceNotFoundError(id);

    return rows.map((row) => {
      const managed = this.adapters.get(row.id);
      const adapter = managed?.adapter;
      const runtime = adapter?.getLifecycleStatus?.();
      const state = adapter?.getStatus() ?? row.status;
      const connected = state === "connected";
      return {
        instanceId: row.id,
        name: row.name,
        channel: row.channel as ChannelType,
        state,
        phone: connected ? (runtime?.phone ?? row.phoneNumber) : null,
        lid: connected ? (runtime?.lid ?? null) : null,
        pushName: connected ? (runtime?.pushName ?? null) : null,
        lastConnectedAt: row.lastConnected,
        lastDisconnectedAt: row.lastDisconnected,
        disconnectReason: runtime?.disconnectReason ?? row.lastDisconnectReason,
        disconnectStatusCode: runtime?.disconnectStatusCode ?? row.lastDisconnectStatusCode,
        pendingChallenge: runtime?.pendingChallenge ?? null,
        presenceMode: runtime?.presenceMode ?? null,
      };
    });
  }

  private getInstanceFromDb(id: string): InstanceEntity {
    const row = db.select().from(instances).where(eq(instances.id, id)).get();
    if (!row) {
      throw new InstanceNotFoundError(id);
    }
    return row as InstanceEntity;
  }

  /** Find a Cloud API adapter by its phone number ID (for webhook routing). */
  findCloudAdapterByPhoneNumberId(
    phoneNumberId: string,
  ): { instanceId: string; adapter: CloudApiAdapter } | null {
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
    for (const event of CHANNEL_EVENTS) {
      adapter.on(event, (payload: ChannelEventPayload[typeof event]) => {
        if (event === "instance.connected") {
          const connectedPayload = payload as ChannelEventPayload["instance.connected"];
          db.update(instances)
            .set({
              status: "connected",
              lastConnected: connectedPayload.connectedAt,
              ...(connectedPayload.phone ? { phoneNumber: connectedPayload.phone } : {}),
              updatedAt: connectedPayload.connectedAt,
            })
            .where(eq(instances.id, instanceId))
            .run();
        }

        if (event === "instance.disconnected") {
          const disconnectedPayload = payload as ChannelEventPayload["instance.disconnected"];
          db.update(instances)
            .set({
              lastDisconnectReason: disconnectedPayload.reason,
              lastDisconnectStatusCode: disconnectedPayload.statusCode,
            })
            .where(eq(instances.id, instanceId))
            .run();
        }

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
            const instance = db
              .select({
                lastConnected: instances.lastConnected,
                lastDisconnected: instances.lastDisconnected,
              })
              .from(instances)
              .where(eq(instances.id, instanceId))
              .get();
            const outageAlreadyRecorded =
              instance?.lastDisconnected != null &&
              (instance.lastConnected == null ||
                instance.lastDisconnected >= instance.lastConnected);
            // Keep the first close time until a successful connection starts a new outage.
            if (!outageAlreadyRecorded) updateFields.lastDisconnected = Date.now();
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

// ============================================================
// WA MCP — Scheduled Maintenance Jobs
// ============================================================

import { lt } from "drizzle-orm";
import { Queue, Worker, type Job } from "bullmq";
import { db } from "../db/client.js";
import { messages, processedMessages } from "../db/schema.js";
import { refreshWaVersion } from "../channels/baileys/baileys.version.js";
import type { InstanceManager } from "./instance-manager.js";
import { createChildLogger } from "../utils/logger.js";
import {
  DEFAULT_REDIS_URL,
  DEFAULT_MESSAGE_RETENTION_DAYS,
  DEDUP_TTL_HOURS,
  PRUNE_MESSAGES_CRON,
  PRUNE_DEDUP_CRON,
  CHECK_VERSION_CRON,
  HEALTH_CHECK_INTERVAL_MS,
} from "../constants.js";

const logger = createChildLogger({ service: "maintenance" });

type MaintenanceJobType = "prune-messages" | "prune-dedup" | "check-wa-version";

function getRedisOpts(): { host: string; port: number; maxRetriesPerRequest: null } {
  const url = process.env.WA_REDIS_URL ?? DEFAULT_REDIS_URL;
  const parsed = new URL(url);
  return {
    host: parsed.hostname || "localhost",
    port: parseInt(parsed.port || "6379", 10),
    maxRetriesPerRequest: null,
  };
}

export class MaintenanceService {
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private readonly instanceManager: InstanceManager;

  constructor(instanceManager: InstanceManager) {
    this.instanceManager = instanceManager;
  }

  async start(): Promise<void> {
    const redisOpts = getRedisOpts();
    const queueName = "maintenance";

    this.queue = new Queue(queueName, {
      connection: redisOpts,
      defaultJobOptions: {
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 50 },
      },
    });

    // Set up repeatable jobs
    await this.queue.add(
      "prune-messages",
      { type: "prune-messages" },
      {
        repeat: { pattern: PRUNE_MESSAGES_CRON },
        jobId: "prune-messages",
      },
    );

    await this.queue.add(
      "prune-dedup",
      { type: "prune-dedup" },
      {
        repeat: { pattern: PRUNE_DEDUP_CRON },
        jobId: "prune-dedup",
      },
    );

    await this.queue.add(
      "check-wa-version",
      { type: "check-wa-version" },
      {
        repeat: { pattern: CHECK_VERSION_CRON },
        jobId: "check-wa-version",
      },
    );

    // Worker to process maintenance jobs
    this.worker = new Worker(
      queueName,
      async (job: Job) => {
        const jobType = job.data.type as MaintenanceJobType;
        await this.processJob(jobType);
      },
      { connection: redisOpts },
    );

    this.worker.on("failed", (job: Job | undefined, err: Error) => {
      logger.error({ jobId: job?.id, err: err.message }, "Maintenance job failed");
    });

    this.worker.on("completed", (job: Job) => {
      logger.debug({ jobId: job.id }, "Maintenance job completed");
    });

    // Health check with setInterval (more frequent, lightweight)
    this.healthCheckTimer = setInterval(() => {
      this.runHealthCheck().catch((err) => {
        logger.error({ err }, "Health check failed");
      });
    }, HEALTH_CHECK_INTERVAL_MS);

    logger.info("Maintenance service started");
  }

  async stop(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }
    logger.info("Maintenance service stopped");
  }

  private async processJob(type: MaintenanceJobType): Promise<void> {
    switch (type) {
      case "prune-messages":
        await this.pruneMessages();
        break;
      case "prune-dedup":
        await this.pruneDedup();
        break;
      case "check-wa-version":
        await this.checkWaVersion();
        break;
    }
  }

  private async pruneMessages(): Promise<void> {
    const retentionDays = parseInt(
      process.env.WA_MESSAGE_RETENTION_DAYS ?? String(DEFAULT_MESSAGE_RETENTION_DAYS),
      10,
    );
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    const result = db.delete(messages).where(lt(messages.timestamp, cutoff)).run();

    logger.info({ deleted: result.changes, retentionDays }, "Pruned old messages");
  }

  private async pruneDedup(): Promise<void> {
    const cutoff = Date.now() - DEDUP_TTL_HOURS * 60 * 60 * 1000;

    const result = db
      .delete(processedMessages)
      .where(lt(processedMessages.processedAt, cutoff))
      .run();

    logger.info({ deleted: result.changes }, "Pruned dedup entries");
  }

  private async checkWaVersion(): Promise<void> {
    try {
      const result = await refreshWaVersion();
      logger.info(
        { version: result.version, isLatest: result.isLatest },
        "WhatsApp version check completed",
      );
    } catch (err) {
      logger.warn({ err }, "Failed to refresh WhatsApp version");
    }
  }

  private async runHealthCheck(): Promise<void> {
    const allInstances = this.instanceManager.getAllInstances();

    for (const instance of allInstances) {
      if (instance.status === "disconnected") {
        // Check if auto_reconnect is enabled (default: true)
        const autoReconnect = process.env.WA_AUTO_RECONNECT !== "false";
        if (!autoReconnect) continue;

        // Only reconnect instances that were previously connected
        if (!instance.lastConnected) continue;

        try {
          logger.info({ instanceId: instance.id }, "Auto-reconnecting instance");
          await this.instanceManager.connectInstance(instance.id);
        } catch (err) {
          logger.warn({ instanceId: instance.id, err }, "Failed to auto-reconnect instance");
        }
      }
    }
  }
}

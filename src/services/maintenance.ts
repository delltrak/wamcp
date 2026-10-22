// ============================================================
// WA MCP — Scheduled Maintenance Jobs
// ============================================================

import { and, gt, lt, or } from "drizzle-orm";
import { Queue, Worker, type Job } from "bullmq";
import { db } from "../db/client.js";
import { messages, processedMessages, statusAudiences } from "../db/schema.js";
import { refreshWaVersion } from "../channels/baileys/baileys.version.js";
import type { InstanceManager } from "./instance-manager.js";
import type { InstanceEntity } from "../types/db.types.js";
import { createChildLogger } from "../utils/logger.js";
import {
  DEFAULT_REDIS_URL,
  DEFAULT_MESSAGE_RETENTION_DAYS,
  DEDUP_TTL_HOURS,
  PRUNE_MESSAGES_CRON,
  PRUNE_DEDUP_CRON,
  CHECK_VERSION_CRON,
  HEALTH_CHECK_INTERVAL_MS,
  CONNECTING_STUCK_AFTER_MS,
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

    // Set up repeatable jobs. BullMQ v6 removed `repeat` from JobsOptions —
    // repeatable jobs are now Job Schedulers, keyed by the scheduler id.
    await this.queue.upsertJobScheduler(
      "prune-messages",
      { pattern: PRUNE_MESSAGES_CRON },
      { name: "prune-messages", data: { type: "prune-messages" } },
    );

    await this.queue.upsertJobScheduler(
      "prune-dedup",
      { pattern: PRUNE_DEDUP_CRON },
      { name: "prune-dedup", data: { type: "prune-dedup" } },
    );

    await this.queue.upsertJobScheduler(
      "check-wa-version",
      { pattern: CHECK_VERSION_CRON },
      { name: "check-wa-version", data: { type: "check-wa-version" } },
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
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const cutoffSeconds = Math.floor(cutoffMs / 1000);

    const result = await db
      .delete(messages)
      .where(
        or(
          lt(messages.timestamp, cutoffSeconds),
          and(gt(messages.timestamp, 1_000_000_000_000), lt(messages.timestamp, cutoffMs)),
        ),
      )
      .run();
    const audiencesResult = await db
      .delete(statusAudiences)
      .where(lt(statusAudiences.createdAt, cutoffMs))
      .run();

    logger.info(
      { deleted: result.changes, deletedStatusAudiences: audiencesResult.changes, retentionDays },
      "Pruned old messages and status audiences",
    );
  }

  private async pruneDedup(): Promise<void> {
    const cutoff = Date.now() - DEDUP_TTL_HOURS * 60 * 60 * 1000;

    const result = await db
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
    const allInstances = await this.instanceManager.getAllInstances();
    const now = Date.now();
    if (process.env.WA_AUTO_RECONNECT === "false") return;

    for (const instance of allInstances) {
      const stuckConnecting = this.isStuckConnecting(instance, now);
      if (instance.status !== "disconnected" && !stuckConnecting) continue;
      // Only reconnect instances that connected before, so an abandoned pairing
      // does not keep generating QR codes.
      if (!instance.lastConnected) continue;

      try {
        logger.info(
          { instanceId: instance.id, stuckConnecting },
          stuckConnecting ? "Recovering stuck connecting instance" : "Auto-reconnecting instance",
        );
        await this.instanceManager.connectInstance(instance.id);
      } catch (err) {
        logger.warn({ instanceId: instance.id, err }, "Failed to auto-reconnect instance");
      }
    }
  }

  private isStuckConnecting(instance: InstanceEntity, now: number): boolean {
    return (
      instance.status === "connecting" &&
      now - instance.updatedAt >= CONNECTING_STUCK_AFTER_MS &&
      !this.instanceManager.hasLiveSocket(instance.id)
    );
  }
}

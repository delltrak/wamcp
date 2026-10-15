// ============================================================
// WA MCP — Message Queue (BullMQ)
// ============================================================

import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import type { ChannelAdapter } from "../channels/channel.interface.js";
import type { MessageContent } from "../types/channel.types.js";
import {
  DEFAULT_BAILEYS_RATE_LIMIT,
  DEFAULT_CLOUD_RATE_LIMIT,
  QUEUE_RETRY_ATTEMPTS,
  QUEUE_RETRY_DELAY_MS,
  QUEUE_COMPLETED_AGE_S,
  QUEUE_FAILED_AGE_S,
} from "../constants.js";
import { createChildLogger } from "../utils/logger.js";
import { QuotedMessageResolutionError } from "../utils/quoted-message.js";
import { getRedisConnectionOptions } from "./redis.js";

const logger = createChildLogger({ service: "message-queue" });

export type OutboundJob =
  | {
      instanceId: string;
      to: string;
      content: MessageContent;
      kind?: "message";
    }
  | {
      kind: "album";
      instanceId: string;
      to: string;
      images: Array<{ image: string; caption?: string }>;
    };

export interface EnqueueResult {
  status: "queued";
  jobId: string;
}

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}

export class MessageQueue {
  private readonly redisOpts = getRedisConnectionOptions();
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Map<string, Worker>();
  private getAdapter: ((instanceId: string) => ChannelAdapter) | null = null;

  /** Set the adapter resolver so workers can send messages */
  setAdapterResolver(resolver: (instanceId: string) => ChannelAdapter): void {
    this.getAdapter = resolver;
  }

  /** Get or create a queue for an instance */
  private getOrCreateQueue(instanceId: string, channel: "baileys" | "cloud"): Queue {
    if (this.queues.has(instanceId)) {
      return this.queues.get(instanceId)!;
    }

    const queueName = `outbound-${instanceId}`;

    const defaultRateLimit =
      channel === "baileys" ? DEFAULT_BAILEYS_RATE_LIMIT : DEFAULT_CLOUD_RATE_LIMIT;
    const rateLimitVariable =
      channel === "baileys" ? "WA_BAILEYS_RATE_LIMIT" : "WA_CLOUD_RATE_LIMIT";
    const parsedRateLimit = Number(process.env[rateLimitVariable] ?? defaultRateLimit);
    const rateLimit =
      Number.isSafeInteger(parsedRateLimit) && parsedRateLimit > 0
        ? parsedRateLimit
        : defaultRateLimit;
    if (rateLimit !== parsedRateLimit) {
      logger.warn(
        { instanceId, variable: rateLimitVariable, value: process.env[rateLimitVariable] },
        `Invalid ${rateLimitVariable}; using default rate limit ${defaultRateLimit}`,
      );
    }

    const queue = new Queue(queueName, {
      connection: this.redisOpts,
      defaultJobOptions: {
        attempts: QUEUE_RETRY_ATTEMPTS,
        backoff: {
          type: "exponential",
          delay: QUEUE_RETRY_DELAY_MS,
        },
        removeOnComplete: { age: QUEUE_COMPLETED_AGE_S },
        removeOnFail: { age: QUEUE_FAILED_AGE_S },
      },
    });

    const worker = new Worker(
      queueName,
      async (job: Job) => {
        if (!this.getAdapter) {
          throw new Error("Adapter resolver not set");
        }
        const data = job.data as OutboundJob;
        const adapter = this.getAdapter(data.instanceId);
        try {
          if (data.kind === "album") {
            await adapter.sendMediaAlbum(data.to, data.images);
          } else {
            await adapter.sendMessage(data.to, data.content);
          }
        } catch (err) {
          if (err instanceof QuotedMessageResolutionError) {
            throw new UnrecoverableError(err.message);
          }
          throw err;
        }
      },
      {
        connection: this.redisOpts,
        limiter: {
          max: rateLimit,
          duration: 60_000,
        },
      },
    );

    worker.on("failed", (job: Job | undefined, err: Error) => {
      logger.error({ jobId: job?.id, instanceId, err: err.message }, "Outbound message failed");
    });

    worker.on("completed", (job: Job) => {
      logger.debug({ jobId: job.id, instanceId }, "Outbound message sent");
    });

    this.queues.set(instanceId, queue);
    this.workers.set(instanceId, worker);
    return queue;
  }

  /** Enqueue an outbound message */
  async enqueueMessage(
    instanceId: string,
    to: string,
    content: MessageContent,
    channel: "baileys" | "cloud" = "baileys",
  ): Promise<EnqueueResult> {
    if ("quotedMessageId" in content && content.quotedMessageId && this.getAdapter) {
      this.getAdapter(instanceId).validateQuotedMessage?.(to, content.quotedMessageId);
    }

    const queue = this.getOrCreateQueue(instanceId, channel);
    const jobData: OutboundJob = { instanceId, to, content };
    const job = await queue.add("send", jobData);
    return { status: "queued", jobId: job.id ?? "" };
  }

  /** Enqueue a bounded Baileys album through the same per-instance rate limiter as messages. */
  async enqueueMediaAlbum(
    instanceId: string,
    to: string,
    images: Array<{ image: string; caption?: string }>,
  ): Promise<EnqueueResult> {
    if (images.length < 2 || images.length > 10) {
      throw new Error("A WhatsApp media album must contain between 2 and 10 images");
    }
    const queue = this.getOrCreateQueue(instanceId, "baileys");
    const jobData: OutboundJob = { kind: "album", instanceId, to, images };
    // A partial album cannot be safely retried without duplicating already-sent images.
    const job = await queue.add("album", jobData, { attempts: 1 });
    return { status: "queued", jobId: job.id ?? "" };
  }

  /** Get queue stats for an instance */
  async getQueueStats(instanceId: string): Promise<QueueStats> {
    const queue = this.queues.get(instanceId);
    if (!queue) {
      return { waiting: 0, active: 0, completed: 0, failed: 0 };
    }
    const [waiting, active, completed, failed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
    ]);
    return { waiting, active, completed, failed };
  }

  /** Clean up a specific instance queue */
  async removeInstanceQueue(instanceId: string): Promise<void> {
    const worker = this.workers.get(instanceId);
    if (worker) {
      await worker.close();
      this.workers.delete(instanceId);
    }
    const queue = this.queues.get(instanceId);
    if (queue) {
      await queue.obliterate({ force: true });
      await queue.close();
      this.queues.delete(instanceId);
    }
  }

  /** Graceful shutdown */
  async close(): Promise<void> {
    for (const [id, worker] of this.workers) {
      await worker.close();
      this.workers.delete(id);
    }
    for (const [id, queue] of this.queues) {
      await queue.close();
      this.queues.delete(id);
    }
  }
}

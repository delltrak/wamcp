// ============================================================
// WA MCP — Scheduled send tools
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MessageContent } from "../types/channel.types.js";
import { toolSuccess } from "../types/mcp.types.js";
import { handleToolError } from "../utils/tool-handler.js";
import { createRequestLogger } from "../utils/logger.js";
import {
  ListScheduledSchema,
  ScheduleIdSchema,
  ScheduleMessageSchema,
} from "../schemas/schedule.schema.js";
import type { MessageScheduler } from "../services/scheduler.js";

const GATE =
  "Creating and resuming a schedule require WA_SCHEDULER_ENABLED=true. " +
  "Pause and cancel work while it is false, so overdue rows can be stopped before the worker starts. " +
  "Nothing is sent while the gate is false. Listing works either way. " +
  "Missed runs follow WA_SCHEDULER_MISSED_POLICY (skip by default, or send). " +
  "Due messages are queued through the existing per-instance outbound rate limiter, " +
  "and a backlog is not enqueued faster than that limit.";

export function registerScheduleTools(server: McpServer, scheduler: MessageScheduler): void {
  server.registerTool(
    "wa_schedule_message",
    {
      description: `Schedule a WhatsApp message once, or repeat it daily, weekly, or monthly.
The timezone is an IANA name. The default is America/Bahia. It is stored in canonical form. Names that resolve to UTC are stored as UTC, including UTC, GMT, UCT, Zulu, Etc/UTC, and Etc/GMT. Numeric offsets, abbreviations such as EST, and Etc/* zones that do not resolve to UTC are rejected.
The first run is the first valid slot at or after scheduledAt, so a weekly or monthly schedule waits
when that instant is not a selected weekday or day of the month. Later runs use that wall-clock time.
Weekdays are 0 (Sunday) through 6 (Saturday). The recipient is a phone number or group JID.
${GATE}
Returns the stored schedule. The WhatsApp send happens later and returns { status: "queued", jobId } from the outbound queue.`,
      inputSchema: ScheduleMessageSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_schedule_message", params.instanceId);
      const start = Date.now();
      try {
        const schedule = await scheduler.create({
          instanceId: params.instanceId,
          to: params.to,
          scheduledAt: params.scheduledAt,
          timezone: params.timezone,
          recurrence: params.recurrence,
          weekdays: params.weekdays,
          dayOfMonth: params.dayOfMonth,
          endAt: params.endAt,
          occurrenceLimit: params.occurrenceLimit,
          content: params.content as MessageContent,
        });
        log.info({ duration: Date.now() - start, scheduleId: schedule.id }, "Schedule created");
        return toolSuccess(schedule);
      } catch (err) {
        return handleToolError("wa_schedule_message", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_list_scheduled",
    {
      description: `List scheduled sends stored for one instance. Listing works while WA_SCHEDULER_ENABLED is false; sending does not.
${GATE}`,
      inputSchema: ListScheduledSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_list_scheduled", params.instanceId);
      const start = Date.now();
      try {
        const page = await scheduler.list({
          instanceId: params.instanceId,
          status: params.status,
          limit: params.limit,
          offset: params.offset,
        });
        log.info({ duration: Date.now() - start, total: page.total }, "Schedules listed");
        return toolSuccess(page);
      } catch (err) {
        return handleToolError("wa_list_scheduled", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_pause_scheduled",
    {
      description: `Pause an active schedule so later ticks do not send it. This works while WA_SCHEDULER_ENABLED is false. ${GATE}`,
      inputSchema: ScheduleIdSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_pause_scheduled", params.instanceId);
      try {
        const schedule = await scheduler.pause(params.instanceId, params.scheduleId);
        log.info({ scheduleId: schedule.id }, "Schedule paused");
        return toolSuccess(schedule);
      } catch (err) {
        return handleToolError("wa_pause_scheduled", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_resume_scheduled",
    {
      description: `Resume a paused schedule. A due time already missed follows WA_SCHEDULER_MISSED_POLICY on the next tick. ${GATE}`,
      inputSchema: ScheduleIdSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_resume_scheduled", params.instanceId);
      try {
        const schedule = await scheduler.resume(params.instanceId, params.scheduleId);
        log.info({ scheduleId: schedule.id }, "Schedule resumed");
        return toolSuccess(schedule);
      } catch (err) {
        return handleToolError("wa_resume_scheduled", err, params.instanceId);
      }
    },
  );

  server.registerTool(
    "wa_cancel_scheduled",
    {
      description: `Cancel an active, paused, or failed schedule. Cancelled rows are never sent. This works while WA_SCHEDULER_ENABLED is false. ${GATE}`,
      inputSchema: ScheduleIdSchema,
    },
    async (params) => {
      const log = createRequestLogger("wa_cancel_scheduled", params.instanceId);
      try {
        const schedule = await scheduler.cancel(params.instanceId, params.scheduleId);
        log.info({ scheduleId: schedule.id }, "Schedule cancelled");
        return toolSuccess(schedule);
      } catch (err) {
        return handleToolError("wa_cancel_scheduled", err, params.instanceId);
      }
    },
  );
}

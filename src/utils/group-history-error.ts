import { UnrecoverableError } from "bullmq";

export const GROUP_HISTORY_WRITES_DISABLED_MESSAGE =
  "WhatsApp group history sharing is disabled. Set WA_GROUP_WRITES_ENABLED=true to enable it.";

/** A disabled group-history write must never be retried by the outbound queue. */
export class GroupHistoryWritesDisabledError extends UnrecoverableError {
  constructor() {
    super(GROUP_HISTORY_WRITES_DISABLED_MESSAGE);
    this.name = "GroupHistoryWritesDisabledError";
  }
}

export function assertGroupHistoryWritesEnabled(): void {
  if (process.env.WA_GROUP_WRITES_ENABLED?.trim().toLowerCase() !== "true") {
    throw new GroupHistoryWritesDisabledError();
  }
}

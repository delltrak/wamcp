/** Only public group metadata, never invite codes or raw protocol attributes. */
export function safeGroupChanges(update: Record<string, unknown>): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const key of ["id", "subject", "desc", "owner", "linkedParent"] as const) {
    if (typeof update[key] === "string" || update[key] === null) changes[key] = update[key];
  }
  for (const key of ["creation", "size", "ephemeralDuration"] as const) {
    if (typeof update[key] === "number" && Number.isFinite(update[key])) changes[key] = update[key];
  }
  for (const key of [
    "isCommunity",
    "isCommunityAnnounce",
    "announce",
    "restrict",
    "memberAddMode",
    "joinApprovalMode",
  ] as const) {
    if (typeof update[key] === "boolean") changes[key] = update[key];
  }
  if (
    Object.prototype.hasOwnProperty.call(update, "linkedParent") &&
    update.linkedParent === undefined
  ) {
    changes.linkedParent = null;
  }
  return changes;
}

const GROUP_ID_PATTERN = /^\d+(?:-\d+)*(?:@g\.us)?$/;

/** Accept a bare numeric group ID or a group JID, then return its normalized JID. */
export function normalizeGroupJid(input: string): string {
  const value = input.trim();
  if (!GROUP_ID_PATTERN.test(value)) {
    throw new Error("Invalid groupId; expected a WhatsApp group ID or a JID ending in @g.us");
  }
  return value.endsWith("@g.us") ? value : `${value}@g.us`;
}

export function isValidGroupId(input: string): boolean {
  return GROUP_ID_PATTERN.test(input.trim());
}

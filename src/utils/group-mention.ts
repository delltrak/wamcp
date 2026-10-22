export const MAX_GROUP_MENTION_PARTICIPANTS = 1_024;

const MENTION_ALL_PATTERN = /(^|\s)@all\b/;

export function withGroupMentionAllText(text: string): string {
  if (MENTION_ALL_PATTERN.test(text)) return text;
  return `${text} @all`;
}

export type GroupMentionAllPlan =
  { mode: "native"; text: string } | { mode: "participants"; text: string; mentions: string[] };

/**
 * Native @all does not need participant JIDs. The participant list is only the
 * fallback used when the channel cannot emit the mention-all flag.
 */
export function planGroupMentionAll(input: {
  text: string;
  nativeSupported: boolean;
  participants?: readonly string[];
}): GroupMentionAllPlan {
  const text = withGroupMentionAllText(input.text);
  if (input.nativeSupported) return { mode: "native", text };

  const mentions = [...new Set((input.participants ?? []).filter((jid) => jid.length > 0))];
  if (mentions.length === 0) {
    throw new Error("Cannot mention all: the group has no participants");
  }
  if (mentions.length > MAX_GROUP_MENTION_PARTICIPANTS) {
    throw new Error(
      `Cannot mention all: the group has more than ${MAX_GROUP_MENTION_PARTICIPANTS} participants`,
    );
  }
  return { mode: "participants", text, mentions };
}

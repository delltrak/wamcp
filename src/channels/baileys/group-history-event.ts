import {
  WAMessageStubType,
  jidNormalizedUser,
  type BaileysEventMap,
  type WAMessage,
} from "@whiskeysockets/baileys";

function participantIdentity(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  return [record.id, record.phoneNumber, record.lid, record.pn].filter(
    (identity): identity is string => typeof identity === "string" && identity.length > 0,
  );
}

function normalizedJidIdentity(value: string): string {
  return jidNormalizedUser(value).toLowerCase();
}

/** Prove that a normalized add event came from rc14's direct-add message stub. */
export function isDirectGroupParticipantAdd(
  update: BaileysEventMap["group-participants.update"],
  messages: WAMessage[],
): boolean {
  if (update.action !== "add" || typeof update.author !== "string" || !update.author) return false;
  const authors = new Set<string>(
    [update.author, update.authorPn].filter((value): value is string => !!value),
  );
  const participantIds = new Set<string>(update.participants.flatMap(participantIdentity));
  if (participantIds.size === 0) return false;

  return messages.some((message) => {
    if (
      message.messageStubType !== WAMessageStubType.GROUP_PARTICIPANT_ADD ||
      message.key.remoteJid !== update.id
    ) {
      return false;
    }
    const rawAuthors = [message.key.participant, message.key.participantAlt].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (
      !rawAuthors.some((rawAuthor) =>
        [...authors].some(
          (author) => normalizedJidIdentity(author) === normalizedJidIdentity(rawAuthor),
        ),
      )
    ) {
      return false;
    }

    const rawParticipants = new Set<string>(
      (message.messageStubParameters ?? []).flatMap((parameter: string) => {
        let parsed: unknown = parameter;
        try {
          parsed = JSON.parse(parameter);
        } catch {
          // Malformed stub parameters cannot prove that this was a direct add.
        }
        return participantIdentity(parsed);
      }),
    );
    return [...participantIds].some((participant) =>
      [...rawParticipants].some(
        (rawParticipant) =>
          normalizedJidIdentity(participant) === normalizedJidIdentity(rawParticipant),
      ),
    );
  });
}

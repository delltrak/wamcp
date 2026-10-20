import { WAMessageStubType, jidNormalizedUser, type WAMessage } from "@whiskeysockets/baileys";

export interface GroupHistoryJoinTarget {
  identities: string[];
  /** PN JID when the stub carries one. The DM prefers this over a LID. */
  phoneJid: string | null;
}

export interface OwnDirectParticipantAdd {
  messageId: string;
  groupJid: string;
  targets: GroupHistoryJoinTarget[];
}

type OwnIdentity = { phone: string | null; lid: string | null };

type OwnDirectParticipantAddListener = (instanceId: string, add: OwnDirectParticipantAdd) => void;

const listeners = new Set<OwnDirectParticipantAddListener>();

/**
 * rc14 does not buffer `group-participants.update` (`Utils/event-buffer.js`).
 * `process-message.js` emits that event immediately, while `messages.upsert`
 * stays buffered, so the two never share a batch. Direct adds are read from
 * the upsert stub instead: `GROUP_PARTICIPANT_ADD`, with `key.participant` or
 * `key.participantAlt` equal to this account's LID or PN, and targets in
 * `messageStubParameters`.
 *
 * `group-participants.update` has no reason. rc14 maps
 * `GROUP_PARTICIPANT_ADD`, `GROUP_PARTICIPANT_INVITE`, and
 * `GROUP_PARTICIPANT_ADD_REQUEST_JOIN` to the same action `add`, and the
 * notification parser turns an `add` child into `GROUP_PARTICIPANT_ADD` only.
 * An approved join that arrives as `GROUP_PARTICIPANT_ADD` authored by this
 * account cannot be distinguished from a direct add and is sent. Stubs typed
 * `GROUP_PARTICIPANT_INVITE` or `GROUP_PARTICIPANT_ADD_REQUEST_JOIN` are ignored.
 */
export function ownDirectParticipantAdds(
  messages: WAMessage[],
  own: OwnIdentity,
): OwnDirectParticipantAdd[] {
  const ownIds = [own.phone, own.lid].filter((value): value is string => !!value);
  if (ownIds.length === 0) return [];

  const adds: OwnDirectParticipantAdd[] = [];
  for (const message of messages) {
    const add = ownDirectParticipantAdd(message, ownIds);
    if (add) adds.push(add);
  }
  return adds;
}

export function subscribeOwnDirectParticipantAdds(
  listener: OwnDirectParticipantAddListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishOwnDirectParticipantAdds(
  instanceId: string,
  messages: WAMessage[],
  own: OwnIdentity,
): void {
  for (const add of ownDirectParticipantAdds(messages, own)) {
    for (const listener of listeners) {
      try {
        listener(instanceId, add);
      } catch {
        // A listener must not break Baileys event processing. Async work reports its own errors.
      }
    }
  }
}

function ownDirectParticipantAdd(
  message: WAMessage,
  ownIds: string[],
): OwnDirectParticipantAdd | null {
  if (message.messageStubType !== WAMessageStubType.GROUP_PARTICIPANT_ADD) return null;
  const groupJid = message.key.remoteJid;
  const messageId = message.key.id;
  if (!groupJid?.endsWith("@g.us") || !messageId) return null;

  const authors = [message.key.participant, message.key.participantAlt].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (!authors.some((author) => ownIds.some((identity) => sameUser(author, identity)))) {
    return null;
  }

  const parameters: unknown[] = Array.isArray(message.messageStubParameters)
    ? message.messageStubParameters
    : [];
  const targets = parameters
    .filter(
      (parameter): parameter is string => typeof parameter === "string" && parameter.length > 0,
    )
    .map(targetFromStubParameter)
    .filter((target) => target.identities.length > 0);
  if (targets.length === 0) return null;
  return { messageId, groupJid, targets };
}

function targetFromStubParameter(parameter: string): GroupHistoryJoinTarget {
  let parsed: unknown = parameter;
  const trimmed = parameter.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      parsed = parameter;
    }
  }

  const identities = participantIdentity(parsed);
  return { identities, phoneJid: phoneJidFromParticipant(parsed, identities) };
}

function participantIdentity(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  return [record.id, record.phoneNumber, record.lid, record.pn].filter(
    (identity): identity is string => typeof identity === "string" && identity.trim().length > 0,
  );
}

function phoneJidFromParticipant(value: unknown, identities: string[]): string | null {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const phone = [record.phoneNumber, record.pn].find(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    );
    const phoneJid = phone ? toPhoneJid(phone) : null;
    if (phoneJid) return phoneJid;
  }
  for (const identity of identities) {
    const phoneJid = toPhoneJid(identity);
    if (phoneJid) return phoneJid;
  }
  return null;
}

function toPhoneJid(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes("@")) {
    const normalized = jidNormalizedUser(trimmed);
    return normalized.endsWith("@s.whatsapp.net") ? normalized : null;
  }
  const digits = trimmed.replace(/\D/g, "");
  return digits ? `${digits}@s.whatsapp.net` : null;
}

function sameUser(left: string, right: string): boolean {
  const normalizedLeft = jidNormalizedUser(left).toLowerCase();
  const normalizedRight = jidNormalizedUser(right).toLowerCase();
  return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
}

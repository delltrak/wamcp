// ============================================================
// WA MCP — Contact Store
// Persists contacts received from Baileys and serves local lookups.
// ============================================================

import { and, count, desc, eq, isNotNull, isNull, like, or } from "drizzle-orm";
import type { db as applicationDb } from "../db/client.js";
import {
  chats as chatsTable,
  contacts as contactsTable,
  messages as messagesTable,
} from "../db/schema.js";
import type { Contact } from "../types/channel.types.js";

export interface ContactSyncRecord {
  id?: string | null;
  name?: string | null;
  notify?: string | null;
  verifiedName?: string | null;
  phoneNumber?: string | null;
  lid?: string | null;
}

export interface ContactHistorySync {
  contacts?: ContactSyncRecord[];
  chats?: { id?: string | null; name?: string | null }[];
}

export type ContactPnResolver = (lid: string) => Promise<string | null>;

export interface ContactRecoverySourceResult {
  candidates: number;
  contactsAdded: number;
  error?: string;
}

export interface LocalContactRecoveryResult {
  chats: ContactRecoverySourceResult;
  messages: ContactRecoverySourceResult;
}

export class ContactStore {
  private readonly lidMappings = new Map<string, string>();

  constructor(
    private readonly instanceId: string,
    private readonly database: typeof applicationDb,
  ) {}

  /** Persist contacts delivered through Baileys contacts.upsert or contacts.update. */
  async upsertContacts(
    contacts: ContactSyncRecord[],
    resolvePn?: ContactPnResolver,
  ): Promise<void> {
    for (const contact of contacts) {
      const lid = contact.id?.endsWith("@lid") ? contact.id : (contact.lid ?? undefined);
      let phoneNumber = contact.phoneNumber ?? (lid ? this.lidMappings.get(lid) : undefined);
      if (!phoneNumber && lid && resolvePn) phoneNumber = (await resolvePn(lid)) ?? undefined;
      if (phoneNumber && lid) this.lidMappings.set(lid, phoneNumber);

      this.upsertContact(phoneNumber ? { ...contact, phoneNumber } : contact);
    }
  }

  /** Persist contacts and named one-to-one chats delivered by history sync. */
  async handleHistorySync(
    history: ContactHistorySync,
    resolvePn?: ContactPnResolver,
  ): Promise<void> {
    const contacts = (history.contacts ?? []).filter((contact) => !!contact.id);
    await this.upsertContacts(contacts, resolvePn);

    const namedChats = (history.chats ?? []).filter(
      (chat): chat is typeof chat & { id: string; name: string } =>
        !!chat.id && !!chat.name && !chat.id.endsWith("@g.us") && !chat.id.endsWith("@broadcast"),
    );
    await this.upsertContacts(namedChats.map((chat) => ({ id: chat.id, name: chat.name })));
  }

  /** Recover individual contacts from chats and messages already stored locally. */
  async recoverFromLocalData(resolvePn?: ContactPnResolver): Promise<LocalContactRecoveryResult> {
    const result: LocalContactRecoveryResult = {
      chats: { candidates: 0, contactsAdded: 0 },
      messages: { candidates: 0, contactsAdded: 0 },
    };

    const chatCandidates = new Map<string, ContactSyncRecord>();
    try {
      const chats = this.database
        .select({ jid: chatsTable.jid, name: chatsTable.name })
        .from(chatsTable)
        .where(eq(chatsTable.instanceId, this.instanceId))
        .all();
      for (const chat of chats) {
        const jid = individualJid(chat.jid);
        if (!jid) continue;
        addCandidate(chatCandidates, jid, { name: chat.name });
      }
      result.chats.candidates = chatCandidates.size;
      result.chats.contactsAdded = await this.persistRecoveredCandidates(chatCandidates, resolvePn);
    } catch (error) {
      result.chats.error = errorMessage(error);
    }

    const messageCandidates = new Map<string, ContactSyncRecord>();
    try {
      const messages = this.database
        .select({
          chatId: messagesTable.chatId,
          senderId: messagesTable.senderId,
          isFromMe: messagesTable.isFromMe,
          pushName: messagesTable.pushName,
        })
        .from(messagesTable)
        .where(eq(messagesTable.instanceId, this.instanceId))
        .orderBy(desc(messagesTable.timestamp))
        .all();
      for (const message of messages) {
        const chatJid = individualJid(message.chatId);
        if (chatJid) {
          addCandidate(messageCandidates, chatJid, {
            notify: message.isFromMe === 0 ? message.pushName : undefined,
          });
        }

        if (message.isFromMe === 0) {
          const senderJid = individualJid(message.senderId);
          if (senderJid) {
            addCandidate(messageCandidates, senderJid, { notify: message.pushName });
          }
        }
      }
      result.messages.candidates = messageCandidates.size;
      result.messages.contactsAdded = await this.persistRecoveredCandidates(
        messageCandidates,
        resolvePn,
      );
    } catch (error) {
      result.messages.error = errorMessage(error);
    }

    return result;
  }

  getContactCount(): number {
    const row = this.database
      .select({ count: count() })
      .from(contactsTable)
      .where(eq(contactsTable.instanceId, this.instanceId))
      .get();
    return row?.count ?? 0;
  }

  /** Apply a LID-to-phone mapping to contacts already persisted for this instance. */
  updateLidMapping(lid: string, pn: string): void {
    this.lidMappings.set(lid, pn);
    this.database
      .update(contactsTable)
      .set({ phone: phoneFromJid(pn), updatedAt: Date.now() })
      .where(
        and(
          eq(contactsTable.instanceId, this.instanceId),
          or(eq(contactsTable.jid, lid), eq(contactsTable.lid, lid)),
        ),
      )
      .run();
  }

  /** Return stored LIDs whose phone mapping can still be resolved at read time. */
  getUnresolvedLids(): string[] {
    const rows = this.database
      .select({ lid: contactsTable.lid })
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.instanceId, this.instanceId),
          isNull(contactsTable.phone),
          isNotNull(contactsTable.lid),
        ),
      )
      .all();
    return [...new Set(rows.flatMap((row) => (row.lid ? [row.lid] : [])))];
  }

  getContacts(search?: string): Contact[] {
    const words = search?.trim().split(/\s+/).filter(Boolean) ?? [];
    const wordConditions = words.map((word) =>
      or(
        like(contactsTable.name, `%${word}%`),
        like(contactsTable.notifyName, `%${word}%`),
        like(contactsTable.phone, `%${word}%`),
        like(contactsTable.lid, `%${word}%`),
      ),
    );
    const filters = [eq(contactsTable.instanceId, this.instanceId)];
    if (wordConditions.length > 0) filters.push(or(...wordConditions)!);

    const rows = this.database
      .select()
      .from(contactsTable)
      .where(and(...filters))
      .all();

    return rows.map((row) => ({
      jid: row.jid,
      name: row.name ?? row.notifyName ?? null,
      notifyName: row.notifyName ?? null,
      phone: row.phone ?? null,
      profilePicUrl: row.profilePicUrl ?? null,
      isBusiness: row.isBusiness === 1,
      isBlocked: row.isBlocked === 1,
    }));
  }

  private upsertContact(contact: ContactSyncRecord): void {
    const id = contact.id?.trim();
    if (!id) return;

    const isLid = id.endsWith("@lid");
    let jid = id;
    if (isLid) {
      const existingLid = this.database
        .select({ jid: contactsTable.jid })
        .from(contactsTable)
        .where(
          and(
            eq(contactsTable.instanceId, this.instanceId),
            or(eq(contactsTable.jid, id), eq(contactsTable.lid, id)),
          ),
        )
        .get();
      jid = existingLid?.jid ?? (contact.phoneNumber || id);
    }

    const existing = this.database
      .select()
      .from(contactsTable)
      .where(and(eq(contactsTable.instanceId, this.instanceId), eq(contactsTable.jid, jid)))
      .get();
    const existingHasSavedName =
      !!existing?.name &&
      (existing.nameSource === "saved" ||
        (existing.nameSource !== "notify" && existing.name !== existing.notifyName));
    const incomingName = contact.name?.trim() || null;
    const name = existingHasSavedName ? existing.name : incomingName;
    const nameSource = name ? "saved" : null;
    const notifyName = contact.notify?.trim() || existing?.notifyName || null;
    const phoneSource = contact.phoneNumber ?? (jid.endsWith("@lid") ? null : jid);
    const phone = phoneSource ? phoneFromJid(phoneSource) : (existing?.phone ?? null);
    const lid = contact.lid ?? (isLid ? id : existing?.lid) ?? null;
    const now = Date.now();

    this.database
      .insert(contactsTable)
      .values({
        instanceId: this.instanceId,
        jid,
        name,
        nameSource,
        notifyName,
        phone,
        lid,
        profilePicUrl: existing?.profilePicUrl ?? null,
        isBusiness: contact.verifiedName ? 1 : (existing?.isBusiness ?? 0),
        isBlocked: existing?.isBlocked ?? 0,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [contactsTable.instanceId, contactsTable.jid],
        set: {
          name,
          nameSource,
          notifyName,
          phone,
          lid,
          profilePicUrl: existing?.profilePicUrl ?? null,
          isBusiness: contact.verifiedName ? 1 : (existing?.isBusiness ?? 0),
          isBlocked: existing?.isBlocked ?? 0,
          updatedAt: now,
        },
      })
      .run();
  }

  private async persistRecoveredCandidates(
    candidates: Map<string, ContactSyncRecord>,
    resolvePn?: ContactPnResolver,
  ): Promise<number> {
    const before = this.getContactCount();
    await this.upsertContacts([...candidates.values()], resolvePn);
    return Math.max(0, this.getContactCount() - before);
  }
}

function individualJid(value?: string | null): string | null {
  const jid = value?.trim();
  if (!jid) return null;

  const separator = jid.indexOf("@");
  if (separator <= 0 || separator === jid.length - 1) return null;
  const local = jid.slice(0, separator).replace(/:\d+$/, "");
  const server = jid.slice(separator + 1).toLowerCase();
  if (!local || !["s.whatsapp.net", "lid", "c.us"].includes(server)) return null;
  return `${local}@${server}`;
}

function addCandidate(
  candidates: Map<string, ContactSyncRecord>,
  jid: string,
  values: Pick<ContactSyncRecord, "name" | "notify">,
): void {
  const existing = candidates.get(jid) ?? { id: jid };
  const name = values.name?.trim();
  const notify = values.notify?.trim();
  if (name && !existing.name) existing.name = name;
  if (notify && !existing.notify) existing.notify = notify;
  candidates.set(jid, existing);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function phoneFromJid(jid: string): string {
  return jid.split("@")[0].split(":")[0];
}

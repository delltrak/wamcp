// ============================================================
// WA MCP — Contact Store
// Persists contacts received from Baileys and serves local lookups.
// ============================================================

import { and, eq, like, or } from "drizzle-orm";
import type { db as applicationDb } from "../db/client.js";
import { contacts as contactsTable } from "../db/schema.js";
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

export class ContactStore {
  constructor(
    private readonly instanceId: string,
    private readonly database: typeof applicationDb,
  ) {}

  /** Persist contacts delivered through Baileys contacts.upsert or contacts.update. */
  upsertContacts(contacts: ContactSyncRecord[]): void {
    for (const contact of contacts) {
      this.upsertContact(contact);
    }
  }

  /** Persist contacts and named one-to-one chats delivered by history sync. */
  handleHistorySync(history: ContactHistorySync): void {
    const contacts = (history.contacts ?? [])
      .filter((contact) => !!contact.id)
      .map((contact) => ({ ...contact, name: contact.name ?? contact.notify }));
    this.upsertContacts(contacts);

    const namedChats = (history.chats ?? []).filter(
      (chat): chat is typeof chat & { id: string; name: string } =>
        !!chat.id && !!chat.name && !chat.id.endsWith("@g.us") && !chat.id.endsWith("@broadcast"),
    );
    this.upsertContacts(namedChats.map((chat) => ({ id: chat.id, name: chat.name })));
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
    let jid = isLid && contact.phoneNumber ? contact.phoneNumber : id;
    if (isLid && !contact.phoneNumber) {
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
      jid = existingLid?.jid ?? id;
    }

    const existing = this.database
      .select()
      .from(contactsTable)
      .where(and(eq(contactsTable.instanceId, this.instanceId), eq(contactsTable.jid, jid)))
      .get();
    const hasPhonebookName = !!existing?.name && existing.name !== existing.notifyName;
    const name = hasPhonebookName ? existing.name : (contact.name ?? existing?.name ?? null);
    const notifyName = contact.notify ?? existing?.notifyName ?? null;
    const phoneSource = contact.phoneNumber ?? (jid.endsWith("@lid") ? null : jid);
    const phone = phoneSource
      ? phoneSource.split("@")[0].split(":")[0]
      : (existing?.phone ?? null);
    const lid = contact.lid ?? (isLid ? id : existing?.lid) ?? null;
    const now = Date.now();

    this.database
      .insert(contactsTable)
      .values({
        instanceId: this.instanceId,
        jid,
        name,
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
}

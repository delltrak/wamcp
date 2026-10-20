import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  proto,
  type BaileysEventMap,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import * as schema from "../src/db/schema.js";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import type { ContactStore } from "../src/services/contact-store.js";
import { GroupMemberLabelStore } from "../src/services/group-member-label-store.js";

const INSTANCE_ID = "inst_group_label_fixture";
const GROUP_JID = "120363000000000000@g.us";
const OWN_PN = "account-placeholder@s.whatsapp.net";
const OWN_LID = "account-placeholder@lid";

const databases = new Set<Database.Database>();

function createStore() {
  const sqlite = new Database(":memory:");
  databases.add(sqlite);
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE group_member_labels (
      instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      group_jid TEXT NOT NULL,
      participant_jid TEXT NOT NULL,
      member_label TEXT,
      label_timestamp INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (instance_id, group_jid, participant_jid)
    );
  `);
  sqlite
    .prepare("INSERT INTO instances (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(INSTANCE_ID, "Group label fixture", 1, 1);
  const database = drizzle(sqlite, { schema });
  return { sqlite, store: new GroupMemberLabelStore(INSTANCE_ID, database) };
}

function createAdapter(
  store: GroupMemberLabelStore,
  updateMemberLabel = vi.fn(async () => "label-message"),
) {
  const contactStore = { getContacts: vi.fn(() => []) } as unknown as ContactStore;
  const adapter = new BaileysAdapter(INSTANCE_ID, contactStore, store);
  const sock = {
    user: { id: OWN_PN, lid: OWN_LID },
    updateMemberLabel,
    signalRepository: { lidMapping: { getPNForLID: vi.fn(async () => OWN_PN) } },
    groupMetadata: vi.fn(async () => ({
      id: GROUP_JID,
      subject: "Group fixture",
      participants: [{ id: OWN_LID, phoneNumber: OWN_PN, lid: OWN_LID }],
    })),
  } as unknown as WASocket;
  Object.assign(adapter, { sock, status: "connected" });
  return { adapter, sock, updateMemberLabel };
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("group member labels", () => {
  it("persists labels and removal tombstones for PN and LID identities", async () => {
    const { store } = createStore();

    expect((await store.update(GROUP_JID, [OWN_PN, OWN_LID], "Group coordinator", 1_700_000_000))).toBe(
      true,
    );
    expect(
      (await store
        .getForGroup(GROUP_JID))
        .sort((left, right) => left.participantJid.localeCompare(right.participantJid)),
    ).toMatchObject([
      { participantJid: OWN_LID, memberLabel: "Group coordinator", labelTimestamp: 1_700_000_000 },
      { participantJid: OWN_PN, memberLabel: "Group coordinator", labelTimestamp: 1_700_000_000 },
    ]);

    expect((await store.update(GROUP_JID, [OWN_PN, OWN_LID], null, 1_700_000_001))).toBe(true);
    expect((await store.update(GROUP_JID, [OWN_PN, OWN_LID], "Stale label", 1_700_000_000))).toBe(false);
    expect(
      (await store
        .getForGroup(GROUP_JID))
        .sort((left, right) => left.participantJid.localeCompare(right.participantJid)),
    ).toMatchObject([
      { participantJid: OWN_LID, memberLabel: null, labelTimestamp: 1_700_000_001 },
      { participantJid: OWN_PN, memberLabel: null, labelTimestamp: 1_700_000_001 },
    ]);
  });

  it("sends set and clear protocol messages and exposes the persisted label in group metadata", async () => {
    vi.stubEnv("WA_GROUP_WRITES_ENABLED", "true");
    vi.stubEnv("WA_APP_STATE_WRITES_ENABLED", "false");
    const { store } = createStore();
    const { adapter, updateMemberLabel } = createAdapter(store);
    const events: unknown[] = [];
    adapter.on("group.member_label_changed", (event) => events.push(event));

    await adapter.updateGroupMemberLabel(GROUP_JID, "Group coordinator");
    await expect(adapter.getGroupMetadata(GROUP_JID)).resolves.toMatchObject({
      participants: [{ jid: OWN_LID, memberLabel: "Group coordinator" }],
    });

    await adapter.updateGroupMemberLabel(GROUP_JID, null);
    await expect(adapter.getGroupMetadata(GROUP_JID)).resolves.toMatchObject({
      participants: [{ jid: OWN_LID }],
    });
    expect(updateMemberLabel).toHaveBeenNthCalledWith(1, GROUP_JID, "Group coordinator");
    expect(updateMemberLabel).toHaveBeenNthCalledWith(2, GROUP_JID, "");
    expect(events).toMatchObject([
      { action: "set", memberLabel: "Group coordinator", groupId: GROUP_JID },
      { action: "removed", memberLabel: null, groupId: GROUP_JID },
    ]);
  });

  it("processes Baileys label events and detects empty-label removals from protocol messages", async () => {
    const { store } = createStore();
    const { adapter } = createAdapter(store);
    const events: unknown[] = [];
    adapter.on("group.member_label_changed", (event) => events.push(event));

    let processEvents: ((events: Partial<BaileysEventMap>) => Promise<void>) | undefined;
    const socket = {
      user: { id: OWN_PN, lid: OWN_LID },
      ev: {
        on: vi.fn(),
        process: vi.fn((handler: (events: Partial<BaileysEventMap>) => Promise<void>) => {
          processEvents = handler;
        }),
      },
      signalRepository: { lidMapping: { getPNForLID: vi.fn(async () => OWN_PN) } },
    } as unknown as WASocket;
    (adapter as unknown as { bindEvents: (sock: WASocket) => void }).bindEvents(socket);

    await processEvents?.({
      "group.member-tag.update": {
        groupId: GROUP_JID,
        participant: OWN_PN,
        participantAlt: OWN_LID,
        label: "Group coordinator",
        messageTimestamp: 1_700_000_000,
      },
    });
    await processEvents?.({
      "messages.upsert": {
        type: "append",
        messages: [
          {
            key: {
              id: "LABEL-CLEAR-FIXTURE",
              remoteJid: GROUP_JID,
              participant: OWN_PN,
              participantAlt: OWN_LID,
            },
            messageTimestamp: 1_700_000_001,
            message: {
              protocolMessage: {
                type: proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE,
                memberLabel: { label: "" },
              },
            },
          } as WAMessage,
        ],
      },
    });

    expect(events).toMatchObject([
      { action: "set", memberLabel: "Group coordinator", participant: OWN_PN },
      { action: "removed", memberLabel: null, participant: OWN_PN },
    ]);
    expect(
      (await store
        .getForGroup(GROUP_JID))
        .sort((left, right) => left.participantJid.localeCompare(right.participantJid)),
    ).toMatchObject([
      { participantJid: OWN_LID, memberLabel: null, labelTimestamp: 1_700_000_001 },
      { participantJid: OWN_PN, memberLabel: null, labelTimestamp: 1_700_000_001 },
    ]);
  });

  it("requires the group write flag even if app-state writes are enabled", async () => {
    vi.stubEnv("WA_GROUP_WRITES_ENABLED", undefined);
    vi.stubEnv("WA_APP_STATE_WRITES_ENABLED", "true");
    const { store } = createStore();
    const { adapter, updateMemberLabel } = createAdapter(store);

    await expect(adapter.updateGroupMemberLabel(GROUP_JID, "Group coordinator")).rejects.toThrow(
      "WA_GROUP_WRITES_ENABLED=true",
    );
    expect(updateMemberLabel).not.toHaveBeenCalled();
  });
});

import { and, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "../db/async-session.js";
import * as schema from "../db/schema.js";
import { groupMemberLabels } from "../db/schema.js";

export type GroupMemberLabelDatabase = AppDatabase<typeof schema>;

export class GroupMemberLabelStore {
  constructor(
    private readonly instanceId: string,
    private readonly database: GroupMemberLabelDatabase,
  ) {}

  async getForGroup(groupJid: string) {
    return await this.database
      .select()
      .from(groupMemberLabels)
      .where(
        and(
          eq(groupMemberLabels.instanceId, this.instanceId),
          eq(groupMemberLabels.groupJid, groupJid),
        ),
      )
      .all();
  }

  async update(
    groupJid: string,
    participantJids: string[],
    memberLabel: string | null,
    timestamp: number,
  ): Promise<boolean> {
    const identities = [...new Set(participantJids.filter(Boolean))];
    if (identities.length === 0) return false;

    const existing = await this.database
      .select()
      .from(groupMemberLabels)
      .where(
        and(
          eq(groupMemberLabels.instanceId, this.instanceId),
          eq(groupMemberLabels.groupJid, groupJid),
          inArray(groupMemberLabels.participantJid, identities),
        ),
      )
      .all();
    const latest = existing.reduce<(typeof existing)[number] | undefined>(
      (newest, row) => (!newest || row.labelTimestamp > newest.labelTimestamp ? row : newest),
      undefined,
    );

    if (latest && latest.labelTimestamp > timestamp) return false;
    const changed = latest?.memberLabel !== memberLabel;
    const now = Date.now();

    for (const participantJid of identities) {
      await this.database
        .insert(groupMemberLabels)
        .values({
          instanceId: this.instanceId,
          groupJid,
          participantJid,
          memberLabel,
          labelTimestamp: timestamp,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            groupMemberLabels.instanceId,
            groupMemberLabels.groupJid,
            groupMemberLabels.participantJid,
          ],
          set: { memberLabel, labelTimestamp: timestamp, updatedAt: now },
        })
        .run();
    }
    return changed;
  }
}

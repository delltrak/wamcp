// ============================================================
// WA MCP — Baileys SQLite Auth State
// Implements Baileys' AuthenticationState using SQLite via
// Drizzle ORM, persisting Signal protocol keys in auth_keys.
// ============================================================

import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import { proto } from "@whiskeysockets/baileys";
import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { authKeys } from "../../db/schema.js";

const CREDS_KEY = "creds";
const KEY_BATCH = 100;

/**
 * Creates a Baileys-compatible AuthenticationState backed by SQLite.
 * Equivalent to useMultiFileAuthState but stores everything in the auth_keys table.
 */
export async function useSqliteAuthState(
  instanceId: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  // ---- Helpers ----

  const readData = async (key: string): Promise<string | null> => {
    const row = await db
      .select({ keyData: authKeys.keyData })
      .from(authKeys)
      .where(and(eq(authKeys.instanceId, instanceId), eq(authKeys.keyId, key)))
      .get();
    return row?.keyData ?? null;
  };

  const writeData = async (key: string, data: string): Promise<void> => {
    await db
      .insert(authKeys)
      .values({ instanceId, keyId: key, keyData: data })
      .onConflictDoUpdate({
        target: [authKeys.instanceId, authKeys.keyId],
        set: { keyData: data },
      })
      .run();
  };

  // ---- Load or initialize creds ----

  let creds: AuthenticationCreds;
  const credsJson = await readData(CREDS_KEY);
  if (credsJson) {
    creds = JSON.parse(credsJson, BufferJSON.reviver);
  } else {
    creds = initAuthCreds();
    await writeData(CREDS_KEY, JSON.stringify(creds, BufferJSON.replacer));
  }

  // ---- Build keys interface ----

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[],
      ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          const keyId = `${type}-${id}`;
          const raw = await readData(keyId);
          if (raw) {
            let parsed = JSON.parse(raw, BufferJSON.reviver);
            if (type === "app-state-sync-key" && parsed) {
              parsed = proto.Message.AppStateSyncKeyData.create(parsed);
            }
            result[id] = parsed;
          }
        }
        return result;
      },

      set: async (data: Record<string, Record<string, unknown>>): Promise<void> => {
        const writes: Array<{ keyId: string; keyData: string }> = [];
        const removals: string[] = [];
        for (const [type, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries)) {
            const keyId = `${type}-${id}`;
            if (value) writes.push({ keyId, keyData: JSON.stringify(value, BufferJSON.replacer) });
            else removals.push(keyId);
          }
        }
        if (writes.length === 0 && removals.length === 0) return;

        await db.transaction(async (tx) => {
          for (let offset = 0; offset < writes.length; offset += KEY_BATCH) {
            const batch = writes.slice(offset, offset + KEY_BATCH);
            await tx
              .insert(authKeys)
              .values(batch.map((row) => ({ instanceId, keyId: row.keyId, keyData: row.keyData })))
              .onConflictDoUpdate({
                target: [authKeys.instanceId, authKeys.keyId],
                set: { keyData: sql`excluded.key_data` },
              })
              .run();
          }
          for (let offset = 0; offset < removals.length; offset += KEY_BATCH) {
            const batch = removals.slice(offset, offset + KEY_BATCH);
            await tx
              .delete(authKeys)
              .where(and(eq(authKeys.instanceId, instanceId), inArray(authKeys.keyId, batch)))
              .run();
          }
        });
      },
    },
  };

  return {
    state,
    saveCreds: async () => {
      await writeData(CREDS_KEY, JSON.stringify(creds, BufferJSON.replacer));
    },
  };
}

/**
 * Clears all auth state for an instance (used after logout).
 */
export async function clearAuthState(instanceId: string): Promise<void> {
  await db.delete(authKeys).where(eq(authKeys.instanceId, instanceId)).run();
}

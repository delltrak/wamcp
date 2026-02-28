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
import { eq, and } from "drizzle-orm";
import { db } from "../../db/client.js";
import { authKeys } from "../../db/schema.js";

const CREDS_KEY = "creds";

/**
 * Creates a Baileys-compatible AuthenticationState backed by SQLite.
 * Equivalent to useMultiFileAuthState but stores everything in the auth_keys table.
 */
export async function useSqliteAuthState(
  instanceId: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  // ---- Helpers ----

  const readData = async (key: string): Promise<string | null> => {
    const row = db
      .select({ keyData: authKeys.keyData })
      .from(authKeys)
      .where(and(eq(authKeys.instanceId, instanceId), eq(authKeys.keyId, key)))
      .get();
    return row?.keyData ?? null;
  };

  const writeData = async (key: string, data: string): Promise<void> => {
    db.insert(authKeys)
      .values({ instanceId, keyId: key, keyData: data })
      .onConflictDoUpdate({
        target: [authKeys.instanceId, authKeys.keyId],
        set: { keyData: data },
      })
      .run();
  };

  const removeData = async (key: string): Promise<void> => {
    db.delete(authKeys)
      .where(and(eq(authKeys.instanceId, instanceId), eq(authKeys.keyId, key)))
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
        for (const [type, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries)) {
            const keyId = `${type}-${id}`;
            if (value) {
              await writeData(keyId, JSON.stringify(value, BufferJSON.replacer));
            } else {
              await removeData(keyId);
            }
          }
        }
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
  db.delete(authKeys).where(eq(authKeys.instanceId, instanceId)).run();
}

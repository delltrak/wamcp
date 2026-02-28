// ============================================================
// WA MCP — Baileys WA Web Version Management
// Fetches and caches the latest WhatsApp Web version.
// Falls back to bundled version on failure.
// ============================================================

import { fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { waVersionCache } from "../../db/schema.js";
import pino from "pino";

const logger = pino({ name: "baileys-version" });

// Cache duration: 24 hours
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface WaVersion {
  version: [number, number, number];
  isLatest: boolean;
}

/**
 * Get the WhatsApp Web version, using cached value when fresh.
 * Falls back to bundled version on network failure.
 */
export async function getWaVersion(): Promise<WaVersion> {
  // Check cache first
  const cached = db.select().from(waVersionCache).where(eq(waVersionCache.id, 1)).get();

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return {
      version: JSON.parse(cached.versionJson) as [number, number, number],
      isLatest: cached.isLatest === 1,
    };
  }

  // Fetch from network
  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();

    // Upsert cache
    db.insert(waVersionCache)
      .values({
        id: 1,
        versionJson: JSON.stringify(version),
        fetchedAt: Date.now(),
        isLatest: isLatest ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: waVersionCache.id,
        set: {
          versionJson: JSON.stringify(version),
          fetchedAt: Date.now(),
          isLatest: isLatest ? 1 : 0,
        },
      })
      .run();

    logger.info({ version, isLatest }, "Fetched latest WA Web version");
    return { version, isLatest };
  } catch (err) {
    logger.warn({ err }, "Failed to fetch WA version, using cached/bundled");

    // Return cached if available, even if stale
    if (cached) {
      return {
        version: JSON.parse(cached.versionJson) as [number, number, number],
        isLatest: false,
      };
    }

    // Final fallback: let Baileys use its bundled version
    const { version, isLatest } = await fetchLatestBaileysVersion();
    return { version, isLatest };
  }
}

/**
 * Force refresh the version cache (used by maintenance job).
 */
export async function refreshWaVersion(): Promise<WaVersion> {
  const { version, isLatest } = await fetchLatestBaileysVersion();

  db.insert(waVersionCache)
    .values({
      id: 1,
      versionJson: JSON.stringify(version),
      fetchedAt: Date.now(),
      isLatest: isLatest ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: waVersionCache.id,
      set: {
        versionJson: JSON.stringify(version),
        fetchedAt: Date.now(),
        isLatest: isLatest ? 1 : 0,
      },
    })
    .run();

  return { version, isLatest };
}

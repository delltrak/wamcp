// ============================================================
// WA MCP — Read-only Baileys pairing state
// Decides whether dashboard pairing is allowed without touching
// auth keys, sessions, or the database path.
// ============================================================

export interface PairingCandidate {
  channel: string;
  state: string;
  paired: boolean;
}

/**
 * An already registered Baileys device, or any connected device, must not be
 * paired again. Non-Baileys channels have no QR or pairing-code flow.
 * Returns null when starting a pairing is allowed.
 */
export function pairingRefusal(candidate: PairingCandidate): "channel" | "paired" | null {
  if (candidate.channel !== "baileys") return "channel";
  if (candidate.paired || candidate.state === "connected") return "paired";
  return null;
}

/**
 * `registered: false` in the stored creds JSON means the device is not paired.
 * Only an absent credentials row is also unpaired. Empty stored data, a missing
 * `registered` field, any other value, and unreadable creds fail closed.
 */
export function baileysCredsArePaired(keyData: string | null | undefined): boolean {
  if (keyData == null) return false;
  try {
    const parsed: unknown = JSON.parse(keyData);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return true;
    return (parsed as { registered?: unknown }).registered !== false;
  } catch {
    return true;
  }
}

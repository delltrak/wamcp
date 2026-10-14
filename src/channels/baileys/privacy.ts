import type {
  CallPrivacyValue,
  GroupAddPrivacyValue,
  OnlinePrivacyValue,
  PrivacySettings,
  PrivacyValue,
  ReadReceiptsPrivacyValue,
  StatusAudience,
} from "../../types/channel.types.js";

const PRIVACY_VALUES = ["all", "contacts", "contact_blacklist", "none"] as const;
const ONLINE_VALUES = ["all", "match_last_seen"] as const;
const READ_RECEIPT_VALUES = ["all", "none"] as const;
const GROUP_ADD_VALUES = ["all", "contacts", "contact_blacklist"] as const;
const CALL_VALUES = ["all", "known"] as const;

function normalizeValue<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Read the status visibility mode for reuse by status delivery code. */
export function readStatusAudience(settings: Record<string, string>): StatusAudience {
  return {
    mode: normalizeValue<PrivacyValue>(settings.status, PRIVACY_VALUES, "contacts"),
    includedJids: null,
    excludedJids: null,
    recipientListsAvailable: false,
  };
}

/** Convert Baileys' category-keyed privacy dictionary to a stable API shape. */
export function normalizePrivacySettings(settings: Record<string, string>): PrivacySettings {
  const statusAudience = readStatusAudience(settings);

  return {
    lastSeen: normalizeValue<PrivacyValue>(settings.last, PRIVACY_VALUES, "contacts"),
    online: normalizeValue<OnlinePrivacyValue>(settings.online, ONLINE_VALUES, "all"),
    profilePic: normalizeValue<PrivacyValue>(settings.profile, PRIVACY_VALUES, "contacts"),
    status: statusAudience.mode,
    statusAudience,
    readReceipts: normalizeValue<ReadReceiptsPrivacyValue>(
      settings.readreceipts,
      READ_RECEIPT_VALUES,
      "all",
    ),
    groupAdd: normalizeValue<GroupAddPrivacyValue>(settings.groupadd, GROUP_ADD_VALUES, "contacts"),
    calls: normalizeValue<CallPrivacyValue>(settings.calladd, CALL_VALUES, "all"),
  };
}

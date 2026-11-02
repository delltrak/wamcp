import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { logger } from "../../utils/logger.js";

/** Present only in the patched Baileys relay. Unpatched rc14 does not contain it. */
export const BAILEYS_GROUP_STATUS_PATCH_MARKER = "/* wamcp-group-status-retry-patch */";

export const GROUP_STATUS_PATCH_MISSING_ERROR =
  "Group status cannot be sent because the Baileys 7.0.0-rc14 retry patch is not applied. Reinstall dependencies so the patch runs.";

const require = createRequire(import.meta.url);

let patchApplied: boolean | undefined;

export function baileysGroupStatusPatchPath(): string {
  return require.resolve("@whiskeysockets/baileys/lib/Socket/messages-send.js");
}

export function isBaileysGroupStatusPatchApplied(): boolean {
  if (patchApplied === undefined) {
    try {
      patchApplied = readFileSync(baileysGroupStatusPatchPath(), "utf8").includes(
        BAILEYS_GROUP_STATUS_PATCH_MARKER,
      );
    } catch {
      patchApplied = false;
    }
  }
  return patchApplied;
}

/** Pass undefined to read the installed file again. */
export function setBaileysGroupStatusPatchApplied(value: boolean | undefined): void {
  patchApplied = value;
}

export function warnIfBaileysGroupStatusPatchMissing(): void {
  if (!isBaileysGroupStatusPatchApplied()) {
    logger.warn(GROUP_STATUS_PATCH_MISSING_ERROR);
  }
}

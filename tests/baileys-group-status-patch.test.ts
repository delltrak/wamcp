import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import {
  BAILEYS_GROUP_STATUS_PATCH_MARKER,
  GROUP_STATUS_PATCH_MISSING_ERROR,
  baileysGroupStatusPatchPath,
  isBaileysGroupStatusPatchApplied,
  setBaileysGroupStatusPatchApplied,
  warnIfBaileysGroupStatusPatchMissing,
} from "../src/channels/baileys/group-status-patch.js";
import { logger } from "../src/utils/logger.js";

const GROUP_JID = "120363000000000000@g.us";

describe("Baileys group status patch guard", () => {
  afterEach(() => {
    setBaileysGroupStatusPatchApplied(undefined);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("matches the installed file and the image check", () => {
    const installed = readFileSync(baileysGroupStatusPatchPath(), "utf8");
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const packageJson = readFileSync("package.json", "utf8");
    expect(installed).toContain(BAILEYS_GROUP_STATUS_PATCH_MARKER);
    expect(dockerfile).toContain(BAILEYS_GROUP_STATUS_PATCH_MARKER);
    expect(dockerfile).toContain("patch-package --error-on-fail --error-on-warn");
    expect(packageJson).toContain('"postinstall": "patch-package --error-on-fail --error-on-warn"');
    expect(packageJson).toContain('"@whiskeysockets/baileys": "7.0.0-rc14"');
    expect(packageJson).toContain('"private": true');
    expect(isBaileysGroupStatusPatchApplied()).toBe(true);
  });

  it("logs at startup and refuses a send when the marker is absent", async () => {
    setBaileysGroupStatusPatchApplied(false);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    warnIfBaileysGroupStatusPatchMissing();
    expect(warn).toHaveBeenCalledWith(GROUP_STATUS_PATCH_MISSING_ERROR);

    vi.stubEnv("WA_GROUP_STATUS_ENABLED", "true");
    vi.stubEnv("WA_GROUP_STATUS_MIN_INTERVAL_MS", "0");
    const relayMessage = vi.fn();
    const adapter = new BaileysAdapter("group-status-unpatched");
    Object.assign(adapter, {
      sock: { user: { id: "5500000000001@s.whatsapp.net" }, relayMessage },
      status: "connected",
    });
    await expect(
      adapter.sendGroupStatus({ groupId: GROUP_JID, type: "text", text: "blocked" }),
    ).rejects.toThrow(GROUP_STATUS_PATCH_MISSING_ERROR);
    expect(relayMessage).not.toHaveBeenCalled();
  });
});

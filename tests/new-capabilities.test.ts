import { describe, expect, it, vi } from "vitest";
import type { WASocket } from "@whiskeysockets/baileys";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import { GetAccountRestrictionsSchema } from "../src/schemas/instance.schema.js";
import {
  NewsletterSendMediaSchema,
  NewsletterStatsSchema,
  NewsletterMuteSchema,
  NewsletterChangeOwnerSchema,
  NewsletterDemoteAdminSchema,
} from "../src/schemas/newsletter.schema.js";
import {
  UpdateBusinessProfileSchema,
  UpdateBusinessCoverPhotoSchema,
  RemoveBusinessCoverPhotoSchema,
  SendProductSchema,
} from "../src/schemas/business.schema.js";
import { SendEventSchema, CancelEventSchema } from "../src/schemas/event.schema.js";
import {
  VotePollSchema,
  SendTemplateSchema,
  SendCtaUrlSchema,
  SendFlowSchema,
} from "../src/schemas/messaging.schema.js";
import { GroupAcceptInviteV4Schema, GroupRevokeInviteV4Schema } from "../src/schemas/group.schema.js";
import {
  SaveContactSchema,
  RemoveContactSchema,
  GetDisappearingDurationSchema,
} from "../src/schemas/contact.schema.js";

function makeBaileysAdapter(sockOverrides: Record<string, unknown> = {}) {
  const sock = {
    user: { id: "5511999999999:1@s.whatsapp.net" },
    ws: { isOpen: true },
    fetchAccountReachoutTimelock: vi.fn(async () => ({
      isActive: false,
      timeEnforcementEnds: undefined,
      enforcementType: undefined,
    })),
    fetchNewChatMessageCap: vi.fn(async () => ({
      total_quota: 100,
      used_quota: 15,
      cycle_start_timestamp: "1777593600",
      cycle_end_timestamp: "1777680000",
      server_sent_timestamp: "1777600000",
      ote_status: "none",
      mv_status: "none",
      capping_status: "uncapped",
    })),
    sendMessage: vi.fn(async () => ({ key: { id: "MSG-123" } })),
    newsletterSubscribers: vi.fn(async () => ({ subscribers: 1420 })),
    newsletterAdminCount: vi.fn(async () => 3),
    newsletterMute: vi.fn(async () => {}),
    newsletterUnmute: vi.fn(async () => {}),
    newsletterRemovePicture: vi.fn(async () => {}),
    newsletterDelete: vi.fn(async () => {}),
    newsletterChangeOwner: vi.fn(async () => {}),
    newsletterDemote: vi.fn(async () => {}),
    updateBussinesProfile: vi.fn(async () => undefined),
    updateCoverPhoto: vi.fn(async () => "COVER-99"),
    removeCoverPhoto: vi.fn(async () => undefined),
    groupAcceptInviteV4: vi.fn(async () => "120363000000000001@g.us"),
    groupRevokeInviteV4: vi.fn(async () => true),
    fetchDisappearingDuration: vi.fn(async () => [
      {
        id: "5511888888888@s.whatsapp.net",
        disappearing_mode: { duration: 86400, setAt: new Date("2026-01-01T00:00:00Z") },
      },
    ]),
    ...sockOverrides,
  } as unknown as WASocket;

  const adapter = new BaileysAdapter("baileys-test");
  Object.assign(adapter as unknown as { sock: WASocket | null; status: string }, {
    sock,
    status: "connected",
  });
  return { adapter, sock };
}

describe("Account Restrictions (Baileys 7.0.0-rc14)", () => {
  it("validates GetAccountRestrictionsSchema and fetches timelock + new-chat cap", async () => {
    expect(GetAccountRestrictionsSchema.safeParse({ instanceId: "inst-1" }).success).toBe(true);
    expect(GetAccountRestrictionsSchema.safeParse({ instanceId: "inst-1", extra: 1 }).success).toBe(
      false,
    );

    const { adapter, sock } = makeBaileysAdapter({
      fetchAccountReachoutTimelock: vi.fn(async () => ({
        isActive: true,
        timeEnforcementEnds: new Date("2026-05-01T12:00:00Z"),
        enforcementType: "spam",
      })),
      fetchNewChatMessageCap: vi.fn(async () => ({
        total_quota: 50,
        used_quota: 38,
        cycle_start_timestamp: "1777593600",
        cycle_end_timestamp: "1777680000",
        server_sent_timestamp: "1777600000",
        ote_status: "none",
        mv_status: "none",
        capping_status: "capped",
      })),
    });

    const result = await adapter.getAccountRestrictions();
    expect(sock.fetchAccountReachoutTimelock).toHaveBeenCalledOnce();
    expect(sock.fetchNewChatMessageCap).toHaveBeenCalledOnce();
    expect(result).toEqual({
      reachoutTimelock: {
        isActive: true,
        timeEnforcementEnds: "2026-05-01T12:00:00.000Z",
        enforcementType: "spam",
      },
      newChatMessageCap: {
        totalQuota: 50,
        usedQuota: 38,
        cycleStartTimestamp: "1777593600",
        cycleEndTimestamp: "1777680000",
        serverSentTimestamp: "1777600000",
        oteStatus: "none",
        mvStatus: "none",
        cappingStatus: "capped",
      },
    });
  });

  it("rejects getAccountRestrictions on Cloud API", async () => {
    const cloud = new CloudApiAdapter("cloud-test");
    await expect(cloud.getAccountRestrictions()).rejects.toThrow("only available on Baileys");
  });
});

describe("Newsletter / Channels Extended Capabilities", () => {
  it("validates NewsletterSendMediaSchema and requires fileName for documents", () => {
    expect(
      NewsletterSendMediaSchema.safeParse({
        instanceId: "inst-1",
        jid: "120363123456789@newsletter",
        type: "document",
        media: "https://example.com/file.pdf",
      }).success,
    ).toBe(false);

    expect(
      NewsletterSendMediaSchema.safeParse({
        instanceId: "inst-1",
        jid: "120363123456789@newsletter",
        type: "document",
        media: "https://example.com/file.pdf",
        fileName: "report.pdf",
      }).success,
    ).toBe(true);
  });

  it("executes newsletter stats, mute/unmute, picture removal, delete, owner transfer, and admin demote", async () => {
    const prev = process.env.WA_GROUP_WRITES_ENABLED;
    process.env.WA_GROUP_WRITES_ENABLED = "true";
    try {
      const { adapter, sock } = makeBaileysAdapter();
      const jid = "120363123456789@newsletter";

      const stats = await adapter.getNewsletterStats(jid);
      expect(stats).toEqual({ jid, subscribers: 1420, adminCount: 3 });

      await adapter.newsletterMute(jid, true);
      expect(sock.newsletterMute).toHaveBeenCalledWith(jid);

      await adapter.newsletterMute(jid, false);
      expect(sock.newsletterUnmute).toHaveBeenCalledWith(jid);

      await adapter.removeNewsletterPicture(jid);
      expect(sock.newsletterRemovePicture).toHaveBeenCalledWith(jid);

      await adapter.deleteNewsletter(jid);
      expect(sock.newsletterDelete).toHaveBeenCalledWith(jid);

      await adapter.changeNewsletterOwner(jid, "5511777777777");
      expect(sock.newsletterChangeOwner).toHaveBeenCalledWith(jid, "5511777777777@s.whatsapp.net");

      await adapter.demoteNewsletterAdmin(jid, "5511666666666");
      expect(sock.newsletterDemote).toHaveBeenCalledWith(jid, "5511666666666@s.whatsapp.net");

      expect(NewsletterStatsSchema.safeParse({ instanceId: "i", jid }).success).toBe(true);
      expect(NewsletterMuteSchema.safeParse({ instanceId: "i", jid }).success).toBe(true);
      expect(
        NewsletterChangeOwnerSchema.safeParse({
          instanceId: "i",
          jid,
          newOwnerJid: "5511777777777",
        }).success,
      ).toBe(true);
      expect(
        NewsletterDemoteAdminSchema.safeParse({
          instanceId: "i",
          jid,
          userJid: "5511666666666",
        }).success,
      ).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.WA_GROUP_WRITES_ENABLED;
      else process.env.WA_GROUP_WRITES_ENABLED = prev;
    }
  });
});

describe("WhatsApp Business Profile, Cover Photo & Product Messages", () => {
  it("updates business profile and cover photo on Baileys when writes are enabled", async () => {
    const prev = process.env.WA_APP_STATE_WRITES_ENABLED;
    process.env.WA_APP_STATE_WRITES_ENABLED = "true";
    try {
      const { adapter, sock } = makeBaileysAdapter();
      await adapter.updateBusinessProfile({
        address: "Av. Paulista, 1000",
        description: "Official Store",
        email: "contact@example.com",
        websites: ["https://example.com"],
        hours: {
          timezone: "America/Sao_Paulo",
          days: [
            {
              day: "MON",
              mode: "specific_hours",
              openTimeInMinutes: 540,
              closeTimeInMinutes: 1080,
            },
          ],
        },
      });
      expect(sock.updateBussinesProfile).toHaveBeenCalledWith({
        address: "Av. Paulista, 1000",
        description: "Official Store",
        email: "contact@example.com",
        websites: ["https://example.com"],
        hours: {
          timezone: "America/Sao_Paulo",
          days: [
            {
              day: "mon",
              mode: "specific_hours",
              openTimeInMinutes: "540",
              closeTimeInMinutes: "1080",
            },
          ],
        },
      });

      await adapter.removeBusinessCoverPhoto("PHOTO-1");
      expect(sock.removeCoverPhoto).toHaveBeenCalledWith("PHOTO-1");

      expect(
        UpdateBusinessProfileSchema.safeParse({
          instanceId: "i",
          description: "Store",
        }).success,
      ).toBe(true);
      expect(
        UpdateBusinessCoverPhotoSchema.safeParse({
          instanceId: "i",
          image: "https://example.com/cover.jpg",
        }).success,
      ).toBe(true);
      expect(
        RemoveBusinessCoverPhotoSchema.safeParse({
          instanceId: "i",
          photoId: "PHOTO-1",
        }).success,
      ).toBe(true);
      expect(
        SendProductSchema.safeParse({
          instanceId: "i",
          to: "5511999999999",
          productId: "PROD-1",
          currencyCode: "BRL",
          priceAmount1000: 25000,
        }).success,
      ).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.WA_APP_STATE_WRITES_ENABLED;
      else process.env.WA_APP_STATE_WRITES_ENABLED = prev;
    }
  });
});

describe("Events, Polls, Group Invite V4, and Disappearing Duration", () => {
  it("validates event coordinate pairing and cancel event schema", () => {
    expect(
      SendEventSchema.safeParse({
        instanceId: "i",
        to: "5511999999999",
        name: "Launch Party",
        start: "2026-06-01T18:00:00-03:00",
        latitude: -23.56,
      }).success,
    ).toBe(false);

    expect(
      SendEventSchema.safeParse({
        instanceId: "i",
        to: "5511999999999",
        name: "Launch Party",
        start: "2026-06-01T18:00:00-03:00",
        latitude: -23.56,
        longitude: -46.65,
        extraGuestsAllowed: true,
        isScheduleCall: false,
      }).success,
    ).toBe(true);

    expect(
      CancelEventSchema.safeParse({
        instanceId: "i",
        chatId: "5511999999999@s.whatsapp.net",
        eventMessageId: "EVT-1",
      }).success,
    ).toBe(true);
  });

  it("accepts and revokes Group Invite V4 and fetches disappearing durations on Baileys", async () => {
    const prev = process.env.WA_GROUP_WRITES_ENABLED;
    process.env.WA_GROUP_WRITES_ENABLED = "true";
    try {
      const { adapter, sock } = makeBaileysAdapter();
      const groupId = await adapter.acceptGroupInviteV4({
        groupJid: "120363000000000001@g.us",
        inviteCode: "INV-V4",
        inviteExpiration: 1800000000,
        inviterJid: "5511888888888",
      });
      expect(groupId).toBe("120363000000000001@g.us");
      expect(sock.groupAcceptInviteV4).toHaveBeenCalledOnce();

      const revoked = await adapter.revokeGroupInviteV4(
        "120363000000000001@g.us",
        "5511888888888",
      );
      expect(revoked).toBe(true);
      expect(sock.groupRevokeInviteV4).toHaveBeenCalledWith(
        "120363000000000001@g.us",
        "5511888888888@s.whatsapp.net",
      );

      const durations = await adapter.getDisappearingDuration(["5511888888888"]);
      expect(durations).toEqual([
        {
          jid: "5511888888888@s.whatsapp.net",
          duration: 86400,
          setAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      expect(
        GroupAcceptInviteV4Schema.safeParse({
          instanceId: "i",
          groupJid: "120363000000000001@g.us",
          inviteCode: "CODE",
          inviteExpiration: 1800000000,
        }).success,
      ).toBe(true);
      expect(
        GroupRevokeInviteV4Schema.safeParse({
          instanceId: "i",
          groupId: "120363000000000001@g.us",
          invitedJid: "5511888888888",
        }).success,
      ).toBe(true);
      expect(
        SaveContactSchema.safeParse({
          instanceId: "i",
          jid: "5511888888888",
          fullName: "Alice Silva",
        }).success,
      ).toBe(true);
      expect(
        RemoveContactSchema.safeParse({
          instanceId: "i",
          jid: "5511888888888",
        }).success,
      ).toBe(true);
      expect(
        GetDisappearingDurationSchema.safeParse({
          instanceId: "i",
          jids: ["5511888888888"],
        }).success,
      ).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.WA_GROUP_WRITES_ENABLED;
      else process.env.WA_GROUP_WRITES_ENABLED = prev;
    }
  });
});

describe("Cloud API Templates, CTA URL & Flows", () => {
  it("validates VotePollSchema, SendTemplateSchema, SendCtaUrlSchema, and SendFlowSchema", () => {
    expect(
      VotePollSchema.safeParse({
        instanceId: "i",
        chatId: "5511999999999@s.whatsapp.net",
        pollMessageId: "POLL-1",
        selectedOptions: ["Option A"],
      }).success,
    ).toBe(true);

    expect(
      SendTemplateSchema.safeParse({
        instanceId: "i",
        to: "5511999999999",
        templateName: "order_update",
        languageCode: "pt_BR",
        bodyParameters: [{ type: "text", text: "#12345" }],
      }).success,
    ).toBe(true);

    expect(
      SendCtaUrlSchema.safeParse({
        instanceId: "i",
        to: "5511999999999",
        bodyText: "Track your package below",
        displayText: "Track Order",
        url: "https://example.com/track",
      }).success,
    ).toBe(true);

    // SendFlowSchema requires either flowId or flowName, not both or neither
    expect(
      SendFlowSchema.safeParse({
        instanceId: "i",
        to: "5511999999999",
        bodyText: "Book your appointment",
        flowCta: "Book Now",
      }).success,
    ).toBe(false);

    expect(
      SendFlowSchema.safeParse({
        instanceId: "i",
        to: "5511999999999",
        bodyText: "Book your appointment",
        flowCta: "Book Now",
        flowId: "FLOW-1",
        flowName: "appointment_flow",
      }).success,
    ).toBe(false);

    expect(
      SendFlowSchema.safeParse({
        instanceId: "i",
        to: "5511999999999",
        bodyText: "Book your appointment",
        flowCta: "Book Now",
        flowId: "FLOW-1",
      }).success,
    ).toBe(true);
  });
});

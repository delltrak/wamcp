import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BinaryNode, WASocket } from "@whiskeysockets/baileys";
import { extractGroupMetadata } from "@whiskeysockets/baileys/lib/Socket/groups.js";
import { extractCommunityMetadata } from "@whiskeysockets/baileys/lib/Socket/communities.js";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import type { GroupMemberLabelStore } from "../src/services/group-member-label-store.js";

const PARENT = "120363000000000000@g.us";
const SELF = "5511999990000@s.whatsapp.net";
function groupResponse(parent = true): BinaryNode {
  return {
    tag: "iq",
    attrs: { type: "result" },
    content: [
      {
        tag: "group",
        attrs: { id: PARENT, subject: "Synthetic community" },
        content: [
          ...(parent ? [{ tag: "parent", attrs: {} }] : []),
          { tag: "participant", attrs: { jid: SELF, type: "admin" } },
          {
            tag: "description",
            attrs: { id: "previous-description" },
            content: [{ tag: "body", attrs: {}, content: Buffer.from("Old description") }],
          },
        ],
      },
    ],
  };
}
function fixture(parent = true) {
  const response = groupResponse(parent);
  // Parse real binary-node fixtures with the locked upstream parser. Network is mocked.
  const sock = {
    user: { id: SELF },
    groupMetadata: vi.fn(async () => extractGroupMetadata(response)),
    groupGetInviteInfo: vi.fn(async () => extractGroupMetadata(response)),
    groupAcceptInvite: vi.fn(async () => PARENT),
  };
  const labels = { getForGroup: () => [] } as unknown as GroupMemberLabelStore;
  const adapter = new BaileysAdapter("native-community-fixture", undefined, labels);
  Object.assign(adapter, { sock: sock as unknown as WASocket, status: "connected" });
  return { adapter, sock };
}
beforeEach(() => vi.stubEnv("WA_GROUP_WRITES_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

it("preserves the community marker and previous description ID from the standard group envelope", () => {
  const response = groupResponse();
  expect(extractGroupMetadata(response)).toMatchObject({
    id: PARENT,
    isCommunity: true,
    descId: "previous-description",
  });
  // rc14's specialized community parser cannot consume this same response.
  expect(() => extractCommunityMetadata(response)).toThrow();
});

it("inspects and joins a parent parsed from a standard group response and confirms membership", async () => {
  const { adapter, sock } = fixture();
  expect(await adapter.getCommunityInviteInfo("SyntheticCode")).toMatchObject({
    jid: PARENT,
    isCommunity: true,
  });
  expect(await adapter.joinCommunity("SyntheticCode")).toEqual({
    communityId: PARENT,
    status: "joined",
    retrySafe: false,
  });
  expect(sock.groupAcceptInvite).toHaveBeenCalledOnce();
});

it("rejects an ordinary group invitation before sending any join mutation", async () => {
  const { adapter, sock } = fixture(false);
  await expect(adapter.joinCommunity("SyntheticCode")).rejects.toThrow("community invitation");
  expect(sock.groupAcceptInvite).not.toHaveBeenCalled();
});

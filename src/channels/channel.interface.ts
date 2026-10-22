// ============================================================
// WA MCP — Channel Adapter Interface
// All channel implementations (Baileys, Cloud API) must
// implement this interface to provide a unified API surface.
// ============================================================

import type {
  ConnectionStatus,
  MessageContent,
  MessageResponse,
  GroupResponse,
  CreateGroupFromGroupResponse,
  GroupSummary,
  NumberExistsResponse,
  BusinessProfile,
  ProfileInfo,
  PrivacySettings,
  PrivacyUpdate,
  Contact,
  ContactResyncResult,
  Chat,
  Message,
  GroupMetadata,
  GroupParticipantsExport,
  CommunityHierarchy,
  CommunityInviteV4,
  CommunityParticipantAction,
  CommunityMemberScope,
  CommunitySetting,
  CommunityParticipantUpdateResult,
  CommunityGroupCreationResult,
  CommunityJoinRequest,
  ChatModification,
  GroupModification,
  ParticipantAction,
  StatusContent,
  StatusSendResult,
  CloudCredentials,
  ChannelEvent,
  ChannelEventPayload,
  BusinessLabel,
  EventResponse,
  PollResults,
  GroupJoinRequest,
  MessageReceipt,
  MessageReaction,
  LinkPreviewOptions,
  MessageSearchOptions,
  SendEventOptions,
  CatalogProductCreateInput,
  CatalogProductUpdateInput,
  NewsletterPostsPage,
  NewsletterMediaDownload,
  InstanceRuntimeStatus,
} from "../types/channel.types.js";
import type {
  CatalogCollection,
  GetCatalogOptions,
  NewsletterMetadata,
  OrderDetails,
  Product,
} from "@whiskeysockets/baileys";

export interface QuickReplyInput {
  shortcut: string;
  message: string;
  timestamp?: string;
}

// Typed event handler
export type ChannelEventHandler<E extends ChannelEvent = ChannelEvent> = (
  payload: ChannelEventPayload[E],
) => void;

export interface ChannelAdapter {
  // ---- Lifecycle ----
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): ConnectionStatus;
  /** True when this adapter owns a socket that can still reach WhatsApp. */
  hasLiveSocket?(): boolean;
  getLifecycleStatus?(): InstanceRuntimeStatus;

  // ---- Authentication ----
  getQrCode(): Promise<string | null>;
  getPairingCode(phone: string): Promise<string | null>;
  setCredentials(creds: CloudCredentials): Promise<void>;

  // ---- Messaging ----
  sendMessage(to: string, content: MessageContent): Promise<MessageResponse>;
  /** True when the channel can send native group @all without listing participant JIDs. */
  supportsNativeGroupMentionAll(): Promise<boolean>;
  sendEvent(options: SendEventOptions): Promise<MessageResponse>;
  getEventResponses(chatId: string, eventMessageId: string): Promise<EventResponse[]>;
  getPollResults(chatId: string, pollMessageId: string): Promise<PollResults>;
  starMessage(chatId: string, messageId: string, star: boolean): Promise<void>;
  validateQuotedMessage?(to: string, messageId: string): void;
  editMessage(chatId: string, msgId: string, newText: string): Promise<void>;
  deleteMessage(chatId: string, msgId: string, statusJidList?: string[]): Promise<void>;
  forwardMessage(to: string, msgId: string, fromChat: string): Promise<MessageResponse>;
  sendReaction(chatId: string, msgId: string, emoji: string): Promise<void>;
  pinMessage(chatId: string, msgId: string, pin: boolean): Promise<void>;
  sendViewOnce(
    to: string,
    media: string,
    type: "image" | "video" | "audio",
  ): Promise<MessageResponse>;
  sendLinkPreview(
    to: string,
    text: string,
    url: string,
    options?: LinkPreviewOptions,
  ): Promise<MessageResponse>;

  // ---- Presence ----
  sendPresence(
    chatId: string,
    status: "typing" | "composing" | "recording" | "paused" | "available" | "unavailable",
  ): Promise<void>;
  subscribePresence(chatId: string): Promise<void>;
  markRead(chatId: string, messageIds: string[], participant?: string): Promise<void>;
  markPlayed(chatId: string, messageIds: string[], participant?: string): Promise<void>;
  markPlayedMessage(messageId: string, chatId?: string): Promise<void>;
  getMessageReceipts(chatId: string, messageId: string): Promise<MessageReceipt[]>;
  getStatusViewers(messageId: string): Promise<string[]>;
  getMessageReactions(chatId: string, messageId: string): Promise<MessageReaction[]>;
  replyPrivatelyToGroupMessage(
    groupId: string,
    messageId: string,
    text: string,
  ): Promise<MessageResponse>;
  sendMediaAlbum(
    to: string,
    images: Array<{ image: string; caption?: string }>,
  ): Promise<MessageResponse>;

  // ---- Chats ----
  modifyChat(chatId: string, modification: ChatModification): Promise<void>;
  markChatUnread(chatId: string): Promise<void>;
  listLabels(includeDeleted?: boolean): Promise<BusinessLabel[]>;
  createLabel(name: string, color: number): Promise<BusinessLabel>;
  editLabel(id: string, update: { name?: string; color?: number }): Promise<void>;
  deleteLabel(id: string): Promise<void>;
  setChatLabel(chatId: string, labelId: string, add: boolean): Promise<void>;
  setMessageLabel(chatId: string, messageId: string, labelId: string, add: boolean): Promise<void>;
  setDisappearingMessages(chatId: string, duration: 0 | 86400 | 604800 | 7776000): Promise<void>;
  createQuickReply(input: QuickReplyInput): Promise<void>;
  editQuickReply(input: QuickReplyInput & { timestamp: string }): Promise<void>;
  deleteQuickReply(timestamp: string): Promise<void>;

  // ---- Groups ----
  listGroups(): Promise<GroupSummary[]>;
  createGroup(name: string, participants: string[]): Promise<GroupResponse>;
  createGroupFromGroup(
    sourceGroupId: string,
    name: string,
    includeParticipants?: string[],
    excludeParticipants?: string[],
  ): Promise<CreateGroupFromGroupResponse>;
  modifyGroup(groupId: string, modification: GroupModification): Promise<void>;
  modifyParticipants(
    groupId: string,
    participants: string[],
    action: ParticipantAction,
  ): Promise<void>;
  getGroupMetadata(groupId: string): Promise<GroupMetadata>;
  exportGroupParticipants(groupJid: string): Promise<GroupParticipantsExport>;
  assertGroupMemberLabelWritesEnabled(): void;
  updateGroupMemberLabel(groupId: string, memberLabel: string | null): Promise<void>;
  updateGroupPicture(groupId: string, image: string): Promise<void>;
  removeGroupPicture(groupId: string): Promise<void>;
  getGroupInviteCode(groupId: string): Promise<string>;
  getGroupInviteInfo(inviteCode: string): Promise<GroupMetadata>;
  joinGroup(inviteCode: string): Promise<string>;
  listGroupJoinRequests(groupId: string): Promise<GroupJoinRequest[]>;
  sendGroupInviteMessage(to: string, groupId: string, text?: string): Promise<MessageResponse>;
  handleJoinRequest(
    groupId: string,
    participantJid: string,
    action: "approve" | "reject",
  ): Promise<void>;
  setGroupJoinApprovalMode(groupId: string, mode: "on" | "off"): Promise<void>;
  setGroupMemberAddMode(groupId: string, mode: "admin_add" | "all_member_add"): Promise<void>;

  // ---- Communities ----
  joinCommunityV4(
    invite: CommunityInviteV4,
  ): Promise<{ communityId: string | null; status: "joined" | "unknown"; retrySafe: false }>;
  createCommunityGroup(
    communityId: string,
    name: string,
    participants: string[],
  ): Promise<CommunityGroupCreationResult>;
  updateCommunityName(communityId: string, name: string): Promise<void>;
  updateCommunityDescription(communityId: string, description: string): Promise<void>;
  updateCommunityPicture(communityId: string, image: string | null): Promise<void>;
  getCommunityMembers(
    communityId: string,
    scope: CommunityMemberScope,
    groupId?: string,
  ): Promise<GroupMetadata>;
  updateCommunityParticipants(
    communityId: string,
    participants: string[],
    action: CommunityParticipantAction,
    confirmLinkedGroupRemoval?: boolean,
  ): Promise<CommunityParticipantUpdateResult>;
  listCommunityJoinRequests(communityId: string): Promise<CommunityJoinRequest[]>;
  handleCommunityJoinRequests(
    communityId: string,
    participants: string[],
    action: "approve" | "reject",
  ): Promise<CommunityParticipantUpdateResult>;
  getCommunityInviteCode(communityId: string, revoke?: boolean): Promise<string>;
  getCommunityInviteInfo(code: string): Promise<GroupMetadata>;
  joinCommunity(
    code: string,
  ): Promise<{ communityId: string | null; status: "joined" | "unknown"; retrySafe: false }>;
  revokeCommunityMemberInvite(communityId: string, participant: string): Promise<void>;
  updateCommunitySetting(communityId: string, setting: CommunitySetting): Promise<void>;
  resolveCommunityAnnouncementGroup(communityId: string, forWrite?: boolean): Promise<string>;

  createCommunity(subject: string, description?: string): Promise<GroupMetadata | null>;
  listCommunities(): Promise<Record<string, GroupMetadata>>;
  getCommunityMetadata(communityId: string): Promise<GroupMetadata>;
  getCommunityHierarchy(communityId: string): Promise<CommunityHierarchy>;
  linkGroupToCommunity(groupId: string, communityId: string): Promise<void>;
  unlinkGroupFromCommunity(groupId: string, communityId: string): Promise<void>;
  leaveCommunity(communityId: string): Promise<void>;

  // ---- Contacts ----
  checkNumberExists(phone: string): Promise<NumberExistsResponse>;
  blockContact(jid: string): Promise<void>;
  unblockContact(jid: string): Promise<void>;
  getBlocklist(): Promise<string[]>;
  getContactAbout(jid: string): Promise<string | null>;
  getBusinessProfile(jid: string): Promise<BusinessProfile | null>;
  resyncContacts(): Promise<ContactResyncResult>;

  // ---- Profile ----
  updateProfilePicture(image: Buffer): Promise<void>;
  removeProfilePicture(): Promise<void>;
  updateProfileName(name: string): Promise<void>;
  updateProfileStatus(status: string): Promise<void>;
  updatePrivacy(update: PrivacyUpdate): Promise<void>;
  getPrivacySettings(forceRefresh?: boolean): Promise<PrivacySettings>;
  getProfilePicture(jid: string): Promise<string | null>;

  // ---- Status / Stories ----
  sendStatus(content: StatusContent): Promise<StatusSendResult>;

  // ---- Newsletter / Channels ----
  newsletterFollow(jid: string): Promise<void>;
  newsletterUnfollow(jid: string): Promise<void>;
  newsletterSend(jid: string, text: string): Promise<MessageResponse>;
  createNewsletter(name: string, description?: string): Promise<NewsletterMetadata>;
  getNewsletterMetadata(type: "invite" | "jid", key: string): Promise<NewsletterMetadata | null>;
  updateNewsletterName(jid: string, name: string): Promise<void>;
  updateNewsletterDescription(jid: string, description: string): Promise<void>;
  updateNewsletterPicture(jid: string, image: string): Promise<void>;
  reactToNewsletterMessage(jid: string, serverId: string, reaction?: string): Promise<void>;
  fetchNewsletterMessages(
    jid: string,
    count: number,
    since: number,
    after: number,
  ): Promise<NewsletterPostsPage>;
  downloadNewsletterMedia(
    newsletterJid: string,
    messageId: string,
    maxBytes?: number,
    timeoutMs?: number,
  ): Promise<NewsletterMediaDownload>;

  // ---- Business catalog ----
  getCatalog(
    options: GetCatalogOptions,
  ): Promise<{ products: Product[]; nextPageCursor: string | undefined }>;
  getCollections(jid?: string, limit?: number): Promise<{ collections: CatalogCollection[] }>;
  createProduct(input: CatalogProductCreateInput): Promise<Product>;
  updateProduct(productId: string, input: CatalogProductUpdateInput): Promise<Product>;
  deleteProducts(productIds: string[]): Promise<{ deleted: number }>;
  getOrderDetails(orderId: string, tokenBase64: string): Promise<OrderDetails>;

  // ---- Calls ----
  rejectCall(callId: string, callFrom?: string): Promise<void>;

  // ---- Data access ----
  getContacts(search?: string): Promise<Contact[]>;
  getChats(): Promise<Chat[]>;
  getMessages(chatId: string, limit?: number): Promise<Message[]>;
  searchMessages(options: MessageSearchOptions): Promise<{
    messages: Message[];
    hasMore: boolean;
    nextOffset: number | null;
  }>;
  fetchMessageHistory(
    chatId: string,
    count: number,
    timeoutMs?: number,
  ): Promise<{
    requested: number;
    limit: number;
    capped: boolean;
    stored: number;
    timedOut: boolean;
  }>;
  downloadMessageAudio(
    messageId: string,
    maxBytes?: number,
    timeoutMs?: number,
  ): Promise<{ data: Buffer; mimeType: string }>;
  downloadMessageMedia(
    messageId: string,
    chatId?: string,
    maxBytes?: number,
    timeoutMs?: number,
  ): Promise<{ data: Buffer; mimeType: string; fileName?: string }>;
  getProfileInfo(): Promise<ProfileInfo>;

  // ---- Events ----
  on<E extends ChannelEvent>(event: E, handler: ChannelEventHandler<E>): void;
  off<E extends ChannelEvent>(event: E, handler: ChannelEventHandler<E>): void;
}

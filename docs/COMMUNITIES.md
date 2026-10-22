# Community management

Tracked in [issue #166](https://github.com/delltrak/wamcp/issues/166).
The target is the WhatsApp hierarchy: community → Avisos (announcements) → linked groups,
with explicit member/admin scopes. Community support is currently partial and Baileys-only.

## Current implementation

- Create, list, inspect, link/unlink existing groups, and leave a community.
- Preserve `isCommunity`, `isCommunityAnnounce`, `linkedParent`, `joinApprovalMode`, and
  `memberAddMode` in normalized group/community metadata; missing values remain `null`.
- `wa_get_community_hierarchy` verifies a parent community, queries visible links, and joins
  those summaries with participating-group metadata to identify Avisos. Groups absent from
  participating metadata remain in the result, with unknown announcement classification.
- Return a destination only for a unique positive announcement match. Ordinary admin-only
  groups are not Avisos. Missing information, conflicting parents, and multiple matches must
  not produce a guessed destination.
- Read-only hierarchy works with both write flags disabled. Existing mutations retain their gates.
- Cloud API explicitly rejects the hierarchy operation.

Unit tests use synthetic socket responses. An in-memory MCP client/server test checks tool discovery,
strict schemas, and invocation. These tests do **not** verify WhatsApp server behavior, real account
visibility, membership completeness, or live delivery. No community mutations are part of this phase.

## Audit of the locked Baileys version

The lockfile installs `@whiskeysockets/baileys@7.0.0-rc14`. The sources inspected are
`lib/Socket/communities.js`, `lib/Socket/communities.d.ts`, and `lib/Types/GroupMetadata.d.ts`
in that package. Presence of a method is not evidence that WhatsApp accepts it for every account.

| Capability | Upstream evidence | wamcp status / remaining work |
| --- | --- | --- |
| Hierarchy | `communityFetchLinkedGroups`, group metadata flags | Implemented read tool; verify against live admin/member accounts. |
| Create child group | `communityCreateGroup` | Not exposed; handle creation succeeding but metadata lookup failing without retrying creation. |
| Name/description | `communityUpdateSubject`, `communityUpdateDescription` | Not exposed as community tools; validate parent and permissions. |
| Members/admins | `communityParticipantsUpdate` | Not exposed; preserve per-participant statuses and validate roles/LID behavior. |
| Removal scope | Upstream sets `linked_groups: 'true'` for participant removal | Explicitly document and test cascading removal before exposing it. |
| Join requests | `communityRequestParticipantsList/Update` | Not exposed; preserve per-participant outcomes. |
| Invitations | `communityInviteCode`, `communityRevokeInvite`, `communityAcceptInvite`, `communityGetInviteInfo`, V4 helpers | Not exposed; protect invitation data and handle missing results. |
| Settings | `communitySettingUpdate`, `communityMemberAddMode`, `communityJoinApprovalMode`, `communityToggleEphemeral` | Not exposed; validate each setting and permission against community semantics. |
| Photo | Generic profile/group picture APIs exist | Community-specific behavior and admin validation remain unverified. |
| Deactivation | No dedicated community-deactivation helper found in this version | Investigate protocol support; leaving must not be represented as deactivation. |
| Avisos messaging | Existing general messaging pipeline | Destination discovery started; dedicated routing and live permission/history/media/reaction validation remain pending. |
| Events/reconnect | Generic group event paths exist | Audit link/unlink and community events, cache consistency, and webhook coverage. |

Specific upstream limitations relevant to this delivery:

- `communityFetchLinkedGroups` infers “community” from absence of `linkedParent`; the new tool
  first requires `isCommunity === true` from `groupMetadata` and checks the returned parent.
- The linked-groups helper only returns ID, subject, creation, owner, and size. It discards
  announcement-specific information, so a list entry alone cannot identify Avisos.
- Community participant parsing contains a TODO for PN/LID fields. Do not infer a phone number
  from an LID or claim complete identity information.
- `communityCreate` / `communityCreateGroup` can return `null` after a successful creation if
  the subsequent metadata lookup fails. Do not automatically retry such writes.
- `communityFetchAllParticipating` and `communityMetadata` parse `communities/community` nodes;
  validate these responses against real server fixtures before claiming complete discovery.

## Remaining delivery and validation

1. Validate hierarchy visibility and Avisos discovery on an authorized test community for admin
   and member roles; record redacted fixtures and clarify unsupported cases.
2. Add editing, child-group creation, members/admins, invites, and settings in focused changes.
   Preserve the current write gates and report partial success for compound operations.
3. Add explicit Avisos routing through the existing message queue and test actual permissions.
4. Audit events, reconnection, and webhook delivery without duplicating events or exposing secrets.
5. Resolve deactivation feasibility and document unavailable capabilities explicitly.

Issue #166 remains open until implementation coverage and live validation are accounted for.

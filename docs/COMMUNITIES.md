# Community management

Tracked in [issue #166](https://github.com/delltrak/wamcp/issues/166), implemented in
[PR #167](https://github.com/delltrak/wamcp/pull/167). All community tools require Baileys.
Cloud API returns an explicit unsupported-operation error.

The model is community → Avisos (announcements) → linked groups. These are separate membership
and permission scopes. A community admin is not assumed to be an admin of every linked group.

## Supported operations

| Area | Tools / behavior |
| --- | --- |
| Discovery | `wa_list_communities`, `wa_get_community_details`, `wa_get_community_hierarchy` |
| Creation | `wa_create_community`, `wa_community_create_group` (creates directly under the parent, without a separate link step) |
| Editing | `wa_community_update_name`, `wa_community_update_description` (empty clears), `wa_community_update_picture` (null removes) |
| Groups | `wa_community_link_group`, `wa_community_unlink_group`; verify parent, group identity, membership relationship and administrative scope |
| Members | `wa_community_list_members` with scope `community`, `announcements`, or `group` and `groupId` |
| Membership/admins | `wa_community_update_participants` with `add`, `remove`, `promote`, `demote`; per-participant acknowledgements |
| Join requests | `wa_community_list_join_requests`, `wa_community_handle_join_requests` with `approve` or `reject` |
| Invitations | `wa_community_get_invite`, `wa_community_reset_invite`, `wa_community_get_invite_info`, `wa_community_join`, `wa_community_join_v4`, `wa_community_revoke_member_invite` (V4 revocation) |
| Settings | `wa_community_update_settings`; one parent setting per call, not a bulk change to linked groups |
| Announcements | `wa_community_send_announcement`; queued text, image, video, audio or document, with reply/mention fields supported by the corresponding message type |
| Leaving | `wa_leave_community`; leaves the community, never represents deactivation |

All administrative writes require `WA_GROUP_WRITES_ENABLED=true` or
`WA_APP_STATE_WRITES_ENABLED=true`. Admin checks use the connected account's PN/LID identities.
Only creation of the parent, joining and leaving do not require existing admin status.
Invitation reads and request listing require an admin but work with write flags disabled.
The WhatsApp server remains authoritative and can reject a locally permitted operation.

`wa_community_update_settings` accepts a nested `change` object:

| `change.setting` | `change.value` |
| --- | --- |
| `edit_info` | `admins` or `all` |
| `send_messages` | `admins` or `all` |
| `add_members` | `admins` or `all` |
| `join_approval` | `on` or `off` |
| `disappearing_messages` | `0`, `86400`, `604800`, `7776000` seconds |

These settings target the parent; use existing group tools to change a specific subgroup.
Picture preparation reuses the existing image decoder and public-HTTPS/size restrictions.
No automatically repeated multi-step administrative writes are introduced.

## Hierarchy, membership and unknown outcomes

- Discovery uses `groupFetchAllParticipating` and filters explicit parent markers. In rc14 the native
  community-list helper sends the same IQ but expects a different response container. Details use
  `groupMetadata` and reject non-community parents. Description editing and invitation inspection/joining
  also use the standard group helpers, retaining explicit community checks before mutations.
- Metadata preserves `isCommunity`, `isCommunityAnnounce`, `linkedParent`, `joinApprovalMode`,
  and `memberAddMode`. Missing fields remain `null`.
- The hierarchy query verifies the parent, queries visible links, and crosses them with participating
  group metadata. Groups absent from that metadata stay in the result with an unknown classification.
- Avisos is selected only from an explicit announcement marker with a matching parent. A name,
  list position or admin-only messaging flag is not sufficient. Multiple matches return no destination.
- `visibility: server_visible` is not a complete roster guarantee. Member counts describe the returned
  participants; no phone number is fabricated for a LID. Reads are not an atomic snapshot.
- `wa_community_update_participants` requires `confirmLinkedGroupRemoval: true` for removal:
  Baileys sends `linked_groups: 'true'`, so the operation also removes membership in linked groups.
  Owners/superadmins cannot be removed or demoted through this tool.
- Participant and request mutations return `success`, `partial`, `failed`, or `unknown`, with each
  requested identity's status and nullable acknowledgement. Raw protocol nodes are not exposed.
- A null creation result means `status: unknown`, `retrySafe: false`: creation may already have
  succeeded. If child creation returned an ID but local enrichment failed, retain that `groupId`
  with `status: created` and `group: null`. Inspect before retrying; no rollback deletes groups.
- Joining returns `joined` only when a follow-up parent read confirms the connected account's
  membership. Missing/failed acknowledgement, pending approval, or unavailable membership data
  returns `unknown`. Never repeat automatically because confirmation was unavailable.
- V4 joining also verifies the invitation belongs to the supplied community and rejects expired Unix-second expirations.
- An invitation reset without a returned replacement code must be followed by an invitation read,
  not another automatic reset. Invitation results are access-bearing data; do not publish them.

## Avisos and existing message tools

`wa_community_send_announcement` uses the same per-instance BullMQ queue and limiter as ordinary
messages. It verifies Avisos and admin permission before enqueueing and again in the worker. If the
destination changed it fails instead of silently sending elsewhere. Quoted messages are validated
against the resolved destination. The job has one attempt because a send timeout can occur after
delivery; automatically retrying could duplicate a broadcast. The response is `queued`, not delivered.

Example arguments (synthetic IDs):

```json
{
  "instanceId": "example-instance",
  "communityId": "120363000000000000@g.us",
  "content": { "type": "text", "text": "Community announcement" }
}
```

For history, resolve `announcementGroupJid` with `wa_get_community_hierarchy` and use
`wa_get_messages` with that chat ID. Use the existing download/reply/reaction/receipt tools with the
same ID. History is the locally stored history, not a guarantee of all prior announcements.
An unavailable or ambiguous destination must not be replaced with the community parent ID.
Live reply/reaction permissions and delivery remain subject to WhatsApp; there is no invented bypass.

## Events and reconnects

- `groups.upsert` and `groups.update` become `group.updated`; `changes` preserves safe hierarchy,
  name, description, ownership and setting fields. Invite codes and raw protocol attributes are omitted.
- Duplicate snapshots are coalesced within a batch and suppressed across identical subsequent
  metadata reads. The bounded per-instance snapshot map is reset on reconnect. It is only for event
  deduplication; all hierarchy reads query the server again and do not rely on this map.
- `group.participants_changed` carries identities and the native action, including `modify`.
- `group.join_request` carries group ID, participant, action and request method when Baileys emits it.
- These events flow through the existing instance manager, MCP notifications and webhook queue.
  Webhooks expose safe `groupChanges`, `participants`, and `requestMethod` fields.
- Reconnects can produce a new snapshot. Webhook retries retain the existing at-least-once delivery
  behavior; consumers still need their usual deduplication.
- Not every community/link/invitation change is emitted by this Baileys version. No success event is
  fabricated after a mutation; re-query the hierarchy when fresh state matters.

## Installed upstream and explicit limits

The lockfile installs `@whiskeysockets/baileys@7.0.0-rc14`. The audited package sources are
`lib/Socket/communities.js`, its declaration file, `lib/Socket/groups.js`, and `lib/Types/GroupMetadata.d.ts`.
The implementation uses the dedicated community methods where offered, with explicit metadata and
permission checks. Method availability does not establish live server support for every account.
The [official community socket source](https://github.com/WhiskeySockets/Baileys/blob/master/src/Socket/communities.ts)
was also checked on 2026-10-22: no dedicated deactivation implementation was found. A third-party
README mentions `communityDeactivate`, but its inspected community socket does not implement it;
that mention is not sufficient evidence for an irreversible protocol operation.

| Capability | Status |
| --- | --- |
| Deactivate a community | No dedicated helper in this version; not implemented by guessing an IQ or by leaving/deleting groups. |
| Group visibility and non-admin subgroup-creation switches | No dedicated, typed management helper verified in this version; not exposed as arbitrary protocol commands. |
| Accept a V4 invitation message | Implemented with sender, code, expiry and verified parent; does not rewrite the stored source message. |
| Complete discovery/roster | Limited by server visibility and returned participant metadata. |
| Native discovery/parsing | List/detail, description and invitation parsing use group helpers with explicit parent markers; live fixtures remain pending. |
| PN/LID in native community participant parsing | Upstream contains an incomplete PN/LID handling TODO; preserve IDs and avoid invented phone numbers. |
| Physical delivery and mobile UI | Not validated by mocks or in-memory MCP tests. |

## Validation

Tests cover write gates, PN/LID admin recognition, owner protection, member scopes, invalid parents,
unsafe links/unlinks, cascading-removal confirmation, partial/missing acknowledgements, strict schemas,
media queue routing, destination/permission changes before delivery, invitation errors, event filtering,
snapshot deduplication and Cloud API rejection. MCP discovery/calls are exercised in memory.

Remaining acceptance: an authorized test community with admin and member accounts, real creation,
link/unlink, invitation/approval, photo/settings operations, and visual confirmation of Avisos delivery,
replies, reactions and visibility. No real account/community was modified during local implementation.
Issue #166 remains open for those checks and the upstream limitations above.

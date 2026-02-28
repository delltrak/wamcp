# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-02-28

### Added

- Upgrade Baileys from v6 to v7 with full LID (Local Identifier) support
- LID-to-phone-number resolution via Signal repository mapping
- `wa_search_contact` tool with multi-word fuzzy matching across name, notify name, phone, and LID
- `wa_get_messages` tool to retrieve persisted chat messages from the database
- Message persistence: all messages (sent and received) are saved to SQLite automatically
- `lid` column on contacts table with inline migration for existing databases
- Contacts cached from history sync, chat metadata (`chats.upsert`), and incoming message `pushName`
- Structured logging for MCP notification delivery (success/failure tracking)
- Drizzle migration files for schema changes

### Changed

- `markOnlineOnConnect` set to `false` — instance stays offline until explicit interaction
- `syncFullHistory` enabled for better contact and chat sync on reconnection
- Pairing code flow improved with proper queueing, timeout, and caching
- Phonebook names prioritized over WhatsApp profile names in contact cache

### Fixed

- BullMQ queue names now use hyphens instead of colons (colons not allowed)
- LID normalization in incoming messages (swap `remoteJid`/`remoteJidAlt` when LID is primary)
- Group participants update type mismatch in Baileys v7 (`GroupParticipant[]` → `string[]`)
- Redis port mapped to host for external connections
- MCP notifications gracefully handle missing client sessions

## [1.0.0] - 2026-02-28

### Added

- Multi-channel WhatsApp architecture with Baileys and Cloud API adapters
- MCP server exposing WhatsApp as discoverable tools, resources, and notifications
- Instance management tools (create, list, connect, disconnect, delete)
- Messaging tools (send text, image, video, audio, document, sticker, location, contact, poll)
- Chat tools (list chats, read messages, mark as read, archive, pin, delete, mute)
- Group tools (create, list, manage participants, settings, invite links)
- Contact tools (list contacts, check WhatsApp registration, block/unblock)
- Profile tools (get/set display name, status, profile picture)
- Status/Stories tools (post text and media statuses)
- Call tools (reject incoming calls)
- Newsletter/Channel tools (list, create, manage newsletters)
- Resource endpoints for instances, contacts, chats, groups, messages, profile, privacy, blocklist
- Real-time notification system for incoming messages, status updates, calls, and presence events
- SQLite persistence with Drizzle ORM for contacts, chats, groups, and messages
- BullMQ message queue integration with Redis for reliable message delivery
- Message deduplication service
- Media download and handling service
- Zod-based schema validation for all tool inputs

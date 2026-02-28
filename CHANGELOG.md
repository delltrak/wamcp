# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

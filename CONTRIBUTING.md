# Contributing to WA MCP

Thanks for your interest in contributing to WA MCP! This guide will help you get started.

## Prerequisites

- **Node.js >= 22** (check with `node --version`)
- **Redis** running locally (for BullMQ queues)
- **npm** for package management

## Getting Started

```bash
# Clone the repository
git clone https://github.com/wamcp/wamcp.git
cd wamcp

# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Run in development mode (stdio transport)
npm run dev

# Or build and run with HTTP transport
npm run build
npm start
```

## Project Structure

```
src/
├── index.ts                     # Entry point (HTTP/stdio)
├── constants.ts                 # Defaults and limits
├── server/mcp.ts                # MCP server setup
├── tools/                       # 61 MCP tools (one file per domain)
├── resources/                   # 10 MCP resources (one file per domain)
├── notifications/events.ts      # 12 event types
├── channels/
│   ├── channel.interface.ts     # ChannelAdapter contract
│   ├── baileys/                 # Baileys (WhatsApp Web) implementation
│   └── cloud-api/               # Cloud API (Meta) implementation
├── services/
│   ├── instance-manager.ts      # Instance lifecycle
│   ├── message-queue.ts         # BullMQ rate limiting
│   ├── dedup.ts                 # Message deduplication
│   └── media.ts                 # Media handling
├── db/
│   ├── schema.ts                # Drizzle table definitions
│   └── client.ts                # SQLite connection
├── schemas/                     # Zod validation schemas (one file per domain)
└── types/                       # TypeScript definitions
```

## How to Add a New Tool

WA MCP follows a layered architecture: **tools -> services -> channels**. Here's how to add a new tool:

1. **Define the Zod schema** in `src/schemas/` (find the relevant domain file, e.g., `messaging.ts`):
   ```typescript
   export const myNewToolSchema = z.object({
     instanceId: z.string().describe("The instance ID"),
     // ... your parameters
   });
   ```

2. **Register the tool** in `src/tools/` (find the relevant domain file):
   ```typescript
   server.tool("wa_my_new_tool", "Description of what it does", myNewToolSchema, async (params) => {
     const instance = await instanceManager.get(params.instanceId);
     const result = await instance.adapter.myNewMethod(params);
     return { content: [{ type: "text", text: JSON.stringify(result) }] };
   });
   ```

3. **Implement in the channel adapter** — add the method to:
   - `src/channels/channel.interface.ts` (the interface)
   - `src/channels/baileys/` (full implementation)
   - `src/channels/cloud-api/` (implementation or stub with `throw new Error("Not implemented")`)

4. **Update the README** with the new tool in the appropriate table.

## Code Style

- **TypeScript strict mode** — no `any` types, all parameters typed
- **Zod for validation** — all tool inputs are validated through Zod schemas in `src/schemas/`
- **Pino for logging** — never use `console.log`, always use the Pino logger
- **No cross-layer imports** — tools should not import directly from channel adapters
- **One file per domain** — tools, resources, and schemas are organized by domain (messaging, groups, contacts, etc.)

## Running Checks

```bash
# Type-check (no emit)
npx tsc --noEmit

# Build (type-check + compile)
npm run build

# Development mode
npm run dev
```

## Commit Conventions

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add wa_send_sticker tool
fix: handle reconnection timeout in Baileys adapter
docs: update tools table in README
refactor: extract media upload to shared service
chore: update dependencies
```

## Pull Request Process

1. Fork the repository and create a branch from `main`
2. Make your changes following the code style above
3. Run `npx tsc --noEmit` to ensure no type errors
4. Update documentation if you added new tools, resources, or events
5. Open a pull request using the PR template
6. Wait for review — maintainers may request changes

## Reporting Bugs

Use the [bug report template](https://github.com/wamcp/wamcp/issues/new?template=bug_report.yml) to report bugs. Include your Node.js version, WA MCP version, channel type, and transport.

## Suggesting Features

Use the [feature request template](https://github.com/wamcp/wamcp/issues/new?template=feature_request.yml) or start a [discussion](https://github.com/wamcp/wamcp/discussions) for broader ideas.

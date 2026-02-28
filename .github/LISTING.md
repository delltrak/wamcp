# WA MCP - Directory Listing Strategy

## Descriptions

### One-liner (under 100 chars)
WhatsApp MCP server: 61 tools, 10 resources, 12 events for AI agents. Baileys + Cloud API.

### Short description (under 300 chars)
WA MCP is a Model Context Protocol server that gives AI agents full access to WhatsApp. 61 tools for messaging, groups, contacts, profiles, status, and newsletters. Dual-channel support (Baileys + Meta Cloud API), multi-instance, rate limiting, Docker-ready. Connect your agent and go.

### Feature bullet points (for directory listings)
- 61 MCP tools across 9 domains (messaging, groups, contacts, profile, status, newsletters, calls)
- 10 MCP resources exposing WhatsApp state via `whatsapp://` URIs
- 12 real-time notification types via SSE (messages, typing, groups, calls, connection)
- Dual-channel: Baileys (WhatsApp Web) + Meta Cloud API, same unified interface
- Multi-instance: run 1-50 WhatsApp numbers from a single server
- Full media support: images, video, audio, documents, polls, reactions, view-once
- BullMQ rate limiting to prevent WhatsApp bans (20 msg/min Baileys, 80 msg/min Cloud)
- Streamable HTTP + stdio transports
- Docker one-command setup (`docker compose up`)
- TypeScript, Zod-validated inputs, SQLite persistence

### Categories / Tags
`whatsapp`, `mcp`, `mcp-server`, `model-context-protocol`, `ai-agent`, `chatbot`,
`messaging`, `whatsapp-api`, `whatsapp-bot`, `baileys`, `cloud-api`, `typescript`,
`docker`, `automation`, `llm`, `agent-tools`

---

## MCP Directories - Where to Submit

### 1. Official MCP Registry (PRIORITY: HIGH)
- **URL:** https://registry.modelcontextprotocol.io
- **Repo:** https://github.com/modelcontextprotocol/registry
- **How:** Use the `mcp-publisher` CLI tool. Build with `make publisher`, then run `./bin/mcp-publisher`.
  Submit a `server.json` with a unique version string (semver). Once published, version metadata is immutable.
- **Docs:** https://registry.modelcontextprotocol.io/docs
- **Category:** Communication / Messaging
- **Status:** Preview (launched Sep 2025, progressing to GA)

### 2. punkpeye/awesome-mcp-servers (PRIORITY: HIGH)
- **URL:** https://github.com/punkpeye/awesome-mcp-servers
- **How:** Fork repo, edit README.md, add entry in alphabetical order under relevant category, open PR.
- **Contributing guide:** https://github.com/punkpeye/awesome-mcp-servers/blob/main/CONTRIBUTING.md
- **Web mirror:** https://mcpservers.org
- **Category:** Communication / Messaging

### 3. wong2/awesome-mcp-servers (PRIORITY: HIGH)
- **URL:** https://github.com/wong2/awesome-mcp-servers
- **How:** Fork repo, add entry to README.md under relevant category, open PR.
- **Category:** Communication / Messaging

### 4. Smithery.ai (PRIORITY: HIGH)
- **URL:** https://smithery.ai
- **How:** `smithery auth login` then `smithery mcp publish "https://my-server.com" -n @delltrak/wa-mcp`
- **Benefits:** Reaches thousands of MCP users, built-in infrastructure, discovery by search.

### 5. Glama.ai (PRIORITY: HIGH)
- **URL:** https://glama.ai/mcp/servers
- **How:** Use "Submit Server" button on the directory page. Glama indexes, scans, and ranks servers.
- **Category:** Communication

### 6. mcp.so (PRIORITY: MEDIUM)
- **URL:** https://mcp.so
- **Repo:** https://github.com/chatmcp/mcp-directory
- **How:** Create a new issue at https://github.com/chatmcp/mcp-directory/issues or use the "Submit" button on the site.
- **Category:** Communication

### 7. Docker MCP Registry (PRIORITY: MEDIUM)
- **URL:** https://docs.docker.com/ai/mcp-catalog-and-toolkit/catalog/
- **Repo:** https://github.com/docker/mcp-registry
- **How:** Containerize server as Docker image, submit PR to docker/mcp-registry with server info.
  Choose tier: Docker-built (they handle build) or community-built (you maintain).
  Upon approval, image published to `mcp/wa-mcp` on Docker Hub within 24 hours.
- **Guide:** https://github.com/docker/mcp-registry/blob/main/add_mcp_server.md

### 8. appcypher/awesome-mcp-servers (PRIORITY: MEDIUM)
- **URL:** https://github.com/appcypher/awesome-mcp-servers
- **How:** Fork, add entry, open PR.
- **Category:** Communication

### 9. TensorBlock/awesome-mcp-servers (PRIORITY: LOW)
- **URL:** https://github.com/TensorBlock/awesome-mcp-servers
- **How:** Fork, add entry, open PR. (7260+ servers indexed)

### 10. PulseMCP (PRIORITY: LOW)
- **URL:** https://www.pulsemcp.com/servers
- **How:** Check site for submission process (8600+ servers indexed daily).

### 11. MCP Server Finder (PRIORITY: LOW)
- **URL:** https://www.mcpserverfinder.com
- **How:** Check site for submission form.

### 12. Portkey MCP Servers (PRIORITY: LOW)
- **URL:** https://portkey.ai/mcp-servers
- **How:** Check site for submission process.

---

## WhatsApp / Messaging Directories

### 1. GitHub Topics
- **Already tagged:** whatsapp, whatsapp-bot, whatsapp-api, mcp, mcp-server, ai-agent
- **Action:** Verify repo topics are set in GitHub Settings > General > Topics
- **URL:** https://github.com/topics/whatsapp-bot, https://github.com/topics/whatsapp-api

### 2. modelcontextprotocol/servers - Community Servers
- **URL:** https://github.com/modelcontextprotocol/servers
- **How:** Check if they accept third-party community server listings or references.

---

## Listing Entry Template

Use this when submitting to directories:

```markdown
### [WA MCP](https://github.com/delltrak/wamcp)
WhatsApp MCP server with 61 tools, 10 resources, and 12 real-time events.
Dual-channel (Baileys + Cloud API), multi-instance, rate limiting, Docker-ready.
```

---

## Social Preview Image

GitHub social preview (shown in link cards on Twitter, Slack, Discord, etc.):

- **Recommended size:** 1280 x 640 px (2:1 ratio)
- **Format:** PNG or JPEG
- **Set at:** GitHub repo > Settings > General > Social preview
- **Content suggestions:**
  - WA MCP logo/branding
  - Key stats: "61 Tools | 10 Resources | 12 Events"
  - Tagline: "WhatsApp for AI Agents"
  - MCP + WhatsApp visual identity
  - Dark background works well for developer tools

---

## Submission Checklist

- [ ] Official MCP Registry (registry.modelcontextprotocol.io)
- [ ] punkpeye/awesome-mcp-servers (PR)
- [ ] wong2/awesome-mcp-servers (PR)
- [ ] Smithery.ai (CLI publish)
- [ ] Glama.ai (Submit button)
- [ ] mcp.so (GitHub issue)
- [ ] Docker MCP Registry (PR)
- [ ] appcypher/awesome-mcp-servers (PR)
- [ ] GitHub repo topics verified
- [ ] Social preview image uploaded (1280x640px)
- [ ] GitHub Release v1.0.0 created

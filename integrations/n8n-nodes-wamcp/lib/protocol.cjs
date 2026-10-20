"use strict";

const crypto = require("node:crypto");

const PROTOCOL_VERSION = "2024-11-05";
const EVENT_SIGNATURE_WINDOW_SECONDS = 300;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function joinUrl(baseUrl, path) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("WA MCP base URL is required");
  return `${base}${path}`;
}

function authHeaders(apiKey, extra) {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...extra,
  };
  const key = String(apiKey || "").trim();
  if (key) headers.authorization = `Bearer ${key}`;
  return headers;
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") {
    return headers.get(name) || headers.get(name.toLowerCase()) || "";
  }
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== target) continue;
    const value = headers[key];
    if (Array.isArray(value)) return value[0] || "";
    return value ? String(value) : "";
  }
  return "";
}

function parseMcpBody(body) {
  if (isObject(body)) return body;
  const text = String(body || "").trim();
  if (!text) return {};
  if (text.startsWith("{") || text.startsWith("[")) return JSON.parse(text);
  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");
  const last = dataLines[dataLines.length - 1];
  if (!last) throw new Error("WA MCP returned an empty response");
  return JSON.parse(last);
}

function toolResultData(message) {
  if (message.error) {
    throw new Error(message.error.message || "WA MCP tool call failed");
  }
  const result = message.result || {};
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  if (result.isError) throw new Error(text || "WA MCP tool call failed");
  if (!text) return { ok: true };
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function buildInitializeRequest() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "n8n-nodes-wamcp", version: "0.1.0" },
    },
  };
}

function buildInitializedNotification() {
  return { jsonrpc: "2.0", method: "notifications/initialized" };
}

function buildToolCallRequest(tool, args) {
  return {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: tool, arguments: args },
  };
}

/**
 * Open one MCP HTTP session, call one tool, and close the session.
 * `transport` performs the HTTP request and returns `{ headers, body }`.
 */
async function callWamcpTool(transport, options) {
  const url = joinUrl(options.baseUrl, "/mcp");
  const initialize = await transport({
    method: "POST",
    url,
    headers: authHeaders(options.apiKey),
    body: buildInitializeRequest(),
  });
  const sessionId = headerValue(initialize.headers, "mcp-session-id");
  if (!sessionId) throw new Error("WA MCP did not return an MCP session");
  const sessionHeaders = authHeaders(options.apiKey, { "mcp-session-id": sessionId });

  try {
    const initialized = parseMcpBody(initialize.body);
    if (initialized.error) throw new Error(initialized.error.message || "WA MCP initialize failed");
    await transport({
      method: "POST",
      url,
      headers: sessionHeaders,
      body: buildInitializedNotification(),
    });
    const call = await transport({
      method: "POST",
      url,
      headers: sessionHeaders,
      body: buildToolCallRequest(options.tool, options.arguments || {}),
    });
    return toolResultData(parseMcpBody(call.body));
  } finally {
    await transport({
      method: "DELETE",
      url,
      headers: sessionHeaders,
      body: undefined,
    }).catch(() => undefined);
  }
}

function eventName(item) {
  if (typeof item.event === "string" && item.event) return item.event;
  if (item.chat || item.chatId || item.messageId || item.text !== undefined) return "message.received";
  return "";
}

function normalizeTriggerItem(item) {
  const event = eventName(item);
  return {
    ...item,
    ...(event ? { event } : {}),
    chat: item.chat || item.chatId || null,
    text: item.text === undefined ? null : item.text,
    instanceId: item.instanceId || null,
  };
}

function extractTriggerItems(body) {
  if (Array.isArray(body)) return body.filter(isObject);
  if (!isObject(body)) return [];
  if (Array.isArray(body.events)) return body.events.filter(isObject);
  if (Array.isArray(body.messages)) return body.messages.filter(isObject);
  return [body];
}

/** HMAC-SHA256 of `${timestamp}.${rawBody}`, matching x-wa-event-signature. */
function verifyEventSignature(input) {
  const secret = String(input.secret || "");
  if (!secret) return false;
  const timestamp = String(input.timestamp || "").trim();
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) return false;
  const now = Number.isFinite(input.nowSeconds) ? input.nowSeconds : Math.floor(Date.now() / 1000);
  if (Math.abs(now - seconds) > EVENT_SIGNATURE_WINDOW_SECONDS) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(String(input.signature || "").trim());
  if (!match) return false;
  const rawBody = Buffer.isBuffer(input.rawBody)
    ? input.rawBody
    : typeof input.rawBody === "string"
      ? Buffer.from(input.rawBody, "utf8")
      : null;
  if (!rawBody) return false;
  const digest = crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  const provided = Buffer.from(match[1], "hex");
  if (digest.length !== provided.length) return false;
  return crypto.timingSafeEqual(digest, provided);
}

/** Direct incoming chats. Groups, status broadcasts, and fromMe events stay out. */
function isDirectIncomingEvent(item) {
  if (!isObject(item)) return false;
  const chat = String(item.chat || item.chatId || "").toLowerCase();
  const fromMe = item.isFromMe === true || item.fromMe === true;
  const group = chat.endsWith("@g.us");
  const status = chat === "status@broadcast" || chat.endsWith("@broadcast");
  const newsletter = chat.endsWith("@newsletter");
  return Boolean(chat) && !fromMe && !group && !status && !newsletter;
}

/** Keep webhook deliveries whose event is selected on the trigger. */
function filterTriggerEvents(body, eventsCsv) {
  const allowed = new Set(
    String(eventsCsv || "message.received")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  return extractTriggerItems(body)
    .map(normalizeTriggerItem)
    .filter((item) => item.event && allowed.has(item.event));
}

module.exports = {
  authHeaders,
  buildInitializeRequest,
  buildInitializedNotification,
  buildToolCallRequest,
  callWamcpTool,
  filterTriggerEvents,
  headerValue,
  isDirectIncomingEvent,
  parseMcpBody,
  toolResultData,
  verifyEventSignature,
};

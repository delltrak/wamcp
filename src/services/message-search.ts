import type { SqlDatabase } from "../db/client.js";
import type { Message, MessageSearchOptions } from "../types/channel.types.js";

interface MessageSearchRow {
  id: string;
  chat_id: string;
  sender_id: string;
  type: Message["type"];
  content: string | null;
  media_url: string | null;
  media_mimetype: string | null;
  quoted_id: string | null;
  is_from_me: number;
  is_forwarded: number;
  status: Message["status"];
  timestamp: number;
  starred: number;
}

function escapeLikeWildcards(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** Search one instance's local SQLite message store using bound SQL parameters. */
export async function searchStoredMessages(
  sqlite: SqlDatabase,
  instanceId: string,
  options: MessageSearchOptions,
): Promise<{ messages: Message[]; hasMore: boolean; nextOffset: number | null }> {
  const filters = ["instance_id = ?", "lower(content) LIKE lower(?) ESCAPE '\\'"];
  const values: Array<string | number> = [instanceId, `%${escapeLikeWildcards(options.query)}%`];

  if (options.from !== undefined) {
    filters.push("timestamp >= ?");
    values.push(options.from);
  }
  if (options.to !== undefined) {
    filters.push("timestamp <= ?");
    values.push(options.to);
  }
  if (options.sender !== undefined) {
    filters.push("sender_id = ?");
    values.push(options.sender);
  }
  if (options.chatId !== undefined) {
    filters.push("chat_id = ?");
    values.push(options.chatId);
  }

  values.push(options.limit + 1, options.offset);
  const rows = (await sqlite
    .prepare(
      `SELECT id, chat_id, sender_id, type, content, media_url, media_mimetype,
              quoted_id, is_from_me, is_forwarded, status, timestamp, starred
       FROM messages
       WHERE ${filters.join(" AND ")}
       ORDER BY timestamp DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...values)) as unknown as MessageSearchRow[];

  const hasMore = rows.length > options.limit;
  const messages = rows.slice(0, options.limit).map((row): Message => ({
    id: row.id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    type: row.type,
    content: row.content,
    mediaUrl: row.media_url,
    ...(row.media_mimetype
      ? { mediaMimetype: row.media_mimetype, mimeType: row.media_mimetype }
      : {}),
    quotedMessageId: row.quoted_id,
    isFromMe: row.is_from_me === 1,
    isForwarded: row.is_forwarded === 1,
    status: row.status,
    timestamp: row.timestamp,
    starred: row.starred === 1,
  }));

  return {
    messages,
    hasMore,
    nextOffset: hasMore ? options.offset + options.limit : null,
  };
}

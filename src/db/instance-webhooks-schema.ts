/**
 * #142 DDL for instance_webhooks.
 * Kept as one statement so it can move into a shared schema script.
 * Runtime queries use `?` placeholders only.
 */
export const INSTANCE_WEBHOOKS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS instance_webhooks (
  instance_id     TEXT PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  auth_header     TEXT,
  auth_value      TEXT,
  events          TEXT,
  updated_at      INTEGER NOT NULL
);
`;

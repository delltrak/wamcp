// ============================================================
// WA MCP — SQLite SQL adapted for Postgres
// Drizzle still builds SQLite statements. Postgres receives the
// same text with numbered parameters and scalar MAX rewritten.
// ============================================================

function isIdentChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

interface Span {
  text: string;
  next: number;
}

/**
 * Replaces `?` placeholders outside quotes, comments, dollar quotes,
 * and JSON operators with `$1`, `$2`, ...
 */
export function replaceSqlitePlaceholders(sql: string): string {
  return bindParameters(sql, undefined).sql;
}

/** Bind `?` or `@name` / `:name` / `$name` parameters the way better-sqlite3 does. */
export function bindParameters(
  sql: string,
  params: readonly unknown[] | undefined,
): { sql: string; values: unknown[] } {
  const namedObject =
    params?.length === 1 && params[0] !== undefined && isBindObject(params[0]) ? params[0] : null;
  const values: unknown[] = [];
  let out = "";
  let index = 0;
  let positional = 0;
  while (index < sql.length) {
    const skipped = readSkipped(sql, index);
    if (skipped) {
      out += skipped.text;
      index = skipped.next;
      continue;
    }
    const named = readNamedPlaceholder(sql, index);
    if (named) {
      if (!namedObject) {
        throw new Error(`SQLite named parameter ${named.token} requires an object bind`);
      }
      values.push(lookupNamed(namedObject, named.name));
      out += `$${values.length}`;
      index = named.next;
      continue;
    }
    if (sql[index] === "?" && !isJsonOperator(sql, index)) {
      if (namedObject) {
        throw new Error("Cannot mix anonymous ? placeholders with an object bind");
      }
      const value = params?.[positional];
      positional += 1;
      values.push(value);
      out += `$${values.length}`;
      index += 1;
      continue;
    }
    out += sql[index];
    index += 1;
  }
  if (params && !namedObject && positional !== params.length) {
    throw new Error(`Expected ${positional} SQL parameters but received ${params.length}`);
  }
  return { sql: out, values: namedObject || params ? values.map(normalizeSqlValue) : [] };
}

/** SQLite scalar max(a, b) is GREATEST on Postgres. Aggregate MAX(x) stays. */
export function replaceScalarMax(sql: string): string {
  let out = "";
  let index = 0;
  while (index < sql.length) {
    const skipped = readSkipped(sql, index);
    if (skipped) {
      out += skipped.text;
      index = skipped.next;
      continue;
    }

    if (startsKeyword(sql, index, "MAX") && !isIdentChar(sql[index - 1])) {
      let cursor = index + 3;
      while (sql[cursor] === " " || sql[cursor] === "\n" || sql[cursor] === "\t") cursor += 1;
      if (sql[cursor] === "(") {
        const close = findClosingParen(sql, cursor);
        const args = splitTopLevelArgs(sql.slice(cursor + 1, close));
        if (args.length >= 2) {
          out += `GREATEST(${args.join(", ")})`;
          index = close + 1;
          continue;
        }
      }
    }

    out += sql[index];
    index += 1;
  }
  return out;
}

/**
 * SQLite accepts `ON CONFLICT ("table"."column")`. Postgres inference columns
 * must be unqualified.
 */
export function stripOnConflictQualifiers(sql: string): string {
  const match = /on conflict\s*\(/i.exec(sql);
  if (!match || match.index === undefined) return sql;
  const open = match.index + match[0].length - 1;
  const close = findClosingParen(sql, open);
  const stripped = sql.slice(open + 1, close).replace(/"([^"]+)"\s*\.\s*"([^"]+)"/g, '"$2"');
  return sql.slice(0, open + 1) + stripped + sql.slice(close);
}

/** SQLite's implicit rowid is the physical ctid on Postgres. */
export function replaceSqliteRowid(sql: string): string {
  let out = "";
  let index = 0;
  while (index < sql.length) {
    const skipped = readSkipped(sql, index);
    if (skipped) {
      out += skipped.text;
      index = skipped.next;
      continue;
    }
    if (
      startsKeyword(sql, index, "ROWID") &&
      !isIdentChar(sql[index - 1]) &&
      !isIdentChar(sql[index + 5])
    ) {
      out += "ctid";
      index += 5;
      continue;
    }
    out += sql[index];
    index += 1;
  }
  return out;
}

export function toPostgresQuery(sql: string): string {
  return replaceSqlitePlaceholders(adaptSqliteStatement(sql));
}

/** Structural SQLite syntax adapted for Postgres, before parameters are numbered. */
export function adaptSqliteStatement(sql: string): string {
  return replaceSqliteRowid(stripOnConflictQualifiers(replaceScalarMax(sql)));
}

/** SQLite INTEGER is 64-bit. Postgres INTEGER is int4, so DDL uses BIGINT. */
export function sqliteDdlToPostgres(sql: string): string {
  let out = "";
  let index = 0;
  while (index < sql.length) {
    const skipped = readSkipped(sql, index);
    if (skipped) {
      out += skipped.text;
      index = skipped.next;
      continue;
    }
    if (startsKeyword(sql, index, "INTEGER") && !isIdentChar(sql[index - 1])) {
      const after = index + "INTEGER".length;
      if (!isIdentChar(sql[after])) {
        out += "BIGINT";
        index = after;
        continue;
      }
    }
    out += sql[index];
    index += 1;
  }
  return out;
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let index = 0;
  while (index < sql.length) {
    const skipped = readSkipped(sql, index);
    if (skipped) {
      current += skipped.text;
      index = skipped.next;
      continue;
    }
    if (sql[index] === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      index += 1;
      continue;
    }
    current += sql[index];
    index += 1;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

export function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error("Unexpected SQL identifier");
  }
  return `"${name}"`;
}

/** Values stored in SQLite INTEGER/TEXT columns, safe to send to either driver. */
export function normalizeSqlValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "string") return value.replaceAll("\u0000", "");
  if (typeof value === "bigint") return bigintForSql(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  return value;
}

export function bigintForSql(value: bigint): number | string {
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
}

function startsKeyword(sql: string, index: number, keyword: string): boolean {
  return sql.slice(index, index + keyword.length).toUpperCase() === keyword;
}

function readSkipped(sql: string, index: number): Span | null {
  const char = sql[index];
  if (char === "'") return readSingleQuoted(sql, index);
  if (char === '"') return readDoubleQuoted(sql, index);
  if (char === "-" && sql[index + 1] === "-") {
    const end = sql.indexOf("\n", index);
    const next = end === -1 ? sql.length : end;
    return { text: sql.slice(index, next), next };
  }
  if (char === "/" && sql[index + 1] === "*") {
    const end = sql.indexOf("*/", index + 2);
    const next = end === -1 ? sql.length : end + 2;
    return { text: sql.slice(index, next), next };
  }
  if (char === "$") return readDollarQuoted(sql, index);
  return null;
}

function readSingleQuoted(sql: string, start: number): Span {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === "'" && sql[index + 1] === "'") {
      index += 2;
      continue;
    }
    if (sql[index] === "'") return { text: sql.slice(start, index + 1), next: index + 1 };
    index += 1;
  }
  return { text: sql.slice(start), next: sql.length };
}

function readDoubleQuoted(sql: string, start: number): Span {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === '"' && sql[index + 1] === '"') {
      index += 2;
      continue;
    }
    if (sql[index] === '"') return { text: sql.slice(start, index + 1), next: index + 1 };
    index += 1;
  }
  return { text: sql.slice(start), next: sql.length };
}

function readDollarQuoted(sql: string, start: number): Span | null {
  const open = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(start));
  if (!open) return null;
  const end = sql.indexOf(open[0], start + open[0].length);
  const next = end === -1 ? sql.length : end + open[0].length;
  return { text: sql.slice(start, next), next };
}

function readNamedPlaceholder(
  sql: string,
  index: number,
): { token: string; name: string; next: number } | null {
  const sigil = sql[index];
  if (sigil !== "@" && sigil !== ":" && sigil !== "$") return null;
  // `::bigint` is a Postgres cast, not a `:bigint` parameter.
  if (sigil === ":" && (sql[index - 1] === ":" || sql[index + 1] === ":")) return null;
  const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(index + 1));
  if (!name) return null;
  return { token: sigil + name[0], name: name[0], next: index + 1 + name[0].length };
}

const READ_VERBS = new Set(["SELECT", "EXPLAIN", "SHOW", "TABLE", "VALUES"]);

/** True for statements that are safe to run again after a dropped connection. */
export function isIdempotentRead(sql: string): boolean {
  return READ_VERBS.has(leadingSqlVerb(sql));
}

function leadingSqlVerb(sql: string): string {
  let index = 0;
  while (index < sql.length) {
    while (index < sql.length && /\s/.test(sql[index] ?? "")) index += 1;
    if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    break;
  }
  return /^[A-Za-z]+/.exec(sql.slice(index))?.[0]?.toUpperCase() ?? "";
}

const VALUE_KEYWORDS = new Set([
  "AND",
  "AS",
  "ASC",
  "BETWEEN",
  "BY",
  "DESC",
  "ELSE",
  "END",
  "FROM",
  "GROUP",
  "HAVING",
  "IN",
  "IS",
  "LIKE",
  "LIMIT",
  "NOT",
  "OFFSET",
  "ON",
  "OR",
  "ORDER",
  "RETURNING",
  "SELECT",
  "SET",
  "THEN",
  "UNION",
  "VALUES",
  "WHEN",
  "WHERE",
]);

function tokenAt(sql: string, index: number, direction: -1 | 1): string | null {
  let cursor = index;
  while (cursor >= 0 && cursor < sql.length && /\s/.test(sql[cursor] ?? "")) cursor += direction;
  if (cursor < 0 || cursor >= sql.length) return null;
  const char = sql[cursor] ?? "";
  if (!isIdentChar(char)) return char;
  let end = cursor;
  while (
    end + direction >= 0 &&
    end + direction < sql.length &&
    isIdentChar(sql[end + direction])
  ) {
    end += direction;
  }
  const start = direction < 0 ? end : cursor;
  const stop = direction < 0 ? cursor : end;
  return sql.slice(start, stop + 1);
}

/**
 * Postgres jsonb uses `?`, `?|`, and `?&` as operators. A placeholder follows
 * an operator or a value keyword such as LIMIT, and is not itself infix.
 */
function isJsonOperator(sql: string, index: number): boolean {
  const previous = tokenAt(sql, index - 1, -1);
  if (!previous || VALUE_KEYWORDS.has(previous.toUpperCase())) return false;
  const prevIsExpr =
    previous === ")" ||
    previous === "'" ||
    previous === '"' ||
    isIdentChar(previous[previous.length - 1]);
  if (!prevIsExpr) return false;
  if (sql.startsWith("?|", index) || sql.startsWith("?&", index)) return true;

  const next = tokenAt(sql, index + 1, 1);
  if (!next || next === "," || next === ")" || next === ";") return false;
  if (VALUE_KEYWORDS.has(next.toUpperCase())) return false;
  return next === "'" || next === '"' || next === "(" || next === "$" || isIdentChar(next[0]);
}

function isBindObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Date)
  );
}

function lookupNamed(bindings: Record<string, unknown>, name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(bindings, name)) return bindings[name];
  for (const prefix of ["@", ":", "$"]) {
    const key = `${prefix}${name}`;
    if (Object.prototype.hasOwnProperty.call(bindings, key)) return bindings[key];
  }
  throw new Error(`Missing named SQL parameter ${name}`);
}

function findClosingParen(sql: string, openIndex: number): number {
  let depth = 0;
  let index = openIndex;
  while (index < sql.length) {
    const skipped = readSkipped(sql, index);
    if (skipped) {
      index = skipped.next;
      continue;
    }
    if (sql[index] === "(") depth += 1;
    if (sql[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  throw new Error("Unbalanced parentheses in SQL");
}

function splitTopLevelArgs(body: string): string[] {
  const args: string[] = [];
  let current = "";
  let depth = 0;
  let index = 0;
  while (index < body.length) {
    const skipped = readSkipped(body, index);
    if (skipped) {
      current += skipped.text;
      index = skipped.next;
      continue;
    }
    if (body[index] === "(") depth += 1;
    if (body[index] === ")") depth -= 1;
    if (body[index] === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    current += body[index];
    index += 1;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

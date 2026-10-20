// ============================================================
// WA MCP — SQLite SQL adapted for Postgres
// Drizzle still builds SQLite statements. Postgres receives the
// same text with numbered parameters and scalar MAX rewritten.
// ============================================================

function isIdentChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

/**
 * Replaces `?` placeholders outside quotes and comments with `$1`, `$2`, ...
 */
export function replaceSqlitePlaceholders(sql: string): string {
  let out = "";
  let index = 0;
  let param = 1;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'") {
      const literal = readSingleQuoted(sql, index);
      out += literal.text;
      index = literal.next;
      continue;
    }
    if (char === '"') {
      const literal = readDoubleQuoted(sql, index);
      out += literal.text;
      index = literal.next;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index);
      const next = end === -1 ? sql.length : end;
      out += sql.slice(index, next);
      index = next;
      continue;
    }
    if (char === "?") {
      out += `$${param}`;
      param += 1;
      index += 1;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** SQLite scalar max(a, b) is GREATEST on Postgres. Aggregate MAX(x) stays. */
export function replaceScalarMax(sql: string): string {
  let out = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'") {
      const literal = readSingleQuoted(sql, index);
      out += literal.text;
      index = literal.next;
      continue;
    }
    if (char === '"') {
      const literal = readDoubleQuoted(sql, index);
      out += literal.text;
      index = literal.next;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index);
      const next = end === -1 ? sql.length : end;
      out += sql.slice(index, next);
      index = next;
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

    out += char;
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
    const char = sql[index];
    if (char === "'") {
      const literal = readSingleQuoted(sql, index);
      out += literal.text;
      index = literal.next;
      continue;
    }
    if (char === '"') {
      const literal = readDoubleQuoted(sql, index);
      out += literal.text;
      index = literal.next;
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
    out += char;
    index += 1;
  }
  return out;
}

export function toPostgresQuery(sql: string): string {
  return replaceSqliteRowid(
    stripOnConflictQualifiers(replaceScalarMax(replaceSqlitePlaceholders(sql))),
  );
}

/** SQLite INTEGER is 64-bit. Postgres INTEGER is int4, so DDL uses BIGINT. */
export function sqliteDdlToPostgres(sql: string): string {
  let out = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'") {
      const literal = readSingleQuoted(sql, index);
      out += literal.text;
      index = literal.next;
      continue;
    }
    if (char === '"') {
      const literal = readDoubleQuoted(sql, index);
      out += literal.text;
      index = literal.next;
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
    out += char;
    index += 1;
  }
  return out;
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'") {
      const literal = readSingleQuoted(sql, index);
      current += literal.text;
      index = literal.next;
      continue;
    }
    if (char === '"') {
      const literal = readDoubleQuoted(sql, index);
      current += literal.text;
      index = literal.next;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index);
      const next = end === -1 ? sql.length : end;
      current += sql.slice(index, next);
      index = next;
      continue;
    }
    if (char === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      index += 1;
      continue;
    }
    current += char;
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

function startsKeyword(sql: string, index: number, keyword: string): boolean {
  return sql.slice(index, index + keyword.length).toUpperCase() === keyword;
}

function readSingleQuoted(sql: string, start: number): { text: string; next: number } {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === "'" && sql[index + 1] === "'") {
      index += 2;
      continue;
    }
    if (sql[index] === "'") {
      return { text: sql.slice(start, index + 1), next: index + 1 };
    }
    index += 1;
  }
  return { text: sql.slice(start), next: sql.length };
}

function readDoubleQuoted(sql: string, start: number): { text: string; next: number } {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === '"' && sql[index + 1] === '"') {
      index += 2;
      continue;
    }
    if (sql[index] === '"') {
      return { text: sql.slice(start, index + 1), next: index + 1 };
    }
    index += 1;
  }
  return { text: sql.slice(start), next: sql.length };
}

function findClosingParen(sql: string, openIndex: number): number {
  let depth = 0;
  let index = openIndex;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'") {
      index = readSingleQuoted(sql, index).next;
      continue;
    }
    if (char === '"') {
      index = readDoubleQuoted(sql, index).next;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
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
    const char = body[index];
    if (char === "'") {
      const literal = readSingleQuoted(body, index);
      current += literal.text;
      index = literal.next;
      continue;
    }
    if (char === '"') {
      const literal = readDoubleQuoted(body, index);
      current += literal.text;
      index = literal.next;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

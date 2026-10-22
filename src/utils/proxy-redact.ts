// ============================================================
// WA MCP — Proxy credential redaction
// Removes userinfo from proxy URLs before it reaches logs,
// tool errors, or GET /health. Host and port stay visible.
// ============================================================

export const PROXY_URL_ENV = "WA_PROXY_URL";

function redactProxyUserinfo(text: string): string {
  return text.replace(
    /\b((?:socks5h?|https?)):\/\/(?:[^\s/?#@:]+)(?::[^\s/?#@]*)?@/gi,
    "$1://***:***@",
  );
}

function addVariant(
  variants: Map<string, string>,
  value: string | undefined,
  replacement: string,
): void {
  if (!value || value.length < 3 || value === replacement) return;
  variants.set(value, replacement);
  const escaped = JSON.stringify(value).slice(1, -1);
  if (escaped !== value && escaped.length >= 3) variants.set(escaped, replacement);
}

const BARE_SECRET_MIN_LENGTH = 4;
const BARE_SECRET_SUBSTRING_LENGTH = 8;

interface RedactionPlan {
  substrings: Array<[string, string]>;
  tokens: string[];
}

const variantCache = new Map<string, RedactionPlan>();

function addBareSecret(substrings: Map<string, string>, tokens: Set<string>, value: string): void {
  // Shorter credentials stay visible unless they are inside a proxy URL or a user:password pair.
  // 4 to 7 characters match as whole tokens. 8 or more are removed even inside a longer token.
  if (value.length < BARE_SECRET_MIN_LENGTH) return;
  const forms = new Set<string>([value]);
  const escaped = JSON.stringify(value).slice(1, -1);
  if (escaped !== value && escaped.length >= BARE_SECRET_MIN_LENGTH) forms.add(escaped);
  for (const form of forms) {
    if (form.length >= BARE_SECRET_SUBSTRING_LENGTH) substrings.set(form, "***");
    else tokens.add(form);
  }
}

function secretVariants(proxyUrl: string): RedactionPlan {
  const substrings = new Map<string, string>();
  const tokens = new Set<string>();
  const redacted = redactProxyUrl(proxyUrl);
  addVariant(substrings, proxyUrl, redacted);
  addVariant(substrings, proxyUrl.endsWith("/") ? proxyUrl.slice(0, -1) : `${proxyUrl}/`, redacted);

  try {
    const url = new URL(proxyUrl);
    const encodedUser = url.username;
    const encodedPass = url.password;
    const decodedUser = decodeURIComponent(encodedUser);
    const decodedPass = decodeURIComponent(encodedPass);
    if (encodedPass || decodedPass) {
      addVariant(substrings, `${encodedUser}:${encodedPass}`, "***:***");
      addVariant(substrings, `${decodedUser}:${decodedPass}`, "***:***");
    }
    addBareSecret(substrings, tokens, encodedUser);
    addBareSecret(substrings, tokens, decodedUser);
    addBareSecret(substrings, tokens, encodedPass);
    addBareSecret(substrings, tokens, decodedPass);
  } catch {
    // The URL regex above still covers well-formed proxy URLs.
  }

  return {
    substrings: [...substrings.entries()].sort((left, right) => right[0].length - left[0].length),
    tokens: [...tokens].sort((left, right) => right.length - left.length),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactWholeTokens(text: string, tokens: string[]): string {
  let result = text;
  for (const token of tokens) {
    const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(token)}(?![A-Za-z0-9])`, "g");
    result = result.replace(pattern, "***");
  }
  return result;
}

/** Proxy URL safe to log. Unparseable values are replaced entirely. */
export function redactProxyUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.host) return "<unparseable-proxy-url>";
    if (url.username || url.password) return `${url.protocol}//***:***@${url.host}`;
    return `${url.protocol}//${url.host}`;
  } catch {
    return "<unparseable-proxy-url>";
  }
}

/**
 * Redact proxy userinfo inside free text. `proxyUrl` adds the configured
 * credential pair so a password that leaked outside a URL is removed too.
 */
export function redactProxyCredentials(text: string, proxyUrl?: string): string {
  const redacted = redactProxyUserinfo(text);
  if (!proxyUrl) return redacted;
  let plan = variantCache.get(proxyUrl);
  if (!plan) {
    plan = secretVariants(proxyUrl);
    if (variantCache.size > 8) variantCache.clear();
    variantCache.set(proxyUrl, plan);
  }
  let result = redacted;
  for (const [secret, replacement] of plan.substrings) {
    result = result.split(secret).join(replacement);
  }
  return redactWholeTokens(result, plan.tokens);
}

export function redactError(error: unknown, proxyUrl?: string, seen = new Set<unknown>()): Error {
  if (seen.has(error)) return new Error("Circular error");
  const message = error instanceof Error ? error.message : String(error);
  const redacted = new Error(redactProxyCredentials(message, proxyUrl));
  redacted.name = error instanceof Error ? error.name : "Error";
  if (!(error instanceof Error)) return redacted;
  seen.add(error);
  if (error.stack) redacted.stack = redactProxyCredentials(error.stack, proxyUrl);
  if (error.cause !== undefined) {
    redacted.cause =
      error.cause instanceof Error
        ? redactError(error.cause, proxyUrl, seen)
        : redactProxyCredentials(String(error.cause), proxyUrl);
  }
  return redacted;
}

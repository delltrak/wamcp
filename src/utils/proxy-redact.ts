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

const variantCache = new Map<string, Array<[string, string]>>();

function secretVariants(proxyUrl: string): Array<[string, string]> {
  const variants = new Map<string, string>();
  const redacted = redactProxyUrl(proxyUrl);
  addVariant(variants, proxyUrl, redacted);
  addVariant(variants, proxyUrl.endsWith("/") ? proxyUrl.slice(0, -1) : `${proxyUrl}/`, redacted);

  try {
    const url = new URL(proxyUrl);
    if (url.password) {
      const encodedPair = `${url.username}:${url.password}`;
      const decodedPair = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
      addVariant(variants, encodedPair, "***:***");
      addVariant(variants, decodedPair, "***:***");
    }
  } catch {
    // The URL regex above still covers well-formed proxy URLs.
  }

  return [...variants.entries()].sort((left, right) => right[0].length - left[0].length);
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
  let variants = variantCache.get(proxyUrl);
  if (!variants) {
    variants = secretVariants(proxyUrl);
    if (variantCache.size > 8) variantCache.clear();
    variantCache.set(proxyUrl, variants);
  }
  let result = redacted;
  for (const [secret, replacement] of variants) {
    result = result.split(secret).join(replacement);
  }
  return result;
}

export function redactError(error: unknown, proxyUrl?: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = new Error(redactProxyCredentials(message, proxyUrl));
  redacted.name = error instanceof Error ? error.name : "Error";
  if (error instanceof Error && error.stack) {
    redacted.stack = redactProxyCredentials(error.stack, proxyUrl);
  }
  return redacted;
}

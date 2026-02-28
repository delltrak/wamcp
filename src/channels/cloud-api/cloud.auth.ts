// ============================================================
// WA MCP — Cloud API Authentication
// Token validation and webhook signature verification.
// ============================================================

import { createHmac, timingSafeEqual } from "node:crypto";
import pino from "pino";

const logger = pino({ name: "cloud-api-auth" });

const GRAPH_API_BASE = "https://graph.facebook.com/v21.0";

/**
 * Validate a Cloud API access token by making a test API call.
 * Returns true if the token is valid for the given phone number ID.
 */
export async function validateToken(
  accessToken: string,
  phoneNumberId: string,
): Promise<boolean> {
  try {
    const url = `${GRAPH_API_BASE}/${phoneNumberId}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return response.ok;
  } catch (err) {
    logger.error({ err, phoneNumberId }, "Token validation failed");
    return false;
  }
}

/**
 * Build authorization headers for Cloud API requests.
 */
export function getAuthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

/**
 * Verify a Meta webhook signature using HMAC SHA-256.
 * The signature is in the x-hub-signature-256 header as "sha256=<hex>".
 */
export function verifyWebhookSignature(
  body: string | Buffer,
  signature: string | undefined,
  appSecret: string,
): boolean {
  if (!signature) {
    logger.warn("Missing webhook signature header");
    return false;
  }

  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) {
    logger.warn("Invalid signature format");
    return false;
  }

  const signatureHash = signature.slice(prefix.length);
  const expectedHash = createHmac("sha256", appSecret)
    .update(body)
    .digest("hex");

  try {
    return timingSafeEqual(
      Buffer.from(signatureHash, "hex"),
      Buffer.from(expectedHash, "hex"),
    );
  } catch {
    // Lengths might not match if signature is malformed
    return false;
  }
}

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { OtpOptionsSchema } from "../schemas/otp.schema.js";
import type { OtpOptions } from "../types/channel.types.js";

export interface OtpEnvelope {
  iv: string;
  tag: string;
  ciphertext: string;
}
export function otpEncryptionKey(): Buffer {
  const value = process.env.WA_OTP_ENCRYPTION_KEY ?? "";
  if (!/^[a-fA-F0-9]{64}$/.test(value))
    throw new Error(
      "OTP queue encryption is not configured. Set WA_OTP_ENCRYPTION_KEY to 64 hex characters.",
    );
  return Buffer.from(value, "hex");
}
export function normalizeOtpRecipient(to: string): string {
  if (!/^\+?[1-9][0-9]{6,14}(?:@s\.whatsapp\.net)?$/.test(to))
    throw new Error("Invalid OTP recipient; use an individual phone number, not a group or LID.");
  return to.replace(/^\+/, "").replace(/@s\.whatsapp\.net$/, "");
}
export function otpBinding(
  instanceId: string,
  to: string,
  options: OtpOptions,
  key: Buffer,
): string {
  return createHmac("sha256", key)
    .update(
      JSON.stringify([instanceId, to, options.templateName, options.languageCode, options.otpCode]),
    )
    .digest("hex");
}
export function sealOtp(options: OtpOptions, context: string, key: Buffer): OtpEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(options), "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}
export function openOtp(envelope: OtpEnvelope, context: string, key: Buffer): OtpOptions {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const raw = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    return OtpOptionsSchema.parse(JSON.parse(raw.toString("utf8")));
  } catch {
    throw new Error(
      "OTP queue payload could not be authenticated. Do not retry an uncertain send.",
    );
  }
}
export const otpContext = (instanceId: string, to: string, expiresAt: number) =>
  JSON.stringify([instanceId, to, expiresAt]);

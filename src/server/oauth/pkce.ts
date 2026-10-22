import { createHash, timingSafeEqual } from "node:crypto";

export function validPkceChallenge(challenge: string): boolean {
  if (challenge.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(challenge)) return false;
  return Buffer.from(challenge, "base64url").length === 32;
}

export function validPkceVerifier(verifier: string): boolean {
  return verifier.length >= 43 && verifier.length <= 128 && /^[A-Za-z0-9._~-]+$/.test(verifier);
}

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!validPkceVerifier(verifier) || !validPkceChallenge(challenge)) return false;
  const actual = createHash("sha256").update(verifier).digest("base64url");
  return timingSafeEqual(
    createHash("sha256").update(actual).digest(),
    createHash("sha256").update(challenge).digest(),
  );
}

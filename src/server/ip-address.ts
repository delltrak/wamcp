import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

export interface TrustedProxy {
  matches(address: string): boolean;
}

interface Cidr {
  family: 4 | 6;
  bytes: Buffer;
  prefix: number;
}

/** Map IPv4-mapped IPv6 to IPv4 and group other IPv6 addresses by /64. */
export function normalizeClientIp(address: string): string {
  const bare = stripIpDecorations(address);
  if (!bare || bare.length > 128) return "unknown";
  if (isIP(bare) === 4) return bare;
  const bytes = ipv6Bytes(bare);
  if (!bytes) return bare.length > 128 ? "unknown" : bare;
  const mapped = ipv4FromMapped(bytes);
  if (mapped) return mapped;
  return `v6:${bytes.subarray(0, 8).toString("hex")}`;
}

export function parseTrustProxy(raw: string | undefined): TrustedProxy | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const cidrs: Cidr[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parsed = parseCidr(trimmed);
    if (!parsed) {
      throw new Error("Invalid WA_TRUST_PROXY; expected comma-separated CIDR blocks");
    }
    cidrs.push(parsed);
  }
  if (cidrs.length === 0) return undefined;
  return {
    matches(address: string): boolean {
      const bare = stripIpDecorations(address);
      if (isIP(bare) === 4) {
        const bytes = ipv4Bytes(bare);
        return bytes !== undefined && cidrs.some((cidr) => contains(cidr, 4, bytes));
      }
      const bytes = ipv6Bytes(bare);
      if (!bytes) return false;
      const mapped = ipv4FromMapped(bytes);
      if (mapped) {
        const v4 = ipv4Bytes(mapped);
        return v4 !== undefined && cidrs.some((cidr) => contains(cidr, 4, v4));
      }
      return cidrs.some((cidr) => contains(cidr, 6, bytes));
    },
  };
}

/**
 * Client address for rate limits. Forwarded headers are ignored unless the
 * socket peer belongs to `trust`.
 */
export function clientAddress(req: IncomingMessage, trust?: TrustedProxy): string {
  const peer = socketAddress(req);
  if (!trust || !trust.matches(peer)) return normalizeClientIp(peer);
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded !== "string") return normalizeClientIp(peer);
  const hops = forwarded
    .split(",")
    .map((hop) => stripIpDecorations(hop))
    .filter(Boolean);
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = hops[index]!;
    if (!trust.matches(hop)) return normalizeClientIp(hop);
  }
  return normalizeClientIp(peer);
}

function socketAddress(req: IncomingMessage): string {
  const address = req.socket?.remoteAddress;
  if (!address || address.length > 128) return "unknown";
  return address;
}

function stripIpDecorations(value: string): string {
  let bare = value.trim();
  if (bare.startsWith("[") && bare.includes("]")) bare = bare.slice(1, bare.indexOf("]"));
  const zone = bare.indexOf("%");
  if (zone !== -1) bare = bare.slice(0, zone);
  return bare;
}

function parseCidr(entry: string): Cidr | undefined {
  const slash = entry.lastIndexOf("/");
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const prefixText = slash === -1 ? undefined : entry.slice(slash + 1);
  const family = isIP(address);
  if (family !== 4 && family !== 6) return undefined;
  const prefix = prefixText === undefined ? (family === 4 ? 32 : 128) : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
    return undefined;
  }
  const bytes = family === 4 ? ipv4Bytes(address) : ipv6Bytes(address);
  if (!bytes) return undefined;
  return { family, bytes, prefix };
}

function contains(cidr: Cidr, family: 4 | 6, bytes: Buffer): boolean {
  if (cidr.family !== family || cidr.bytes.length !== bytes.length) return false;
  const whole = Math.floor(cidr.prefix / 8);
  const remainder = cidr.prefix % 8;
  for (let index = 0; index < whole; index += 1) {
    if (cidr.bytes[index] !== bytes[index]) return false;
  }
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (cidr.bytes[whole]! & mask) === (bytes[whole]! & mask);
}

function ipv4Bytes(address: string): Buffer | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = Buffer.alloc(4);
  for (let index = 0; index < 4; index += 1) {
    if (!/^\d{1,3}$/.test(parts[index]!)) return undefined;
    const value = Number(parts[index]);
    if (value > 255) return undefined;
    bytes[index] = value;
  }
  return bytes;
}

function ipv6Bytes(address: string): Buffer | undefined {
  const lower = address.toLowerCase();
  if (!lower.includes(".")) return expandGroups(lower, 8);
  const lastColon = lower.lastIndexOf(":");
  if (lastColon <= 0) return undefined;
  const v4 = ipv4Bytes(lower.slice(lastColon + 1));
  if (!v4) return undefined;
  const head = lower.slice(0, lastColon);
  const prefix = expandGroups(head === "" ? "::" : head, 6);
  if (!prefix) return undefined;
  const bytes = Buffer.alloc(16);
  prefix.copy(bytes, 0);
  v4.copy(bytes, 12);
  return bytes;
}

function expandGroups(address: string, groupCount: number): Buffer | undefined {
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  if (halves.length === 1 && left.length !== groupCount) return undefined;
  const missing = groupCount - left.length - right.length;
  if (missing < 0) return undefined;
  const groups = [...left, ...new Array<string>(missing).fill("0"), ...right];
  if (groups.length !== groupCount) return undefined;
  const bytes = Buffer.alloc(groupCount * 2);
  for (let index = 0; index < groupCount; index += 1) {
    const group = groups[index]!;
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2);
  }
  return bytes;
}

function ipv4FromMapped(bytes: Buffer): string | undefined {
  for (let index = 0; index < 10; index += 1) {
    if (bytes[index] !== 0) return undefined;
  }
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return undefined;
  return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
}

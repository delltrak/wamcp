import type { OtpEnvelope } from "./otp.js";

export type OtpRedisClient =
  | {
      eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
    }
  | {
      defineCommand(name: string, definition: { numberOfKeys: number; lua: string }): void;
      runCommand(name: string, args: (string | number)[]): Promise<unknown>;
    };
const defined = new WeakMap<object, Set<string>>();
async function execute(
  client: OtpRedisClient,
  name: string,
  lua: string,
  keys: number,
  args: (string | number)[],
): Promise<unknown> {
  if ("eval" in client) return client.eval(lua, keys, ...args);
  let commands = defined.get(client);
  if (!commands) {
    commands = new Set();
    defined.set(client, commands);
  }
  if (!commands.has(name)) {
    client.defineCommand(name, { numberOfKeys: keys, lua });
    commands.add(name);
  }
  return client.runCommand(name, args);
}

const RESERVE = `
local current = redis.call('GET', KEYS[1])
if current then
  local stored = cjson.decode(current)
  if stored.binding ~= ARGV[1] then return {-1, 0} end
  return {0, stored.expiresAt}
end
redis.call('SET', KEYS[1], cjson.encode({binding=ARGV[1], expiresAt=tonumber(ARGV[2]), consumed=false}), 'PX', 86400000)
return {1, tonumber(ARGV[2])}
`;

const CONSUME = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
local raw = redis.call('HGET', KEYS[1], 'data')
local record = redis.call('GET', KEYS[3])
if not raw or not record then return 0 end
local data = cjson.decode(raw)
local reservation = cjson.decode(record)
local time = redis.call('TIME')
local now = tonumber(time[1])*1000 + math.floor(tonumber(time[2])/1000)
if reservation.consumed or reservation.binding ~= ARGV[5] or data.binding ~= ARGV[5] then return 0 end
if data.kind ~= 'otp' or not data.envelope or data.expiresAt ~= reservation.expiresAt or now >= data.expiresAt then return 0 end
if data.envelope.iv ~= ARGV[2] or data.envelope.tag ~= ARGV[3] or data.envelope.ciphertext ~= ARGV[4] then return 0 end
data.envelope = nil
reservation.consumed = true
redis.call('HSET', KEYS[1], 'data', cjson.encode(data))
redis.call('SET', KEYS[3], cjson.encode(reservation), 'KEEPTTL')
return 1
`;

/** Separate TTL-bound reservation; ordinary BullMQ completed-job cleanup cannot delete it. */
export async function reserveOtpRequest(
  client: OtpRedisClient,
  key: string,
  binding: string,
  expiresAt: number,
): Promise<{ created: boolean; expiresAt: number }> {
  const response = (await execute(client, "wamcpOtpReserveV1", RESERVE, 1, [
    key,
    binding,
    expiresAt,
  ])) as [number, number];
  if (response[0] === -1) throw new Error("OTP requestId is already bound to another payload.");
  return { created: response[0] === 1, expiresAt: Number(response[1]) };
}

/** Atomically check BullMQ lock ownership, consume the reservation and remove its ciphertext. */
export async function consumeOtpEnvelope(
  client: OtpRedisClient,
  jobKey: string,
  requestKey: string,
  token: string | undefined,
  envelope: OtpEnvelope,
  binding: string,
): Promise<boolean> {
  if (!token) return false;
  return (
    (await execute(client, "wamcpOtpConsumeV1", CONSUME, 3, [
      jobKey,
      jobKey + ":lock",
      requestKey,
      token,
      envelope.iv,
      envelope.tag,
      envelope.ciphertext,
      binding,
    ])) === 1
  );
}

import { kvEnabled, redis } from "./kv.js";
import { defer } from "./defer.js";

// 聚合統計：只有計數器，不記 IP、不設 cookie、不關聯個人結果。
// 按日 hash（stats:d:YYYY-MM-DD，90 天過期）＋累計 hash（stats:total）。
const DAY_TTL_SECONDS = 90 * 86400;

function today(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" }); // YYYY-MM-DD
}

async function bumpNow(fields) {
  const dayKey = `stats:d:${today()}`;
  for (const field of fields) {
    await redis(["HINCRBY", dayKey, field, "1"]);
    await redis(["HINCRBY", "stats:total", field, "1"]);
  }
  await redis(["EXPIRE", dayKey, String(DAY_TTL_SECONDS)]);
}

// fire-and-forget：統計失敗絕不影響主流程
export function track(...fields) {
  const clean = fields.filter((f) => typeof f === "string" && f.length > 0);
  if (!kvEnabled || clean.length === 0) return;
  defer(bumpNow(clean));
}

export function latencyBucket(prefix, ms) {
  const bucket = ms < 1000 ? "lt1s" : ms < 5000 ? "1to5s" : ms < 20000 ? "5to20s" : "gt20s";
  return `${prefix}:${bucket}`;
}

function toObject(flat) {
  const obj = {};
  if (Array.isArray(flat)) {
    for (let i = 0; i + 1 < flat.length; i += 2) obj[flat[i]] = Number(flat[i + 1]);
  } else if (flat && typeof flat === "object") {
    for (const [k, v] of Object.entries(flat)) obj[k] = Number(v);
  }
  return obj;
}

export async function readStats() {
  const [t, y, total] = await Promise.all([
    redis(["HGETALL", `stats:d:${today()}`]),
    redis(["HGETALL", `stats:d:${today(-1)}`]),
    redis(["HGETALL", "stats:total"]),
  ]);
  return {
    today: toObject(t),
    yesterday: toObject(y),
    total: toObject(total),
    generatedAt: new Date().toISOString(),
  };
}

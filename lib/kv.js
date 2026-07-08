// Upstash Redis REST 低階呼叫（純 fetch 零依賴），pool 與 stats 共用
import "./config.js"; // 確保 .env 已載入（不依賴呼叫端的 import 順序）

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

export const kvEnabled = Boolean(KV_URL && KV_TOKEN);

export async function redis(command) {
  const res = await fetch(KV_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify(command),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`KV 錯誤：${data.error || res.status}`);
  }
  return data.result;
}

import { generateQuestion } from "./quiz.js";

// 題目池：Upstash Redis（REST API，純 fetch 零依賴）
// 未設定 KV 時 kvEnabled=false，出題自動退回現場生成
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const POOL_KEY = "quiz:pool:v1";

export const POOL_TARGET = Number(process.env.POOL_TARGET || 40);
export const kvEnabled = Boolean(KV_URL && KV_TOKEN);

async function redis(command) {
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

export async function poolSize() {
  return Number(await redis(["LLEN", POOL_KEY])) || 0;
}

// 一次撈一小批，優先挑「主題未用過且題目文字不重複」的一題，其餘放回池尾
export async function drawFromPool({ usedThemes, prevQuestions }) {
  const raw = await redis(["LPOP", POOL_KEY, "10"]);
  if (!raw || raw.length === 0) return null;

  const items = [];
  for (const s of raw) {
    try {
      items.push(JSON.parse(s));
    } catch {}
  }

  const notDup = (it) => !prevQuestions.includes(it.question);
  const pick =
    items.find((it) => notDup(it) && !usedThemes.includes(it.theme)) ||
    items.find(notDup) ||
    null;

  const leftovers = items.filter((it) => it !== pick).map((it) => JSON.stringify(it));
  if (leftovers.length > 0) await redis(["RPUSH", POOL_KEY, ...leftovers]);
  return pick;
}

async function pushToPool(item) {
  await redis(["RPUSH", POOL_KEY, JSON.stringify(item)]);
}

// 取池內現有題目摘要，生成新題時作為去重提示
async function poolSummaries(limit = 12) {
  const raw = (await redis(["LRANGE", POOL_KEY, "0", String(limit - 1)])) || [];
  return raw
    .map((s) => {
      try {
        const it = JSON.parse(s);
        return { theme: it.theme, question: it.question };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// 池子低於目標時補題；maxCount 限制單次呼叫的生成量（配合 serverless 時限）
export async function refillPool(maxCount = 1, target = POOL_TARGET) {
  if (!kvEnabled) return { pool: 0, added: 0 };
  const before = await poolSize();
  const need = Math.max(0, target - before);
  const batch = Math.min(maxCount, need);

  let added = 0;
  for (let i = 0; i < batch; i++) {
    const prev = await poolSummaries();
    const q = await generateQuestion({ index: null, prev });
    await pushToPool({ theme: q.theme, question: q.question, options: q.options });
    added++;
  }
  return { pool: before + added, added, target: POOL_TARGET };
}

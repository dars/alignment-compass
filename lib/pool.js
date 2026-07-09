import crypto from "node:crypto";
import { generateQuestion } from "./quiz.js";
import { kvEnabled, redis } from "./kv.js";

// 題目池：未設定 KV 時 kvEnabled=false，出題自動退回現場生成
// v2：改為 server 指定每題四個陣營（兩軸皆有正負向）後重建，v1 舊題不再使用
const POOL_KEY = "quiz:pool:v2";

export const POOL_TARGET = Number(process.env.POOL_TARGET || 40);
// 每題可被使用的次數，用滿即棄置換新題（1 = 用過即棄）
const POOL_MAX_USES = Number(process.env.POOL_MAX_USES || 3);
// 開場所需的緩衝題數：玩家答一題（10~20 秒）與生成一題（~20 秒）速度相近，
// 有這些緩衝加上背景補池即可一路順跑，不必等池滿
export const POOL_READY = Math.min(Number(process.env.POOL_READY || 6), POOL_TARGET);

export { kvEnabled };

export async function poolSize() {
  return Number(await redis(["LLEN", POOL_KEY])) || 0;
}

// 分批往池子深處掃（每批 10 題、最多 4 批），挑一題出給玩家：
// - 排除此裝置看過的題（seenIds）與本場已出的題目文字
// - 優先挑主題未用過的
// - 被選中的題累計使用次數，未滿 POOL_MAX_USES 放回池尾輪替，用滿即棄
// - 整批都不合格時放回池尾、繼續掃下一批（重度玩家不會因池頭全看過而退回現場生成）
export async function drawFromPool({ usedThemes, prevQuestions, seenIds = [] }) {
  const seen = new Set(seenIds);
  const MAX_BATCHES = 4;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const raw = await redis(["LPOP", POOL_KEY, "10"]);
    if (!raw || raw.length === 0) return null;

    const items = [];
    for (const s of raw) {
      try {
        items.push(JSON.parse(s));
      } catch {}
    }
    // 舊格式相容：補上 id 與使用次數
    for (const it of items) {
      if (!it.id) it.id = crypto.randomUUID();
      if (!Number.isInteger(it.uses)) it.uses = 0;
    }

    const candidates = items.filter(
      (it) => !seen.has(it.id) && !prevQuestions.includes(it.question)
    );
    const pick =
      candidates.find((it) => !usedThemes.includes(it.theme)) || candidates[0] || null;

    const putBack = [];
    for (const it of items) {
      if (it === pick) {
        it.uses += 1;
        if (it.uses < POOL_MAX_USES) putBack.push(it);
        // 用滿 → 不放回，池子縮水，後續補池會生新題補位
      } else {
        putBack.push(it);
      }
    }
    if (putBack.length > 0) {
      await redis(["RPUSH", POOL_KEY, ...putBack.map((it) => JSON.stringify(it))]);
    }
    if (pick) return pick;
    // 這批全不合格，已放回池尾；下一輪 LPOP 會撈到更深處的題
  }
  return null;
}

async function pushToPool(item) {
  await redis(["RPUSH", POOL_KEY, JSON.stringify(item)]);
}

// 取池內現有題目摘要，生成新題時作為去重提示與陣營覆蓋平衡依據
async function poolSummaries(limit = 12) {
  const raw = (await redis(["LRANGE", POOL_KEY, "0", String(limit - 1)])) || [];
  return raw
    .map((s) => {
      try {
        const it = JSON.parse(s);
        return {
          theme: it.theme,
          question: it.question,
          alignments: (it.options || []).map((o) => o.alignment),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const LOCK_KEY = "quiz:pool:refill-lock";

// 全域補池鎖：避免大量玩家同時觸發背景補池、塞爆 Ollama 佇列
// （生成中若程序死亡，鎖 90 秒後自動過期）
async function acquireLock() {
  return (await redis(["SET", LOCK_KEY, "1", "NX", "EX", "90"])) === "OK";
}

async function releaseLock() {
  await redis(["DEL", LOCK_KEY]).catch(() => {});
}

// 池子低於目標時補題；maxCount 限制單次呼叫的生成量（配合 serverless 時限）
export async function refillPool(maxCount = 1, target = POOL_TARGET) {
  if (!kvEnabled) return { pool: 0, added: 0 };
  const before = await poolSize();
  const need = Math.max(0, target - before);
  const batch = Math.min(maxCount, need);
  if (batch === 0) return { pool: before, added: 0, target };

  if (!(await acquireLock())) {
    return { pool: before, added: 0, target, locked: true };
  }
  let added = 0;
  try {
    for (let i = 0; i < batch; i++) {
      const prev = await poolSummaries();
      const q = await generateQuestion({ index: null, prev });
      await pushToPool({
        id: crypto.randomUUID(),
        uses: 0,
        theme: q.theme,
        question: q.question,
        options: q.options,
      });
      added++;
      if (i + 1 < batch) await redis(["EXPIRE", LOCK_KEY, "90"]); // 續鎖
    }
  } finally {
    await releaseLock();
  }
  return { pool: before + added, added, target };
}

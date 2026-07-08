// 一次性灌題腳本：node scripts/seed-pool.mjs [目標題數]
// 需要 .env（或環境變數）提供 OLLAMA_URL 與 KV_REST_API_URL / KV_REST_API_TOKEN
import { kvEnabled, poolSize, refillPool, POOL_TARGET } from "../lib/pool.js";

const target = Number(process.argv[2] || POOL_TARGET);

if (!kvEnabled) {
  console.error("錯誤：未設定 KV_REST_API_URL / KV_REST_API_TOKEN（可放在 .env）");
  process.exit(1);
}

let size = await poolSize();
console.log(`目前池內 ${size} 題，目標 ${target} 題`);

while (size < target) {
  const started = Date.now();
  try {
    const r = await refillPool(1, target);
    if (r.added === 0) break;
    size = r.pool;
    console.log(`+1 題（${((Date.now() - started) / 1000).toFixed(1)}s）→ 池內 ${size}/${target}`);
  } catch (err) {
    console.error(`生成失敗（${err.message}），3 秒後重試…`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

console.log(`完成，池內共 ${size} 題`);

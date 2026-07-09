import { kvEnabled, poolSize, refillPool, POOL_READY } from "../lib/pool.js";
import { defer } from "../lib/defer.js";
import { sendJson, handleError, HttpError } from "../lib/http.js";

// 開場前的題目池狀態：前端據此決定是否顯示「DM 正在整理桌面」等待畫面。
// ready 只是軟訊號（多人同時進場仍可能抽乾池子），最後防線是逐題現場生成。
export default async function handler(req, res) {
  try {
    if (req.method !== "GET") throw new HttpError(405, "Method not allowed");

    // 未設定 KV：無池可等，直接放行走現場生成
    if (!kvEnabled) return sendJson(res, 200, { ready: true, pool: 0, need: 0 });

    const pool = await poolSize();
    const ready = pool >= POOL_READY;
    sendJson(res, 200, { ready, pool: Math.min(pool, POOL_READY), need: POOL_READY });

    // 玩家在等待畫面輪詢時主動補池；全域鎖保證同時最多一個生成中
    if (!ready) defer(refillPool(1));
  } catch (err) {
    handleError(res, err);
  }
}

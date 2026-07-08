import crypto from "node:crypto";
import { kvEnabled, refillPool, poolSize, POOL_TARGET } from "../lib/pool.js";
import { sendJson, handleError, HttpError } from "../lib/http.js";

// 手動／排程補池端點：POST /api/refill?key=REFILL_KEY
// 單次最多生成 2 題（每題 ~20 秒，配合 Vercel 60 秒函式時限）
const REFILL_KEY = process.env.REFILL_KEY || "";

function keyMatches(provided) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(REFILL_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    if (!kvEnabled) throw new HttpError(503, "未設定題目池（KV_REST_API_URL / KV_REST_API_TOKEN）");
    if (!REFILL_KEY) throw new HttpError(503, "未設定 REFILL_KEY，端點停用");

    const url = new URL(req.url, "http://localhost");
    const provided = req.headers["x-refill-key"] || url.searchParams.get("key") || "";
    if (!keyMatches(provided)) throw new HttpError(403, "驗證失敗");

    const result = await refillPool(2);
    if (result.added === 0) {
      return sendJson(res, 200, { pool: await poolSize(), added: 0, target: POOL_TARGET });
    }
    sendJson(res, 200, result);
  } catch (err) {
    handleError(res, err);
  }
}

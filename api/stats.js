import crypto from "node:crypto";
import { kvEnabled } from "../lib/kv.js";
import { readStats } from "../lib/stats.js";
import { sendJson, handleError, HttpError } from "../lib/http.js";

// 聚合統計查詢：GET /api/stats?key=STATS_KEY（未設定時沿用 REFILL_KEY）
const STATS_KEY = process.env.STATS_KEY || process.env.REFILL_KEY || "";

function keyMatches(provided) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(STATS_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
    if (!kvEnabled) throw new HttpError(503, "未設定 KV，統計停用");
    if (!STATS_KEY) throw new HttpError(503, "未設定 STATS_KEY / REFILL_KEY，端點停用");

    const url = new URL(req.url, "http://localhost");
    const provided = req.headers["x-stats-key"] || url.searchParams.get("key") || "";
    if (!keyMatches(provided)) throw new HttpError(403, "驗證失敗");

    sendJson(res, 200, await readStats());
  } catch (err) {
    handleError(res, err);
  }
}

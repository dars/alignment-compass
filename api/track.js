import { track } from "../lib/stats.js";
import { readJson, sendJson, handleError, HttpError } from "../lib/http.js";

// 前端事件回報（僅收伺服器看不到的事件）；白名單制，不收任何自由文字
const ALLOWED_EVENTS = new Set(["copy_result"]);

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const body = await readJson(req);
    if (ALLOWED_EVENTS.has(body?.event)) track(body.event);
    sendJson(res, 200, { ok: true }); // 不透露事件是否被採納
  } catch (err) {
    handleError(res, err);
  }
}

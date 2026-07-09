import { generateQuestion, QUESTION_COUNT, MAX_QUESTIONS } from "../lib/quiz.js";
import { kvEnabled, drawFromPool, refillPool } from "../lib/pool.js";
import { defer } from "../lib/defer.js";
import { track, latencyBucket } from "../lib/stats.js";
import { seal, unseal } from "../lib/token.js";
import { readJson, sendJson, handleError, HttpError } from "../lib/http.js";

export default async function handler(req, res) {
  const startedAt = Date.now();
  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const body = await readJson(req);

    const prevTokens = Array.isArray(body.prev) ? body.prev : [];
    if (prevTokens.length > 40) throw new HttpError(400, "prev 格式不正確");
    // 上限含信心偏低時的加測額度
    if (prevTokens.length >= MAX_QUESTIONS) throw new HttpError(409, "題目已全部生成");

    // 解開先前題目的 token 取得主題、文字與選項陣營，供去重與陣營覆蓋平衡使用
    const prev = prevTokens.map((t) => {
      const p = unseal(t);
      return {
        theme: p.t,
        question: p.q,
        alignments: (p.o || []).map((o) => o.alignment),
      };
    });

    const index = prev.length;

    // 此裝置看過的題目 id（由前端 localStorage 提供），避免重複遇題
    const seenIds = Array.isArray(body.seen)
      ? body.seen.filter((s) => typeof s === "string").slice(0, 500)
      : [];

    // 優先從題目池取（<1 秒）；池空、全看過或 KV 未設定時退回現場生成
    let q = null;
    if (kvEnabled) {
      try {
        q = await drawFromPool({
          usedThemes: prev.map((p) => p.theme),
          prevQuestions: prev.map((p) => p.question),
          seenIds,
        });
      } catch (err) {
        console.error("題目池讀取失敗，改為現場生成：", err.message);
      }
    }
    const fromPool = Boolean(q);
    if (!q) q = await generateQuestion({ index, prev });

    const token = seal({ i: index, t: q.theme, q: q.question, o: q.options });

    sendJson(res, 200, {
      index,
      total: QUESTION_COUNT,
      question: q.question,
      options: q.options.map(({ id, text }) => ({ id, text })), // 不洩漏 alignment
      token,
      qid: q.id ?? null, // 池題才有；前端記錄避免重複遇題
    });

    track(
      index === 0 ? "quiz_start" : "",
      fromPool ? "pool_hit" : "pool_miss",
      latencyBucket("lat_question", Date.now() - startedAt)
    );

    // 回應送出後在背景補池（Vercel 靠 waitUntil 延續執行）
    if (kvEnabled) defer(refillPool(1));
  } catch (err) {
    track("question_error");
    handleError(res, err);
  }
}

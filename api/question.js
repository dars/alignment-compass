import { generateQuestion, QUESTION_COUNT, MAX_QUESTIONS } from "../lib/quiz.js";
import { kvEnabled, drawFromPool, refillPool } from "../lib/pool.js";
import { defer } from "../lib/defer.js";
import { seal, unseal } from "../lib/token.js";
import { readJson, sendJson, handleError, HttpError } from "../lib/http.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const body = await readJson(req);

    const prevTokens = Array.isArray(body.prev) ? body.prev : [];
    if (prevTokens.length > 40) throw new HttpError(400, "prev 格式不正確");
    // 上限含信心偏低時的加測額度
    if (prevTokens.length >= MAX_QUESTIONS) throw new HttpError(409, "題目已全部生成");

    // 解開先前題目的 token 取得主題與文字，供去重使用
    const prev = prevTokens.map((t) => {
      const p = unseal(t);
      return { theme: p.t, question: p.q };
    });

    const index = prev.length;

    // 優先從題目池取（<1 秒）；池空或 KV 未設定時退回現場生成
    let q = null;
    if (kvEnabled) {
      try {
        q = await drawFromPool({
          usedThemes: prev.map((p) => p.theme),
          prevQuestions: prev.map((p) => p.question),
        });
      } catch (err) {
        console.error("題目池讀取失敗，改為現場生成：", err.message);
      }
    }
    if (!q) q = await generateQuestion({ index, prev });

    const token = seal({ i: index, t: q.theme, q: q.question, o: q.options });

    sendJson(res, 200, {
      index,
      total: QUESTION_COUNT,
      question: q.question,
      options: q.options.map(({ id, text }) => ({ id, text })), // 不洩漏 alignment
      token,
    });

    // 回應送出後在背景補池（Vercel 靠 waitUntil 延續執行）
    if (kvEnabled) defer(refillPool(1));
  } catch (err) {
    handleError(res, err);
  }
}

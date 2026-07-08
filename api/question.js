import { generateQuestion, QUESTION_COUNT } from "../lib/quiz.js";
import { seal, unseal } from "../lib/token.js";
import { readJson, sendJson, handleError, HttpError } from "../lib/http.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const body = await readJson(req);

    const prevTokens = Array.isArray(body.prev) ? body.prev : [];
    if (prevTokens.length > 40) throw new HttpError(400, "prev 格式不正確");
    if (prevTokens.length >= QUESTION_COUNT) throw new HttpError(409, "題目已全部生成");

    // 解開先前題目的 token 取得主題與文字，供去重提示使用
    const prev = prevTokens.map((t) => {
      const p = unseal(t);
      return { theme: p.t, question: p.q };
    });

    const index = prev.length;
    const q = await generateQuestion({ index, prev });
    const token = seal({ i: index, t: q.theme, q: q.question, o: q.options });

    sendJson(res, 200, {
      index,
      total: QUESTION_COUNT,
      question: q.question,
      options: q.options.map(({ id, text }) => ({ id, text })), // 不洩漏 alignment
      token,
    });
  } catch (err) {
    handleError(res, err);
  }
}

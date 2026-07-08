import {
  axesFromPicks,
  classify,
  buildNarrative,
  MAX_QUESTIONS,
} from "../lib/quiz.js";
import { resolveAnswers } from "../lib/answers.js";
import { readJson, sendJson, handleError, HttpError } from "../lib/http.js";

// 個人化敘事（DM 的觀察＋扮演建議）：LLM 生成、較慢（~20-40 秒），
// 由前端在結果顯示後非同步請求；失敗只影響敘事區塊，不影響判定
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const body = await readJson(req);

    const picks = resolveAnswers(body.answers ?? [], { maxCount: MAX_QUESTIONS });
    if (picks.length === 0) throw new HttpError(400, "answers 格式不正確");

    const axes = axesFromPicks(picks);
    const alignment = classify(axes);

    const narrative = await buildNarrative({
      alignment,
      lawScore: axes.lawScore,
      goodScore: axes.goodScore,
      picks: picks.map((p) => ({
        question: p.question,
        choice: p.choice,
        alignment: p.option.alignment,
      })),
    });

    sendJson(res, 200, narrative);
  } catch (err) {
    handleError(res, err);
  }
}

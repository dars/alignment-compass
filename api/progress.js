import { axesFromPicks, assessConfidence, QUESTION_COUNT, MAX_QUESTIONS } from "../lib/quiz.js";
import { resolveAnswers } from "../lib/answers.js";
import { readJson, sendJson, handleError, HttpError } from "../lib/http.js";

// 答題進行中的即時信心指數：只回信心值，不回兩軸方向（避免洩題與引導作答）
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const body = await readJson(req);

    const picks = resolveAnswers(body.answers ?? [], { maxCount: MAX_QUESTIONS });
    const axes = axesFromPicks(picks);
    const { confidence, level } = assessConfidence(picks, QUESTION_COUNT, axes);

    sendJson(res, 200, {
      answered: picks.length,
      total: QUESTION_COUNT,
      confidence,
      level,
    });
  } catch (err) {
    handleError(res, err);
  }
}

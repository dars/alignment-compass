import {
  axesFromPicks,
  assessConfidence,
  classify,
  nearestSecondary,
  QUESTION_COUNT,
  MAX_QUESTIONS,
} from "../lib/quiz.js";
import { resolveAnswers } from "../lib/answers.js";
import { track } from "../lib/stats.js";
import { readJson, sendJson, handleError, HttpError } from "../lib/http.js";

// 純統計結算（<0.1 秒）：陣營、兩軸分數、信心、次要陣營、加測資訊。
// 個人化敘事拆到 /api/narrative 非同步取得，多人同時結算不需排隊。
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const body = await readJson(req);

    const picks = resolveAnswers(body.answers ?? [], { maxCount: MAX_QUESTIONS });
    if (picks.length === 0) throw new HttpError(400, "answers 格式不正確");

    const axes = axesFromPicks(picks);
    const alignment = classify(axes);
    const { confidence, level } = assessConfidence(picks, QUESTION_COUNT, axes);
    const secondary = nearestSecondary(axes);
    // 信心偏低且還有加測額度時，提供自願加測
    const extendRemaining = MAX_QUESTIONS - picks.length;
    const extend = level === "低" && extendRemaining > 0 ? { count: extendRemaining } : null;

    sendJson(res, 200, {
      alignment,
      lawScore: axes.lawScore,
      goodScore: axes.goodScore,
      confidence,
      level,
      secondary,
      extend,
    });

    track(
      "quiz_complete",
      `alignment:${alignment}`,
      `confidence:${level}`,
      secondary ? "secondary_shown" : "",
      extend ? "extend_offered" : "",
      picks.length > QUESTION_COUNT ? "extend_completed" : ""
    );
  } catch (err) {
    handleError(res, err);
  }
}

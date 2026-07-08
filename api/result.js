import {
  axesFromPicks,
  assessConfidence,
  classify,
  nearestSecondary,
  buildNarrative,
  QUESTION_COUNT,
  MAX_QUESTIONS,
} from "../lib/quiz.js";
import { resolveAnswers } from "../lib/answers.js";
import { readJson, sendJson, handleError, HttpError } from "../lib/http.js";

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

    sendJson(res, 200, {
      alignment,
      lawScore: axes.lawScore,
      goodScore: axes.goodScore,
      confidence,
      level,
      secondary,
      extend,
      analysis: narrative.analysis,
      roleplayTips: narrative.roleplayTips,
    });
  } catch (err) {
    handleError(res, err);
  }
}

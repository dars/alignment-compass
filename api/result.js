import {
  axesFromPicks,
  assessConfidence,
  classify,
  buildNarrative,
  QUESTION_COUNT,
} from "../lib/quiz.js";
import { resolveAnswers } from "../lib/answers.js";
import { readJson, sendJson, handleError, HttpError } from "../lib/http.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const body = await readJson(req);

    const picks = resolveAnswers(body.answers ?? [], { maxCount: QUESTION_COUNT });
    if (picks.length === 0) throw new HttpError(400, "answers 格式不正確");

    const axes = axesFromPicks(picks);
    const alignment = classify(axes);
    const { confidence, level } = assessConfidence(picks, QUESTION_COUNT, axes);

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
      analysis: narrative.analysis,
      roleplayTips: narrative.roleplayTips,
    });
  } catch (err) {
    handleError(res, err);
  }
}

import { unseal } from "./token.js";
import { HttpError } from "./http.js";

// answers: [{token, choice}] → 依題序排列的 picks
// 驗證 token 有效性、選項代碼、題號不重複
export function resolveAnswers(answers, { maxCount }) {
  if (!Array.isArray(answers) || answers.length > maxCount) {
    throw new HttpError(400, "answers 格式不正確");
  }
  const seen = new Set();
  return answers
    .map((a) => {
      if (typeof a?.token !== "string" || typeof a?.choice !== "string") {
        throw new HttpError(400, "answers 格式不正確");
      }
      const p = unseal(a.token); // {i, t, q, o: [{id, text, alignment}]}
      if (!Number.isInteger(p.i) || seen.has(p.i)) {
        throw new HttpError(400, "作答資料重複或無效");
      }
      seen.add(p.i);
      const option = (p.o || []).find((o) => o.id === a.choice);
      if (!option) throw new HttpError(400, `第 ${p.i + 1} 題的選項代碼不正確`);
      // offered：當題提供的全部陣營，供信心計算判斷「是否選了可得的最近者」
      return {
        index: p.i,
        question: p.q,
        choice: option.text,
        option,
        offered: (p.o || []).map((o) => o.alignment),
      };
    })
    .sort((a, b) => a.index - b.index);
}

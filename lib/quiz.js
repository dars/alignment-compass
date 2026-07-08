import {
  OLLAMA_URL,
  OLLAMA_MODEL,
  QUESTION_COUNT,
  LLM_TIMEOUT_MS,
  CF_ACCESS_CLIENT_ID,
  CF_ACCESS_CLIENT_SECRET,
} from "./config.js";
import { HttpError } from "./http.js";

export const NEUTRAL_THRESHOLD = 20; // |分數| <= 20 視為該軸中立
export const ALIGNMENT_CODES = ["LG", "NG", "CG", "LN", "TN", "CN", "LE", "NE", "CE"];

// 陣營代碼 → [law, good] 座標（守序/善良 = +1）
const AXIS = {
  LG: [1, 1],  NG: [0, 1],  CG: [-1, 1],
  LN: [1, 0],  TN: [0, 0],  CN: [-1, 0],
  LE: [1, -1], NE: [0, -1], CE: [-1, -1],
};

const ALIGNMENT_ZH = {
  LG: "守序善良", NG: "中立善良", CG: "混亂善良",
  LN: "守序中立", TN: "絕對中立", CN: "混亂中立",
  LE: "守序邪惡", NE: "中立邪惡", CE: "混亂邪惡",
};

const THEMES = [
  "authority", "justice", "loyalty", "honor", "freedom", "mercy",
  "sacrifice", "betrayal", "greed", "power", "tradition", "revenge",
  "survival", "temptation", "duty", "secrecy", "ambition", "trust",
];

// ─── Prompts 與 Schema ────────────────────────────────────

const QUESTION_SYSTEM = `你是一個 Dungeons & Dragons Nine Alignments Question Generator。
你的唯一工作，是產生一題可以區分 D&D 九大陣營的情境題。

規則：
1. 一律使用繁體中文（台灣用語），絕不可出現簡體字；僅 theme 欄位使用英文。
2. 背景必須符合 D&D Fantasy 世界。
3. 題目必須是一個具體事件，而不是人格問題。
4. 必須提供恰好四個選項。
5. 四個選項都必須合理，不能有明顯正確答案。
6. 四個選項必須代表不同的價值觀，且分別對應四個「不同」的陣營。
7. 每個選項判定最符合的九大陣營代碼（LG、NG、CG、LN、TN、CN、LE、NE、CE）。
8. confidence 為 0 到 1 的數值，代表你對該選項陣營判定的信心。
9. 題目不要與常見的「偷麵包」「救小孩」「國王命令」等範例相似。
10. theme 使用英文。
11. question 欄位只放情境描述，絕對不可在其中列出或複述選項——不論「選項一」「選項1」「A.」或任何編號形式；四個選項只能放進 options 陣列，且選項文字不要以任何編號開頭。
12. question 與選項文字中絕對不可出現陣營代碼（LG、CE 等）或陣營名稱（守序善良、混亂邪惡等）；陣營判定只能放在 alignment 欄位，不可讓作答者從文字看出選項對應的陣營。`;

const QUESTION_SCHEMA = {
  type: "object",
  properties: {
    theme: { type: "string" },
    question: { type: "string" },
    options: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          alignment: { type: "string", enum: ALIGNMENT_CODES },
          confidence: { type: "number" },
        },
        required: ["text", "alignment", "confidence"],
      },
    },
  },
  required: ["theme", "question", "options"],
};

const NARRATIVE_SYSTEM = `你是資深的 D&D 跑團主持人（DM）。玩家剛完成陣營測驗，系統已依作答統計出其陣營與兩軸分數，你的工作是撰寫個人化的分析與扮演建議。一律使用繁體中文（台灣用語），絕不可出現簡體字。

規則：
- 不要更改或質疑系統的判定結果。
- analysis：約 150~250 字，引用玩家的具體選擇作為佐證，語氣像資深 DM 對玩家的觀察，可以幽默但要有洞察。
- roleplayTips：恰好 3 條給這位玩家的跑團扮演建議，要針對其陣營與答題傾向量身打造。
- 提及陣營時一律使用中文名稱（如「混亂中立」），絕不可出現 LG、CN 等英文代碼，也不要逐題條列每個選項的陣營標籤，把觀察自然地寫進文章裡。`;

const NARRATIVE_SCHEMA = {
  type: "object",
  properties: {
    analysis: { type: "string" },
    roleplayTips: { type: "array", minItems: 3, maxItems: 3, items: { type: "string" } },
  },
  required: ["analysis", "roleplayTips"],
};

// ─── Ollama 呼叫 ──────────────────────────────────────────

async function ollamaChat({ system, user, schema, temperature }) {
  const headers = { "Content-Type": "application/json" };
  if (CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = CF_ACCESS_CLIENT_SECRET;
  }

  let res;
  try {
    res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        think: false,
        format: schema,
        options: { temperature, top_p: 0.9, top_k: 40 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new HttpError(504, "模型回應逾時，請再試一次");
    }
    throw new HttpError(502, `無法連線到 Ollama（${OLLAMA_URL}）`);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new HttpError(502, `Ollama 錯誤：${data.error || res.status}`);
  }
  const content = data.message?.content;
  if (!content) throw new HttpError(502, "Ollama 未回傳內容");

  // 小模型偶爾會包 code fence，寬鬆處理
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new HttpError(502, "模型回傳的 JSON 無法解析，請再試一次");
  }
}

// ─── 出題（單題生成 + 驗證重試）───────────────────────────

const MAX_GEN_ATTEMPTS = 4;

// 小模型偶爾把控制符、內心獨白或 JSON 片段塞進字串值：
// 出現這些特徵一律視為髒題，整題重打（正常繁中題目不會有 ASCII 引號）
const GARBAGE_RE = /<\||\|>|<channel|```|json|[{}<>`"]/i;

// 陣營代碼或中文陣營名稱洩漏在題目/選項文字中（會直接暴露答案）
const CODE_LEAK_RE =
  /\b(?:LG|NG|CG|LN|TN|CN|LE|NE|CE)\b|守序善良|中立善良|混亂善良|守序中立|絕對中立|混亂中立|守序邪惡|中立邪惡|混亂邪惡/;

// 小模型偶爾把選項列表或 schema 欄位塞進題目文字：從第一個標記處截斷
const OPTION_MARKERS = [
  /^\s*[A-Da-d][.、．)）]\s/m,
  /選項\s*[一二三四1-4１-４]\s*[:：、.．]/,
  /\b(?:options?|choices?|answers?|alignment|confidence|theme)\s*[:：]/i,
];

function looksClean(text, maxLen) {
  return (
    typeof text === "string" &&
    text.length >= 2 &&
    text.length <= maxLen &&
    !GARBAGE_RE.test(text)
  );
}

function cleanQuestionText(text) {
  let cut = -1;
  for (const marker of OPTION_MARKERS) {
    const idx = text.search(marker);
    if (idx !== -1 && (cut === -1 || idx < cut)) cut = idx;
  }
  const kept = cut === -1 ? text : text.slice(0, cut);
  return kept.trim().replace(/[：:]\s*$/, "").trim();
}

function cleanOptionText(text) {
  return text
    .trim()
    .replace(/^(?:[A-Da-d][.、．)）]\s*)+/, "")
    .replace(/(?:\s*[（(][^（()）]*[)）])?\s*$/, (tail) =>
      CODE_LEAK_RE.test(tail) ? "" : tail
    )
    .trim();
}

function clamp01(n) {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.7;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function validateQuestion(raw, { finalAttempt }) {
  if (typeof raw?.question !== "string" || !Array.isArray(raw?.options)) return null;

  const question = cleanQuestionText(raw.question);
  if (!looksClean(question, 500) || question.length < 10) return null;
  if (CODE_LEAK_RE.test(question)) return null;

  const options = raw.options
    .filter((o) => {
      if (!ALIGNMENT_CODES.includes(o?.alignment)) return false;
      if (typeof o?.text !== "string") return false;
      const text = cleanOptionText(o.text);
      return looksClean(text, 200) && !CODE_LEAK_RE.test(text);
    })
    .slice(0, 4);
  if (options.length !== 4) return null;

  // 四個選項的陣營必須相異；最後一次嘗試放寬為至少 3 種
  const distinct = new Set(options.map((o) => o.alignment)).size;
  if (distinct < 4 && !(finalAttempt && distinct >= 3)) return null;

  // 洗牌後由 server 指派選項 id，alignment/confidence 不外洩給前端
  shuffle(options);
  return {
    question,
    options: options.map((o, i) => ({
      id: "ABCD"[i],
      text: cleanOptionText(o.text),
      alignment: o.alignment,
      confidence: clamp01(o.confidence),
    })),
  };
}

function pickTheme(usedThemes) {
  const used = new Set(usedThemes);
  const unused = THEMES.filter((t) => !used.has(t));
  const pool = unused.length > 0 ? unused : THEMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

// prev: [{theme, question}]（先前題目的主題與文字，用於去重）
export async function generateQuestion({ index, prev }) {
  const theme = pickTheme(prev.map((p) => p.theme));
  const summaries = prev
    .map((p, i) => `${i + 1}. [${p.theme}] ${p.question.slice(0, 40)}`)
    .join("\n");

  const user =
    `請產生第 ${index + 1} 題。本題主題：${theme}。` +
    (summaries
      ? `\n\n已出過的情境摘要：\n${summaries}\n\n請設計與上述完全不同的情境，不可重複。`
      : "");

  for (let attempt = 1; attempt <= MAX_GEN_ATTEMPTS; attempt++) {
    const raw = await ollamaChat({
      system: QUESTION_SYSTEM,
      user,
      schema: QUESTION_SCHEMA,
      temperature: 0.95,
    });

    const question = validateQuestion(raw, { finalAttempt: attempt === MAX_GEN_ATTEMPTS });
    if (question) return { ...question, theme };

    console.warn(
      `第 ${index + 1} 題第 ${attempt} 次生成不合格：`,
      JSON.stringify(raw).slice(0, 200)
    );
  }
  throw new HttpError(
    502,
    "模型多次生成不合格的題目（選項陣營重複、含雜訊或格式不完整），請再試一次"
  );
}

// ─── 計分與信心 ───────────────────────────────────────────

// picks: [{option}]，option 需含 alignment 與 confidence
export function axesFromPicks(picks) {
  let lawSum = 0;
  let goodSum = 0;
  let weightSum = 0;
  for (const { option } of picks) {
    const [law, good] = AXIS[option.alignment];
    const weight = 0.3 + 0.7 * option.confidence; // 低信心仍保留基本權重
    lawSum += law * weight;
    goodSum += good * weight;
    weightSum += weight;
  }
  if (weightSum === 0) return { lawScore: 0, goodScore: 0 };
  return {
    lawScore: Math.round((lawSum / weightSum) * 100),
    goodScore: Math.round((goodSum / weightSum) * 100),
  };
}

// 判定信心指數（0~100）：進度 ×（55% 分數扎實度 + 45% 作答一致性）
export function assessConfidence(picks, total, { lawScore, goodScore }) {
  const k = picks.length;
  if (k === 0 || total === 0) return { confidence: 0, level: "低" };

  const dist = (s) =>
    Math.abs(s) <= NEUTRAL_THRESHOLD
      ? NEUTRAL_THRESHOLD - Math.abs(s)
      : Math.abs(s) - NEUTRAL_THRESHOLD;
  const solidity =
    (Math.min(dist(lawScore), 40) / 40 + Math.min(dist(goodScore), 40) / 40) / 2;

  const sd = (vals) => {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length);
  };
  const lawVals = picks.map((p) => AXIS[p.option.alignment][0]);
  const goodVals = picks.map((p) => AXIS[p.option.alignment][1]);
  const consistency = Math.max(0, 1 - (sd(lawVals) + sd(goodVals)) / 2);

  const progress = Math.min(1, k / total);

  const confidence = Math.round(100 * progress * (0.55 * solidity + 0.45 * consistency));
  const level = confidence >= 70 ? "高" : confidence >= 45 ? "中" : "低";
  return { confidence, level };
}

export function classify({ lawScore, goodScore }) {
  const lawChar = lawScore > NEUTRAL_THRESHOLD ? "L" : lawScore < -NEUTRAL_THRESHOLD ? "C" : "N";
  const goodChar = goodScore > NEUTRAL_THRESHOLD ? "G" : goodScore < -NEUTRAL_THRESHOLD ? "E" : "N";
  return lawChar === "N" && goodChar === "N" ? "TN" : `${lawChar}${goodChar}`;
}

// ─── 敘事 ─────────────────────────────────────────────────

// picks: [{question, choice, alignment}]
export async function buildNarrative({ alignment, lawScore, goodScore, picks }) {
  const transcript = picks
    .map(
      (p, i) =>
        `第 ${i + 1} 題：${p.question}\n玩家的選擇：${p.choice}（此選項傾向：${ALIGNMENT_ZH[p.alignment]}）`
    )
    .join("\n\n");

  const user =
    `系統判定結果：陣營「${ALIGNMENT_ZH[alignment]}」，秩序軸 ${lawScore}（-100 極端混亂 ~ 100 極端守序），` +
    `道德軸 ${goodScore}（-100 極端邪惡 ~ 100 極端善良）。\n\n作答紀錄：\n\n${transcript}`;

  try {
    const data = await ollamaChat({
      system: NARRATIVE_SYSTEM,
      user,
      schema: NARRATIVE_SCHEMA,
      temperature: 0.2,
    });
    return {
      analysis: typeof data.analysis === "string" ? data.analysis : null,
      roleplayTips: Array.isArray(data.roleplayTips)
        ? data.roleplayTips.filter((t) => typeof t === "string").slice(0, 3)
        : [],
    };
  } catch (err) {
    // 敘事失敗不影響判定結果，前端會隱藏對應區塊
    console.error("敘事生成失敗：", err.message);
    return { analysis: null, roleplayTips: [] };
  }
}

export { QUESTION_COUNT };

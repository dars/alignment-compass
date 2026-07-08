import http from "node:http";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// 讀取 .env（若存在）；已存在的環境變數優先
try {
  const envFile = await readFile(path.join(here, ".env"), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

// ─── 設定 ─────────────────────────────────────────────────
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/api/chat";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gemma4:latest";
const QUESTION_COUNT = Number(process.env.QUESTION_COUNT || 12);
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 300_000);
const PORT = process.env.PORT || 3000;

const SESSION_TTL_MS = 60 * 60 * 1000;
const NEUTRAL_THRESHOLD = 20; // |分數| <= 20 視為該軸中立
const ALIGNMENT_CODES = ["LG", "NG", "CG", "LN", "TN", "CN", "LE", "NE", "CE"];

// 陣營代碼 → [law, good] 座標（守序/善良 = +1）
const AXIS = {
  LG: [1, 1],  NG: [0, 1],  CG: [-1, 1],
  LN: [1, 0],  TN: [0, 0],  CN: [-1, 0],
  LE: [1, -1], NE: [0, -1], CE: [-1, -1],
};

const THEMES = [
  "authority", "justice", "loyalty", "honor", "freedom", "mercy",
  "sacrifice", "betrayal", "greed", "power", "tradition", "revenge",
  "survival", "temptation", "duty", "secrecy", "ambition", "trust",
];

const PUBLIC_DIR = path.join(here, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ─── Prompts 與 Schema ────────────────────────────────────

const QUESTION_SYSTEM = `你是一個 Dungeons & Dragons Nine Alignments Question Generator。
你的唯一工作，是產生一題可以區分 D&D 九大陣營的情境題。

規則：
1. 一律使用繁體中文（theme 除外）。
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

const NARRATIVE_SYSTEM = `你是資深的 D&D 跑團主持人（DM）。玩家剛完成陣營測驗，系統已依作答統計出其陣營與兩軸分數，你的工作是撰寫個人化的分析與扮演建議。一律使用繁體中文。

規則：
- 不要更改或質疑系統的判定結果。
- analysis：約 150~250 字，引用玩家的具體選擇作為佐證，語氣像資深 DM 對玩家的觀察，可以幽默但要有洞察。
- roleplayTips：恰好 3 條給這位玩家的跑團扮演建議，要針對其陣營與答題傾向量身打造。`;

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
  let res;
  try {
    res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

// ─── 出題（單題生成 + server 端驗證重試）──────────────────

const MAX_GEN_ATTEMPTS = 4;

// 小模型偶爾把控制符、內心獨白或 JSON 片段塞進字串值：
// 出現這些特徵一律視為髒題，整題重打（正常繁中題目不會有 ASCII 引號）
const GARBAGE_RE = /<\||\|>|<channel|```|json|[{}<>`"]/i;

function looksClean(text, maxLen) {
  return (
    typeof text === "string" &&
    text.length >= 2 &&
    text.length <= maxLen &&
    !GARBAGE_RE.test(text)
  );
}

async function generateQuestion(session) {
  const index = session.questions.length;
  const theme = pickTheme(session);
  const summaries = session.questions
    .map((q, i) => `${i + 1}. [${q.theme}] ${q.question.slice(0, 40)}`)
    .join("\n");

  const user =
    `請產生第 ${index + 1} 題。本題主題：${theme}。` +
    (summaries
      ? `\n\n已出過的情境摘要：\n${summaries}\n\n請設計與上述完全不同的情境，不可重複。`
      : "");

  let lastProblem = "";
  for (let attempt = 1; attempt <= MAX_GEN_ATTEMPTS; attempt++) {
    const raw = await ollamaChat({
      system: QUESTION_SYSTEM,
      user,
      schema: QUESTION_SCHEMA,
      temperature: 0.95,
    });

    const finalAttempt = attempt === MAX_GEN_ATTEMPTS;
    const question = validateQuestion(raw, { finalAttempt });
    if (question) {
      question.theme = theme;
      session.usedThemes.add(theme);
      session.questions.push(question);
      return question;
    }
    lastProblem = "選項陣營重複、含雜訊或格式不完整";
    console.warn(
      `第 ${index + 1} 題第 ${attempt} 次生成不合格：`,
      JSON.stringify(raw).slice(0, 200)
    );
  }
  throw new HttpError(502, `模型多次生成不合格的題目（${lastProblem}），請再試一次`);
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
      // 剝除尾隨標注後若文字中仍殘留陣營字樣，直接淘汰
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

// 小模型偶爾把選項列表或 schema 欄位塞進題目文字：從第一個標記處截斷
// 涵蓋「行首 A.」、內文「選項一：」，以及洩漏的欄位名稱「options:」「confidence:」等
const OPTION_MARKERS = [
  /^\s*[A-Da-d][.、．)）]\s/m,
  /選項\s*[一二三四1-4１-４]\s*[:：、.．]/,
  /\b(?:options?|choices?|answers?|alignment|confidence|theme)\s*[:：]/i,
];

function cleanQuestionText(text) {
  let cut = -1;
  for (const marker of OPTION_MARKERS) {
    const idx = text.search(marker);
    if (idx !== -1 && (cut === -1 || idx < cut)) cut = idx;
  }
  const kept = cut === -1 ? text : text.slice(0, cut);
  return kept.trim().replace(/[：:]\s*$/, "").trim();
}

// 陣營代碼或中文陣營名稱洩漏在題目/選項文字中（會直接暴露答案）
const CODE_LEAK_RE =
  /\b(?:LG|NG|CG|LN|TN|CN|LE|NE|CE)\b|守序善良|中立善良|混亂善良|守序中立|絕對中立|混亂中立|守序邪惡|中立邪惡|混亂邪惡/;

// 選項文字偶爾自帶「A.」編號前綴或尾隨的陣營標注「(CG)」：剝掉
function cleanOptionText(text) {
  return text
    .trim()
    .replace(/^(?:[A-Da-d][.、．)）]\s*)+/, "")
    .replace(/(?:\s*[（(][^（()）]*[)）])?\s*$/, (tail) =>
      CODE_LEAK_RE.test(tail) ? "" : tail
    )
    .trim();
}

function pickTheme(session) {
  const unused = THEMES.filter((t) => !session.usedThemes.has(t));
  const pool = unused.length > 0 ? unused : THEMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ─── 計分（統計判定，AI 只負責敘事）──────────────────────

function tally(session, choices) {
  let lawSum = 0;
  let goodSum = 0;
  let weightSum = 0;

  const picks = session.questions.map((q, i) => {
    const option = q.options.find((o) => o.id === choices[i]);
    if (!option) throw new HttpError(400, `第 ${i + 1} 題的選項代碼不正確`);
    const [law, good] = AXIS[option.alignment];
    const weight = 0.3 + 0.7 * option.confidence; // 低信心仍保留基本權重
    lawSum += law * weight;
    goodSum += good * weight;
    weightSum += weight;
    return { question: q.question, choice: option.text, alignment: option.alignment };
  });

  const lawScore = Math.round((lawSum / weightSum) * 100);
  const goodScore = Math.round((goodSum / weightSum) * 100);

  const lawChar = lawScore > NEUTRAL_THRESHOLD ? "L" : lawScore < -NEUTRAL_THRESHOLD ? "C" : "N";
  const goodChar = goodScore > NEUTRAL_THRESHOLD ? "G" : goodScore < -NEUTRAL_THRESHOLD ? "E" : "N";
  const alignment = lawChar === "N" && goodChar === "N" ? "TN" : `${lawChar}${goodChar}`;

  return { alignment, lawScore, goodScore, picks };
}

async function buildNarrative({ alignment, lawScore, goodScore, picks }) {
  const transcript = picks
    .map((p, i) => `第 ${i + 1} 題：${p.question}\n玩家的選擇：${p.choice}（傾向 ${p.alignment}）`)
    .join("\n\n");

  const user =
    `系統判定結果：陣營 ${alignment}，秩序軸 ${lawScore}（-100 極端混亂 ~ 100 極端守序），` +
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

// ─── Session ──────────────────────────────────────────────

const sessions = new Map();

function createSession() {
  const id = crypto.randomUUID();
  const session = {
    id,
    createdAt: Date.now(),
    total: QUESTION_COUNT,
    questions: [],
    usedThemes: new Set(),
    generating: false,
  };
  sessions.set(id, session);
  return session;
}

function getSession(id) {
  const session = sessions.get(id);
  if (!session) throw new HttpError(404, "測驗場次不存在或已過期，請重新開始");
  return session;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}, 10 * 60 * 1000).unref();

// ─── 共用 ─────────────────────────────────────────────────

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 100_000) {
        reject(new HttpError(413, "請求內容過大"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

// ─── HTTP server ──────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/session") {
      const session = createSession();
      return sendJson(res, 200, { id: session.id, total: session.total });
    }

    let m;
    if (req.method === "POST" && (m = req.url.match(/^\/api\/session\/([\w-]+)\/question$/))) {
      const session = getSession(m[1]);
      if (session.questions.length >= session.total) {
        return sendJson(res, 409, { error: "題目已全部生成" });
      }
      if (session.generating) {
        return sendJson(res, 409, { error: "上一題還在生成中" });
      }
      session.generating = true;
      try {
        const q = await generateQuestion(session);
        return sendJson(res, 200, {
          index: session.questions.length - 1,
          total: session.total,
          question: q.question,
          options: q.options.map(({ id, text }) => ({ id, text })), // 不洩漏 alignment
        });
      } finally {
        session.generating = false;
      }
    }

    if (req.method === "POST" && (m = req.url.match(/^\/api\/session\/([\w-]+)\/result$/))) {
      const session = getSession(m[1]);
      const body = JSON.parse((await readBody(req)) || "{}");
      const choices = body.choices;
      if (
        !Array.isArray(choices) ||
        choices.length !== session.questions.length ||
        session.questions.length === 0 ||
        !choices.every((c) => typeof c === "string")
      ) {
        return sendJson(res, 400, { error: "choices 格式不正確" });
      }
      const result = tally(session, choices);
      const narrative = await buildNarrative(result);
      sessions.delete(session.id);
      return sendJson(res, 200, {
        alignment: result.alignment,
        lawScore: result.lawScore,
        goodScore: result.goodScore,
        analysis: narrative.analysis,
        roleplayTips: narrative.roleplayTips,
      });
    }

    if (req.method === "GET" || req.method === "HEAD") {
      return await serveStatic(req, res);
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    const httpErr =
      err instanceof HttpError ? err : new HttpError(500, "伺服器內部錯誤");
    if (httpErr.status >= 500) console.error(err);
    sendJson(res, httpErr.status, { error: httpErr.message });
  }
});

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const relative = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return sendJson(res, 403, { error: "Forbidden" });
  }
  try {
    const content = await readFile(filePath);
    const type = MIME[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

server.listen(PORT, () => {
  console.log(`陣營羅盤 Alignment Compass 已啟動：http://localhost:${PORT}`);
  console.log(`Ollama：${OLLAMA_URL}，模型 ${OLLAMA_MODEL}，每場 ${QUESTION_COUNT} 題`);
});

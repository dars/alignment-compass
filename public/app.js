// 陣營羅盤前端：逐題向後端取題（背景預取下一題），作答完成後由後端統計陣營。
// 無狀態設計：每題附帶加密 token（含隱藏的陣營標注），由前端持有、原樣帶回。

const state = {
  total: 0,
  questions: [],   // [{index, total, question, options:[{id,text}], token}]
  answers: [],     // 已選選項 id，index 對應題號
  current: 0,
  result: null,
  resultSeq: 0,    // 結算序號：加測重算後用來忽略過期的敘事回應
  retryAction: null,
  extendBase: 0,   // 加測起點（0 = 未加測）
  extended: false, // 已用過加測
};

let inflight = null; // 進行中的取題請求（single-flight）

const $ = (id) => document.getElementById(id);

const screens = ["start", "loading", "quiz", "result", "error"];
function show(name) {
  for (const s of screens) {
    $(`screen-${s}`).classList.toggle("active", s === name);
  }
  window.scrollTo({ top: 0 });
}

function showLoading(text, hint) {
  $("loading-text").textContent = text;
  $("loading-hint").textContent = hint || "";
  show("loading");
}

// ─── 已看過的題目（此裝置）────────────────────────────────

const SEEN_KEY = "ac-seen-qids";

function loadSeen() {
  try {
    const a = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function recordSeen(qid) {
  if (!qid) return;
  try {
    const a = loadSeen();
    if (!a.includes(qid)) {
      a.push(qid);
      while (a.length > 300) a.shift(); // 只留最近 300 筆
      localStorage.setItem(SEEN_KEY, JSON.stringify(a));
    }
  } catch {}
}

// ─── API ──────────────────────────────────────────────────

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `伺服器錯誤（${res.status}）`);
  return data;
}

function fetchNextQuestion() {
  if (!inflight) {
    inflight = api("/api/question", {
      prev: state.questions.map((q) => q.token),
      seen: loadSeen(),
    })
      .then((q) => {
        state.questions.push(q);
        // total 只在開場採用一次；加測會自行加大 total，不可被回應覆寫
        if (!state.total) state.total = q.total;
        recordSeen(q.qid);
        inflight = null;
        return q;
      })
      .catch((err) => {
        inflight = null;
        throw err;
      });
  }
  return inflight;
}

async function ensureQuestion(i) {
  while (state.questions.length <= i) {
    await fetchNextQuestion();
  }
}

// 背景預取下一題；失敗不吵，輪到該題時 ensureQuestion 會重試
function prefetch() {
  if (state.questions.length < state.total && !inflight) {
    fetchNextQuestion().catch(() => {});
  }
}

// 已作答的題目 → [{token, choice}]
function answeredPayload() {
  const answers = [];
  state.questions.forEach((q, i) => {
    if (state.answers[i] != null) {
      answers.push({ token: q.token, choice: state.answers[i] });
    }
  });
  return answers;
}

// ─── 流程 ─────────────────────────────────────────────────

async function startQuiz() {
  showLoading("正在擲骰準備題目……", "DM 正在為你挑選冒險情境");
  state.questions = [];
  state.answers = [];
  state.current = 0;
  state.total = 0;
  state.result = null;
  state.extendBase = 0;
  state.extended = false;
  $("confidence-line").hidden = true;
  try {
    await ensureQuestion(0);
    state.answers = new Array(state.total).fill(null);
    renderQuestion();
    show("quiz");
    prefetch();
  } catch (err) {
    showError(err.message, startQuiz);
  }
}

function renderQuestion() {
  const q = state.questions[state.current];

  const inExtend = state.extendBase > 0 && state.current >= state.extendBase;
  $("quiz-counter").textContent = inExtend
    ? `加測 ${state.current - state.extendBase + 1} / ${state.total - state.extendBase}`
    : `${state.current + 1} / ${state.total}`;
  $("progress-bar").style.width = `${(state.current / state.total) * 100}%`;
  $("question-text").textContent = q.question;
  $("btn-back").hidden = state.current === 0;

  const container = $("options");
  container.innerHTML = "";
  for (const option of q.options) {
    const btn = document.createElement("button");
    btn.className = "option";
    btn.textContent = option.text;
    btn.addEventListener("click", () => choose(option.id));
    container.appendChild(btn);
  }
}

// 每答一題就向後端要即時信心指數（純統計、即時回應；只有信心值，不含方向）
function updateConfidence() {
  api("/api/progress", { answers: answeredPayload() })
    .then(({ confidence, level, answered }) => {
      if (answered === 0) return;
      const el = $("confidence-line");
      el.hidden = false;
      el.textContent = `判定信心 ${confidence}%（${level}）`;
    })
    .catch(() => {}); // 純加分資訊，失敗就不顯示
}

async function choose(optionId) {
  state.answers[state.current] = optionId;
  updateConfidence();
  const next = state.current + 1;

  if (next >= state.total) return submitAnswers();

  if (state.questions.length > next) {
    state.current = next;
    renderQuestion();
    show("quiz");
    prefetch();
    return;
  }

  // 下一題還沒生好，顯示等待畫面
  resumeAt(next);
}

// 前往第 i 題（必要時等待生成），失敗可重試
async function resumeAt(i, loadingText) {
  showLoading(loadingText || "DM 正在構思下一題……", `第 ${i + 1} 題生成中`);
  try {
    await ensureQuestion(i);
    state.current = i;
    renderQuestion();
    show("quiz");
    prefetch();
  } catch (err) {
    showError(err.message, () => resumeAt(i, loadingText));
  }
}

// 信心偏低時的自願加測
function extendQuiz() {
  const count = state.result?.extend?.count || 4;
  state.extended = true;
  state.extendBase = state.total;
  state.total += count;
  state.answers.push(...new Array(count).fill(null));
  resumeAt(state.extendBase, "DM 正在加開試煉……");
}

function goBack() {
  if (state.current > 0) {
    state.current -= 1;
    renderQuestion();
  }
}

async function submitAnswers() {
  showLoading("正在推演你的靈魂座標……", "統計你的作答");
  try {
    const result = await api("/api/result", { answers: answeredPayload() });
    if (!ALIGNMENTS[result.alignment]) {
      throw new Error("回傳的陣營代碼不正確");
    }
    state.result = result;
    renderResult();
    show("result");
    requestNarrative(); // 敘事非同步載入，不擋結果顯示
  } catch (err) {
    showError(err.message, submitAnswers);
  }
}

// ─── 敘事（非同步）──────────────────────────────────────

function setNarrativeStatus(mode) {
  const status = $("narrative-status");
  const retry = $("btn-narrative-retry");
  if (mode === "writing") {
    status.hidden = false;
    status.textContent = "🖋 DM 正在撰寫你的觀察報告……";
    retry.hidden = true;
  } else if (mode === "failed") {
    status.hidden = false;
    status.textContent = "DM 正在忙別桌，觀察報告晚點再來拿。";
    retry.hidden = false;
  } else {
    status.hidden = true;
    retry.hidden = true;
  }
}

function requestNarrative() {
  const seq = ++state.resultSeq;
  setNarrativeStatus("writing");
  api("/api/narrative", { answers: answeredPayload() })
    .then((n) => {
      if (seq !== state.resultSeq) return; // 已有更新的結算，忽略舊回應
      state.result.analysis = n.analysis;
      state.result.roleplayTips = n.roleplayTips || [];
      $("result-analysis").textContent = n.analysis;
      setNarrativeStatus("done");
      const tips = $("result-tips");
      tips.innerHTML = "";
      for (const tip of state.result.roleplayTips) {
        const li = document.createElement("li");
        li.textContent = tip;
        tips.appendChild(li);
      }
      $("block-tips").hidden = state.result.roleplayTips.length === 0;
    })
    .catch(() => {
      if (seq !== state.resultSeq) return;
      setNarrativeStatus("failed");
    });
}

// ─── 結果渲染 ─────────────────────────────────────────────

// 軸分數 → 帶強度的文字描述（門檻 ±20 為中立帶）
function axisText(score, posLabel, negLabel) {
  const abs = Math.abs(score);
  const dir = score >= 0 ? posLabel : negLabel;
  if (abs <= 20) {
    return abs >= 8 ? `中立（略偏${dir} ${abs}）` : `中立（${abs}）`;
  }
  const strength = abs >= 80 ? "強烈" : abs >= 55 ? "明顯" : "輕微";
  return `${dir} ${abs}／100（${strength}傾向）`;
}

const LEVEL_EXPLAIN = {
  高: "傾向明確且作答一致",
  中: "傾向成形，但仍有搖擺空間",
  低: "你落在陣營的交界地帶，相鄰陣營的特質你都有一些",
};

function renderResult() {
  const r = state.result;
  const meta = ALIGNMENTS[r.alignment];

  $("result-name").textContent = meta.zh;
  $("result-en").textContent = meta.en;
  $("result-title").textContent = `—— ${meta.title} ——`;
  $("result-examples").textContent = meta.examples;

  // 敘事由 /api/narrative 非同步載入：先顯示撰寫中狀態
  $("block-analysis").hidden = false;
  $("result-analysis").textContent = "";
  $("block-tips").hidden = true;
  $("result-tips").innerHTML = "";

  const grid = $("result-grid");
  grid.innerHTML = "";
  for (const key of GRID_ORDER) {
    const cell = document.createElement("div");
    const near = r.secondary && key === r.secondary.alignment;
    cell.className = "cell" + (key === r.alignment ? " hit" : near ? " near" : "");
    cell.textContent = ALIGNMENTS[key].zh;
    grid.appendChild(cell);
  }

  // 一步之遙的次要陣營
  const sec = r.secondary && ALIGNMENTS[r.secondary.alignment];
  $("result-secondary").textContent = sec
    ? `一步之遙：${sec.zh}（${sec.en}）—— 你離這個陣營只差 ${r.secondary.distance} 分`
    : "";

  // 信心偏低且尚有額度時提供加測
  const showExtend = Boolean(r.extend) && !state.extended;
  $("block-extend").hidden = !showExtend;
  if (showExtend) $("btn-extend").textContent = `再答 ${r.extend.count} 題`;

  // 高亮玩家落在的區段（門檻 ±20，與後端 NEUTRAL_THRESHOLD 一致）
  const setZone = (containerId, score) => {
    const idx = score < -20 ? 0 : score <= 20 ? 1 : 2;
    [...$(containerId).children].forEach((span, i) =>
      span.classList.toggle("zone-active", i === idx)
    );
  };
  setZone("zones-law", r.lawScore);
  setZone("zones-good", r.goodScore);

  $("desc-law").textContent = `秩序軸：${axisText(r.lawScore, "守序", "混亂")}`;
  $("desc-good").textContent = `道德軸：${axisText(r.goodScore, "善良", "邪惡")}`;
  $("result-confidence").textContent =
    r.confidence != null
      ? `判定信心 ${r.confidence}%（${r.level}）— ${LEVEL_EXPLAIN[r.level] || ""}`
      : "";

  // 分數 -100..100 → 0%..100%
  const toPercent = (score) =>
    `${Math.min(100, Math.max(0, (score + 100) / 2))}%`;
  requestAnimationFrame(() => {
    $("marker-law").style.left = toPercent(r.lawScore);
    $("marker-good").style.left = toPercent(r.goodScore);
  });
}

async function copyResult() {
  const r = state.result;
  const meta = ALIGNMENTS[r.alignment];
  let text =
    `我在《陣營羅盤 Alignment Compass》測出的 D&D 陣營是：` +
    `${meta.zh}（${meta.en}）「${meta.title}」！\n\n` +
    `秩序軸：${axisText(r.lawScore, "守序", "混亂")}\n` +
    `道德軸：${axisText(r.goodScore, "善良", "邪惡")}`;
  if (r.confidence != null) text += `\n判定信心：${r.confidence}%（${r.level}）`;
  if (r.secondary && ALIGNMENTS[r.secondary.alignment]) {
    text += `\n一步之遙：${ALIGNMENTS[r.secondary.alignment].zh}`;
  }
  if (r.analysis) text += `\n\nDM 的觀察：${r.analysis}`;
  try {
    await navigator.clipboard.writeText(text);
    $("btn-copy").textContent = "已複製 ✓";
    setTimeout(() => ($("btn-copy").textContent = "複製結果"), 2000);
  } catch {
    $("btn-copy").textContent = "複製失敗";
  }
}

// ─── 錯誤 ─────────────────────────────────────────────────

function showError(message, retryAction) {
  $("error-message").textContent = message;
  state.retryAction = retryAction;
  show("error");
}

// ─── 綁定 ─────────────────────────────────────────────────

$("btn-start").addEventListener("click", startQuiz);
$("btn-back").addEventListener("click", goBack);
$("btn-extend").addEventListener("click", extendQuiz);
$("btn-narrative-retry").addEventListener("click", requestNarrative);
$("btn-restart").addEventListener("click", startQuiz);
$("btn-copy").addEventListener("click", copyResult);
$("btn-retry").addEventListener("click", () => {
  if (state.retryAction) state.retryAction();
});

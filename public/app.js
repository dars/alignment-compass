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
  if (name !== "loading") stopFlavor();
  window.scrollTo({ top: 0 });
}

// 載入畫面輪播的 D&D 風味語錄
const FLAVORS = [
  "骰子永遠不會說謊，但 DM 會微笑。",
  "守序不代表無趣，混亂不代表瘋狂——通常啦。",
  "地城裡最危險的不是龍，是隊友的「我有個計畫」。",
  "吟遊詩人正在為你的傳說調音……",
  "聖騎士檢查了你的動機，皺了皺眉。",
  "盜賊翻了翻你的口袋，放回了一枚銅幣。表示尊重。",
  "德魯伊說：答案早已寫在風裡。風表示：沒有。",
  "巫妖也曾是個有夢想的法師。",
  "酒館老闆聽完你的選擇，默默多倒了一杯。",
  "命運的織布機吱呀作響……",
  "一名地精正在偷看你的答案卷。噓。",
  "龍在數牠的金幣，順便數你的良心。",
];

let flavorTimer = null;

function startFlavor() {
  const el = $("loading-flavor");
  let idx = Math.floor(Math.random() * FLAVORS.length);
  el.textContent = `「${FLAVORS[idx]}」`;
  el.style.opacity = 1;
  clearInterval(flavorTimer);
  flavorTimer = setInterval(() => {
    el.style.opacity = 0;
    setTimeout(() => {
      idx = (idx + 1) % FLAVORS.length;
      el.textContent = `「${FLAVORS[idx]}」`;
      el.style.opacity = 1;
    }, 400);
  }, 5000);
}

function stopFlavor() {
  clearInterval(flavorTimer);
  flavorTimer = null;
}

function showLoading(text, hint) {
  $("loading-text").textContent = text;
  $("loading-hint").textContent = hint || "";
  show("loading");
  startFlavor();
  // display:none → block 切換後，瀏覽器偶爾不會重啟 CSS 動畫：
  // 強制 reflow 重新觸發，確保 d20 一定在轉
  const dice = document.querySelector("#screen-loading .dice");
  if (dice) {
    dice.style.animation = "none";
    void dice.offsetWidth; // 強制 reflow
    dice.style.animation = "";
  }
}

// ─── 進行中測驗的保存（重新整理不掉場）────────────────────

const PROGRESS_KEY = "ac-quiz-progress";
const PROGRESS_TTL_MS = 2 * 60 * 60 * 1000; // 與 token 有效期一致

function saveProgress() {
  try {
    sessionStorage.setItem(
      PROGRESS_KEY,
      JSON.stringify({
        t: Date.now(),
        questions: state.questions,
        answers: state.answers,
        current: state.current,
        total: state.total,
        extendBase: state.extendBase,
        extended: state.extended,
      })
    );
  } catch {}
}

function clearProgress() {
  try {
    sessionStorage.removeItem(PROGRESS_KEY);
  } catch {}
}

function loadProgress() {
  try {
    const s = JSON.parse(sessionStorage.getItem(PROGRESS_KEY) || "null");
    if (!s || Date.now() - s.t > PROGRESS_TTL_MS) return null;
    if (!Array.isArray(s.questions) || s.questions.length === 0) return null;
    if (!Array.isArray(s.answers) || !s.total) return null;
    return s;
  } catch {
    return null;
  }
}

function continueQuiz() {
  const s = loadProgress();
  if (!s) {
    $("btn-continue").hidden = true;
    return;
  }
  state.questions = s.questions;
  state.answers = s.answers;
  state.total = s.total;
  state.extendBase = s.extendBase || 0;
  state.extended = Boolean(s.extended);
  state.result = null;

  const firstUnanswered = state.answers.findIndex((a) => a == null);
  if (firstUnanswered === -1) return submitAnswers(); // 都答完了，直接結算
  if (firstUnanswered >= state.questions.length) return resumeAt(firstUnanswered);
  state.current = firstUnanswered;
  renderQuestion();
  show("quiz");
  prefetch();
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
        saveProgress();
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
  clearProgress();
  $("btn-continue").hidden = true;
  $("confidence-line").hidden = true;
  setNarrativeStatus("idle"); // 停掉可能還在跳動的等待計時器
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
    ? `加測試煉 ${state.current - state.extendBase + 1} ／ ${state.total - state.extendBase}`
    : `試煉 ${state.current + 1} ／ ${state.total}`;
  $("progress-bar").style.width = `${(state.current / state.total) * 100}%`;
  $("question-text").textContent = q.question;
  $("btn-back").hidden = state.current === 0;

  const container = $("options");
  container.innerHTML = "";
  for (const option of q.options) {
    const btn = document.createElement("button");
    btn.className = "option";
    btn.textContent = option.text;
    // 回看時高亮已選過的答案
    if (state.answers[state.current] === option.id) btn.classList.add("selected");
    btn.addEventListener("click", () => pick(btn, option.id));
    container.appendChild(btn);
  }

  // 題目切換微轉場（重觸發淡入動畫）
  for (const el of [$("question-text"), container]) {
    el.classList.remove("q-fade");
    void el.offsetWidth;
    el.classList.add("q-fade");
  }
}

// 點擊回饋：亮起選中樣式、短暫停留後才前進（也防止連點）
let picking = false;

function pick(btn, optionId) {
  if (picking) return;
  picking = true;
  for (const b of $("options").children) b.classList.remove("selected");
  btn.classList.add("selected");
  setTimeout(() => {
    picking = false;
    choose(optionId);
  }, 180);
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
  saveProgress();
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
  setNarrativeStatus("idle"); // 回到答題畫面，停掉敘事等待計時器
  state.extended = true;
  state.extendBase = state.total;
  state.total += count;
  state.answers.push(...new Array(count).fill(null));
  saveProgress();
  resumeAt(state.extendBase, "DM 正在加開試煉……");
}

function goBack() {
  if (state.current > 0) {
    state.current -= 1;
    saveProgress();
    renderQuestion();
  }
}

// 放棄目前測驗，回到首頁
function goHome() {
  clearProgress();
  state.result = null;
  $("btn-continue").hidden = true;
  show("start");
}

async function submitAnswers() {
  showLoading("正在推演你的靈魂座標……", "統計你的作答");
  try {
    const result = await api("/api/result", { answers: answeredPayload() });
    if (!ALIGNMENTS[result.alignment]) {
      throw new Error("回傳的陣營代碼不正確");
    }
    state.result = result;
    clearProgress(); // 已完賽，清除續玩進度
    renderResult();
    show("result");
    requestNarrative(); // 敘事非同步載入，不擋結果顯示
  } catch (err) {
    showError(err.message, submitAnswers);
  }
}

// ─── 敘事（非同步）──────────────────────────────────────

let narrativeTimer = null;

function setNarrativeStatus(mode) {
  const status = $("narrative-status");
  const retry = $("btn-narrative-retry");
  if (narrativeTimer) {
    clearInterval(narrativeTimer);
    narrativeTimer = null;
  }
  if (mode === "writing") {
    status.hidden = false;
    retry.hidden = true;
    const startedAt = Date.now();
    const render = () => {
      const secs = Math.floor((Date.now() - startedAt) / 1000);
      status.innerHTML =
        '<span class="spinner" aria-hidden="true"></span>' +
        `DM 正在撰寫你的觀察報告……已等待 ${secs} 秒（通常需要 20～40 秒）`;
    };
    render();
    narrativeTimer = setInterval(render, 1000);
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

// 結果揭示動畫：掃描九宮格 → 減速 → 定格於陣營格金光綻放 → 名稱浮現
let revealSeq = 0;

function revealResult(cells, r) {
  const seq = ++revealSeq;
  const hitIdx = GRID_ORDER.indexOf(r.alignment);
  const nearIdx = r.secondary ? GRID_ORDER.indexOf(r.secondary.alignment) : -1;
  const nameEls = [$("result-name"), $("result-en"), $("result-title")];

  const applyFinal = (animated) => {
    if (seq !== revealSeq) return;
    cells.forEach((c) => c.classList.remove("scan"));
    cells[hitIdx].classList.add("hit");
    if (animated) cells[hitIdx].classList.add("reveal-pop");
    if (nearIdx >= 0) cells[nearIdx].classList.add("near");
    nameEls.forEach((el) => {
      el.classList.remove("pre-reveal");
      if (animated) {
        el.classList.remove("name-reveal");
        void el.offsetWidth;
        el.classList.add("name-reveal");
      }
    });
  };

  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return applyFinal(false);
  }

  nameEls.forEach((el) => el.classList.add("pre-reveal"));

  // 一整圈 + 掃到陣營格為止；末段逐步減速
  const order = [];
  for (let i = 0; i < 9; i++) order.push(i);
  for (let i = 0; i <= hitIdx; i++) order.push(i);

  let t = 200;
  let delay = 65;
  order.forEach((idx, n) => {
    const isLast = n === order.length - 1;
    setTimeout(() => {
      if (seq !== revealSeq) return;
      cells.forEach((c) => c.classList.remove("scan"));
      if (isLast) applyFinal(true);
      else cells[idx].classList.add("scan");
    }, t);
    if (order.length - n <= 6) delay += 40; // 最後六步減速
    t += delay;
  });
}

function renderResult() {
  const r = state.result;
  const meta = ALIGNMENTS[r.alignment];

  $("result-name").textContent = meta.zh;
  $("result-en").textContent = meta.en;
  $("result-title").textContent = `—— ${meta.title} ——`;
  $("result-examples").textContent = meta.examples;

  // 重置分享圖卡（新結果需重新產生）
  $("card-preview").hidden = true;
  $("btn-card").textContent = "產生分享圖卡";

  // 敘事由 /api/narrative 非同步載入：先顯示撰寫中狀態
  $("block-analysis").hidden = false;
  $("result-analysis").textContent = "";
  $("block-tips").hidden = true;
  $("result-tips").innerHTML = "";

  const grid = $("result-grid");
  grid.innerHTML = "";
  const secMeta = r.secondary && ALIGNMENTS[r.secondary.alignment];
  grid.setAttribute("role", "img");
  grid.setAttribute(
    "aria-label",
    `九宮格陣營表，你的陣營：${meta.zh}${secMeta ? `，一步之遙：${secMeta.zh}` : ""}`
  );
  const cells = [];
  for (const key of GRID_ORDER) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.textContent = ALIGNMENTS[key].zh;
    if (ALIGNMENTS[key].hint) cell.dataset.hint = ALIGNMENTS[key].hint;
    grid.appendChild(cell);
    cells.push(cell);
  }
  revealResult(cells, r); // 開獎動畫（reduced-motion 直接定格）

  // 回顧你的選擇（含加測題）
  const review = $("review-list");
  review.innerHTML = "";
  state.questions.forEach((q, i) => {
    if (state.answers[i] == null) return;
    const chosen = q.options.find((o) => o.id === state.answers[i]);
    if (!chosen) return;
    const li = document.createElement("li");
    const qDiv = document.createElement("div");
    qDiv.className = "review-q";
    qDiv.textContent = q.question;
    const aDiv = document.createElement("div");
    aDiv.className = "review-a";
    aDiv.textContent = `➤ ${chosen.text}`;
    li.append(qDiv, aDiv);
    review.appendChild(li);
  });

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

const SHARE_LABEL = navigator.share ? "分享結果" : "複製結果";

function trackShare() {
  // 匿名事件計數（fire-and-forget，失敗無妨）
  fetch("/api/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "copy_result" }),
    keepalive: true,
  }).catch(() => {});
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
  text += `\n\n來測你的 D&D 陣營 → ${location.origin}`;

  // 行動裝置優先用原生分享面板
  if (navigator.share) {
    try {
      await navigator.share({ title: "陣營羅盤 Alignment Compass", text });
      trackShare();
      return;
    } catch (err) {
      if (err.name === "AbortError") return; // 使用者取消，不降級
      // 其他錯誤 → 退回複製
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    $("btn-copy").textContent = "已複製 ✓";
    setTimeout(() => ($("btn-copy").textContent = SHARE_LABEL), 2000);
    trackShare();
  } catch {
    $("btn-copy").textContent = "複製失敗";
  }
}

// ─── 分享圖卡（Canvas 繪製，1080×1350）──────────────────

const CARD = {
  W: 1080,
  H: 1420,
  bg: "#171210",
  bgHi: "#2a2015",
  card: "#1e1813",
  ink: "#e8ddc8",
  dim: "#9c8e74",
  gold: "#c9a24b",
  goldBright: "#e6c26e",
  border: "#3a2f22",
  serif: '"Songti TC", "Noto Serif TC", "Iowan Old Style", Georgia, serif', // 與網站 --serif 一致
};

function loadLogo() {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // 載入失敗就不畫 logo
    img.src = "logo.jpg";
  });
}

// 只取 logo 的羅盤本體（原圖下方帶文字，避免與卡片標題重複），並做放射狀淡出
function fadedLogo(img, size) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const x = c.getContext("2d");
  // 原圖 1254×1254：羅盤約位於 (207, 50) 起的 840×840 區域
  const s = img.naturalWidth / 1254;
  x.drawImage(img, 207 * s, 50 * s, 840 * s, 840 * s, 0, 0, size, size);
  const g = x.createRadialGradient(size / 2, size / 2, size * 0.3, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(0,0,0,1)");
  g.addColorStop(0.72, "rgba(0,0,0,1)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  x.globalCompositeOperation = "destination-in";
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  return c;
}

function cardText(ctx, text, x, y, { size, color, weight = 400, spacing = 0, align = "center" }) {
  ctx.font = `${weight} ${size}px ${CARD.serif}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  if (spacing > 0) ctx.letterSpacing = `${spacing}px`;
  ctx.fillText(text, x, y);
  ctx.letterSpacing = "0px";
}

function drawCardAxis(ctx, y, negLabel, posLabel, score, descText) {
  const barX = 220;
  const barW = CARD.W - barX * 2;
  const barH = 10;

  cardText(ctx, negLabel, barX - 24, y, { size: 30, color: CARD.dim, align: "right" });
  cardText(ctx, posLabel, barX + barW + 24, y, { size: 30, color: CARD.dim, align: "left" });

  // 三區段軌道（門檻 ±20 → 40%/60%）
  ctx.fillStyle = CARD.border;
  ctx.beginPath();
  ctx.roundRect(barX, y - barH / 2, barW, barH, barH / 2);
  ctx.fill();
  ctx.fillStyle = "#4a3d29";
  ctx.fillRect(barX + barW * 0.4, y - barH / 2, barW * 0.2, barH);
  ctx.fillStyle = "rgba(201,162,75,0.55)";
  ctx.fillRect(barX + barW * 0.4 - 1, y - barH / 2, 2, barH);
  ctx.fillRect(barX + barW * 0.6 - 1, y - barH / 2, 2, barH);

  // 分數標記
  const px = barX + barW * Math.min(1, Math.max(0, (score + 100) / 200));
  ctx.beginPath();
  ctx.arc(px, y, 13, 0, Math.PI * 2);
  ctx.fillStyle = CARD.goldBright;
  ctx.shadowColor = "rgba(230,194,110,0.6)";
  ctx.shadowBlur = 14;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 3;
  ctx.strokeStyle = CARD.bg;
  ctx.stroke();

  cardText(ctx, descText, CARD.W / 2, y + 40, { size: 26, color: CARD.dim });
}

async function makeShareCard() {
  const r = state.result;
  const meta = ALIGNMENTS[r.alignment];
  const canvas = document.createElement("canvas");
  canvas.width = CARD.W;
  canvas.height = CARD.H;
  const ctx = canvas.getContext("2d");
  await document.fonts.ready;

  // 背景與頂部光暈
  ctx.fillStyle = CARD.bg;
  ctx.fillRect(0, 0, CARD.W, CARD.H);
  const glow = ctx.createRadialGradient(CARD.W / 2, -80, 60, CARD.W / 2, -80, 700);
  glow.addColorStop(0, CARD.bgHi);
  glow.addColorStop(1, "rgba(42,32,21,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, CARD.W, 760);

  // 外框與角落飾線
  ctx.strokeStyle = "rgba(201,162,75,0.35)";
  ctx.lineWidth = 2;
  ctx.strokeRect(28, 28, CARD.W - 56, CARD.H - 56);
  ctx.strokeStyle = "rgba(201,162,75,0.7)";
  ctx.lineWidth = 3;
  for (const [cx, cy, dx, dy] of [
    [44, 44, 1, 1], [CARD.W - 44, 44, -1, 1],
    [44, CARD.H - 44, 1, -1], [CARD.W - 44, CARD.H - 44, -1, -1],
  ]) {
    ctx.beginPath();
    ctx.moveTo(cx + dx * 26, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + dy * 26);
    ctx.stroke();
  }

  // Logo（放射淡出）
  const logo = await loadLogo();
  if (logo) ctx.drawImage(fadedLogo(logo, 230), CARD.W / 2 - 115, 62);

  cardText(ctx, "陣營羅盤 ALIGNMENT COMPASS", CARD.W / 2, 330, {
    size: 26, color: CARD.dim, spacing: 6,
  });
  cardText(ctx, "我的陣營是", CARD.W / 2, 396, { size: 30, color: CARD.dim });
  cardText(ctx, meta.zh, CARD.W / 2, 494, { size: 104, color: CARD.goldBright, weight: 700 });
  cardText(ctx, meta.en, CARD.W / 2, 572, { size: 34, color: CARD.dim, spacing: 3 });
  cardText(ctx, `—— ${meta.title} ——`, CARD.W / 2, 626, { size: 34, color: CARD.gold });

  // 3×3 陣營表
  const cellW = 260;
  const cellH = 106;
  const gap = 14;
  const gridX = (CARD.W - cellW * 3 - gap * 2) / 2;
  const gridY = 688;
  GRID_ORDER.forEach((key, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = gridX + col * (cellW + gap);
    const y = gridY + row * (cellH + gap);
    const hit = key === r.alignment;
    const near = r.secondary && key === r.secondary.alignment;

    if (hit) {
      const grad = ctx.createLinearGradient(0, y, 0, y + cellH);
      grad.addColorStop(0, "#3a2d17");
      grad.addColorStop(1, "#2b2010");
      ctx.fillStyle = grad;
      ctx.shadowColor = "rgba(201,162,75,0.5)";
      ctx.shadowBlur = 22;
    } else {
      ctx.fillStyle = CARD.card;
      ctx.shadowBlur = 0;
    }
    ctx.beginPath();
    ctx.roundRect(x, y, cellW, cellH, 8);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = hit ? 3 : 1.5;
    ctx.strokeStyle = hit
      ? CARD.goldBright
      : near
        ? "rgba(201,162,75,0.5)"
        : CARD.border;
    ctx.stroke();

    cardText(ctx, ALIGNMENTS[key].zh, x + cellW / 2, y + cellH / 2 + 2, {
      size: hit ? 40 : 32,
      color: hit ? CARD.goldBright : near ? CARD.gold : CARD.dim,
      weight: hit ? 700 : 400,
    });
  });

  // 兩軸
  drawCardAxis(ctx, 1120, "混亂", "守序", r.lawScore, `秩序軸：${axisText(r.lawScore, "守序", "混亂")}`);
  drawCardAxis(ctx, 1216, "邪惡", "善良", r.goodScore, `道德軸：${axisText(r.goodScore, "善良", "邪惡")}`);

  // 信心與次要陣營
  let infoLine = `判定信心 ${r.confidence}%（${r.level}）`;
  const secMeta = r.secondary && ALIGNMENTS[r.secondary.alignment];
  if (secMeta) infoLine += `　・　一步之遙：${secMeta.zh}`;
  cardText(ctx, infoLine, CARD.W / 2, 1296, { size: 26, color: CARD.dim });

  cardText(ctx, `來測你的 D&D 陣營 → ${location.host}`, CARD.W / 2, 1352, {
    size: 27, color: CARD.gold,
  });

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("圖卡產生失敗"))), "image/png");
  });
}

let cardObjectUrl = null;

async function generateCard() {
  const btn = $("btn-card");
  btn.disabled = true;
  btn.textContent = "繪製中…";
  try {
    const blob = await makeShareCard();

    // 預覽
    if (cardObjectUrl) URL.revokeObjectURL(cardObjectUrl);
    cardObjectUrl = URL.createObjectURL(blob);
    $("card-img").src = cardObjectUrl;
    $("card-preview").hidden = false;

    const file = new File([blob], "alignment-compass.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      $("card-hint").textContent = "";
      try {
        await navigator.share({ files: [file], title: "陣營羅盤 Alignment Compass" });
      } catch (err) {
        /* 使用者取消分享沒關係，預覽已顯示 */
      }
    } else {
      // 桌機：自動下載
      const a = document.createElement("a");
      a.href = cardObjectUrl;
      a.download = "alignment-compass.png";
      a.click();
      $("card-hint").textContent = "圖卡已下載，也可以長按/右鍵上方預覽另存";
    }
    fetch("/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "share_card" }),
      keepalive: true,
    }).catch(() => {});
    btn.textContent = "重新產生圖卡";
  } catch (err) {
    btn.textContent = "產生失敗，再試一次";
  } finally {
    btn.disabled = false;
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
$("btn-continue").addEventListener("click", continueQuiz);
$("btn-back").addEventListener("click", goBack);
$("btn-abandon").addEventListener("click", () => {
  if (confirm("要放棄這場測驗嗎？目前的作答不會保留。")) goHome();
});
$("btn-home").addEventListener("click", goHome);
$("btn-extend").addEventListener("click", extendQuiz);
$("btn-narrative-retry").addEventListener("click", requestNarrative);

// 鍵盤作答：答題畫面按 1~4 選擇選項
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!$("screen-quiz").classList.contains("active")) return;
  const n = Number(e.key);
  if (n >= 1 && n <= 4) {
    const btn = $("options").children[n - 1];
    if (btn) btn.click();
  }
});

// 開場時偵測未完成的測驗，提供續玩
if (loadProgress()) $("btn-continue").hidden = false;

// 分享按鈕依裝置能力顯示對應文案
$("btn-copy").textContent = SHARE_LABEL;
$("btn-restart").addEventListener("click", startQuiz);
$("btn-copy").addEventListener("click", copyResult);
$("btn-card").addEventListener("click", generateCard);
$("btn-retry").addEventListener("click", () => {
  if (state.retryAction) state.retryAction();
});

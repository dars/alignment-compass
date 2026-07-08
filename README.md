# 陣營羅盤 Alignment Compass

D&D 九大陣營個性測驗網站。題目由本地 LLM（Ollama）逐題即時生成，每個選項在生成時即由模型標注對應陣營；最終陣營由 server 端統計判定，AI 只負責撰寫個人化的「DM 觀察」敘事——判定穩定、敘事有趣。

## 架構

```
瀏覽器（public/ 靜態頁面）
   │  POST /api/question     ← 逐題生成（前端背景預取下一題）
   │  POST /api/progress     ← 答題中的即時判定信心指數
   │  POST /api/result       ← 送出作答，統計 + AI 敘事
   ▼
api/*.js（serverless functions；本機由 server.js 轉接）
   ▼
Ollama /api/chat（structured outputs，JSON Schema）
```

設計重點：

- **無狀態（serverless-ready）**：沒有 server session。每題的隱藏資料（選項的 `alignment`／`confidence`）以 AES-256-GCM 加密成 token 交由前端持有、答題時原樣帶回；GCM 認證標籤防竄改，題號防重複，token 兩小時過期。玩家在 DevTools 只看得到密文。
- **逐題生成**：單題等待時間短（qwen3:8b 約 15~21 秒），前端在玩家作答時背景預取下一題。
- **統計判定，AI 敘事**：陣營代碼映射 (law, good) 座標、confidence 加權平均得兩軸分數（±100，|分數| ≤ 20 為中立帶）；判定信心指數 = 進度 ×（55% 分數扎實度 + 45% 作答一致性）。敘事失敗不影響判定結果。
- **多層輸出防護**：選項陣營相異驗證（重試最多 4 次）、控制符／選項列表／schema 欄位名／陣營標注洩漏的偵測與清洗、跨題主題與情境去重。

## 本機開發

需要 Node.js 18+ 與一台跑著 Ollama 的機器。

```sh
npm install            # 無任何外部依賴
cp .env.example .env   # 填入你的 Ollama 位置
npm start              # server.js：靜態檔案 + 轉接 api/ handlers
```

開啟 http://localhost:3000 即可遊玩。

## 部署到 Vercel

1. Vercel 上 Import 這個 GitHub repo（零 build 設定，`vercel.json` 已含 `maxDuration: 60`）
2. 在專案的 **Environment Variables** 設定：

| 變數 | 必填 | 說明 |
|---|---|---|
| `OLLAMA_URL` | ✅ | 公開可達的 Ollama chat 端點（例如 Cloudflare tunnel） |
| `OLLAMA_MODEL` | | 預設 `qwen3:8b` |
| `SESSION_SECRET` | ✅ | token 加密密鑰（任意長隨機字串）。未設定時每個實例各自隨機生成，多實例下進行中的測驗會失效 |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | 建議 | Cloudflare Access Service Token；設定後所有對 Ollama 的請求會帶上對應 header |
| `QUESTION_COUNT` | | 每場題數，預設 12 |

注意：出題含重試最壞情況可能超過 60 秒（Hobby 方案函式上限），此時前端會自動重試該題。

### 其他環境變數

| 變數 | 預設值 | 說明 |
|---|---|---|
| `LLM_TIMEOUT_MS` | `300000` | 單次 LLM 請求逾時（毫秒，本機用；Vercel 受 maxDuration 限制） |
| `PORT` | `3000` | 本機開發埠號 |

## API

| 端點 | 方法 | 說明 |
|---|---|---|
| `/api/question` | POST | 傳入 `{prev: [先前題目的 token]}`，回傳 `{index, total, question, options: [{id, text}], token}` |
| `/api/progress` | POST | 傳入 `{answers: [{token, choice}]}`（已答部分），回傳 `{answered, total, confidence, level}` |
| `/api/result` | POST | 傳入 `{answers: [{token, choice}]}`（全部），回傳 `{alignment, lawScore, goodScore, confidence, level, analysis, roleplayTips}` |

`alignment` 為九大陣營代碼：`LG`/`NG`/`CG`/`LN`/`TN`/`CN`/`LE`/`NE`/`CE`（True Neutral 用 `TN`）。

## 專案結構

```
api/        serverless functions（Vercel 直接載入）
lib/        共用邏輯：config / quiz（prompt、生成、計分）/ token（加密）/ answers / http
public/     靜態前端
server.js   本機開發伺服器（靜態檔案 + 轉接 api/）
designs/    logo 與 favicon 原始檔
```

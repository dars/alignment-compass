# 陣營羅盤 Alignment Compass

D&D 九大陣營個性測驗網站。題目由本地 LLM（Ollama）逐題即時生成，每個選項在生成時即由模型標注對應陣營；最終陣營由 server 端統計判定，AI 只負責撰寫個人化的「DM 觀察」敘事——判定穩定、敘事有趣。

## 架構

```
瀏覽器（public/ 靜態頁面）
   │  POST /api/session                  ← 建立測驗場次
   │  POST /api/session/:id/question     ← 逐題生成（前端背景預取下一題）
   │  POST /api/session/:id/result       ← 送出作答，統計 + AI 敘事
   ▼
server.js（Node.js，零依賴）
   ▼
Ollama /api/chat（structured outputs，JSON Schema）
```

設計重點：

- **逐題生成**：單題等待時間短（gemma4:e2b 約 8~12 秒），前端在玩家作答時背景預取下一題，體感幾乎無等待。
- **選項預標陣營**：出題時每個選項帶 `alignment`（九大陣營代碼）與 `confidence`（0~1）。這些標注只留在 server 端 session，不會送到瀏覽器，玩家無法從 DevTools 看到答案。
- **統計判定，AI 敘事**：陣營代碼映射為 (law, good) 座標，依 confidence 加權平均得兩軸分數（-100~100，|分數| ≤ 20 為中立帶），直接得出陣營；再用低溫度呼叫請模型撰寫分析與扮演建議。敘事失敗不影響判定結果。
- **server 端驗證**：四個選項陣營必須相異（重試最多 3 次，末次放寬為至少 3 種）；出題 prompt 會帶入已出過的主題與情境摘要避免重複；並清洗小模型常見的編號前綴等雜訊。

## 啟動

需要 Node.js 18+ 與一台跑著 Ollama 的機器。

```sh
npm install   # 無任何外部依賴，此步驟只是建立 lockfile
cp .env.example .env   # 填入你的 Ollama 位置
npm start
```

開啟 http://localhost:3000 即可遊玩。

### 環境變數

可放在專案根目錄的 `.env`（不進版控），或直接由環境帶入（環境變數優先於 `.env`）。部署平台（如 Vercel）則設定在平台的環境變數介面。

| 變數 | 預設值 | 說明 |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434/api/chat` | Ollama chat 端點 |
| `OLLAMA_MODEL` | `qwen3:8b` | Ollama 模型名稱 |
| `QUESTION_COUNT` | `12` | 每場測驗題數 |
| `LLM_TIMEOUT_MS` | `300000` | 單次 LLM 請求逾時（毫秒） |
| `PORT` | `3000` | 網站埠號 |

## API

| 端點 | 方法 | 說明 |
|---|---|---|
| `/api/session` | POST | 建立場次，回傳 `{id, total}` |
| `/api/session/:id/question` | POST | 生成下一題，回傳 `{index, total, question, options: [{id, text}]}`；生成中重複呼叫回 409 |
| `/api/session/:id/result` | POST | 傳入 `{choices: ["A", ...]}`（依題序），回傳 `{alignment, lawScore, goodScore, analysis, roleplayTips}` |

`alignment` 為九大陣營代碼：`LG`/`NG`/`CG`/`LN`/`TN`/`CN`/`LE`/`NE`/`CE`（True Neutral 用 `TN`）。場次保存於記憶體、60 分鐘過期，結算後即刪除。

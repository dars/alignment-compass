import { readFileSync } from "node:fs";
import path from "node:path";

// 本機開發讀取專案根目錄 .env；部署平台（Vercel）由平台環境變數提供。
// 已存在的環境變數優先於 .env。
try {
  const envFile = readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

export const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/api/chat";
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:8b";
export const QUESTION_COUNT = Number(process.env.QUESTION_COUNT || 12);
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 300_000);

// 加密測驗 token 用的密鑰；未設定時每次啟動隨機生成（多實例部署必須設定）
export const SESSION_SECRET = process.env.SESSION_SECRET || "";

// Cloudflare Access Service Token（保護公開的 Ollama tunnel 時設定）
export const CF_ACCESS_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID || "";
export const CF_ACCESS_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET || "";

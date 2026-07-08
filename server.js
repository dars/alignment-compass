// 本機開發伺服器：靜態檔案 + 轉接 api/ 下的 serverless handlers
// （Vercel 部署時不使用此檔，由平台直接載入 api/*.js 與 public/）
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import questionHandler from "./api/question.js";
import progressHandler from "./api/progress.js";
import resultHandler from "./api/result.js";
import narrativeHandler from "./api/narrative.js";
import refillHandler from "./api/refill.js";
import { OLLAMA_URL, OLLAMA_MODEL, QUESTION_COUNT } from "./lib/config.js";
import { kvEnabled } from "./lib/pool.js";
import { sendJson } from "./lib/http.js";

const PORT = process.env.PORT || 3000;
const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "public");

const ROUTES = {
  "/api/question": questionHandler,
  "/api/progress": progressHandler,
  "/api/result": resultHandler,
  "/api/narrative": narrativeHandler,
  "/api/refill": refillHandler,
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  const urlPath = new URL(req.url, "http://localhost").pathname;

  const handler = ROUTES[urlPath];
  if (handler) return handler(req, res);

  if (req.method === "GET" || req.method === "HEAD") {
    return serveStatic(urlPath, res);
  }
  sendJson(res, 404, { error: "Not found" });
});

async function serveStatic(urlPath, res) {
  const relative = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).slice(1);
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
  console.log(`題目池：${kvEnabled ? "已啟用（KV）" : "未設定 KV，一律現場生成"}`);
});

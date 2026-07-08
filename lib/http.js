export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

// 同時支援 Vercel（可能已解析 req.body）與原生 node:http（讀 stream）
export async function readJson(req, maxBytes = 200_000) {
  if (req.body !== undefined) {
    if (typeof req.body === "string") {
      try {
        return JSON.parse(req.body || "{}");
      } catch {
        throw new HttpError(400, "JSON 格式不正確");
      }
    }
    return req.body ?? {};
  }
  const raw = await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > maxBytes) {
        reject(new HttpError(413, "請求內容過大"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new HttpError(400, "JSON 格式不正確");
  }
}

export function handleError(res, err) {
  const e = err instanceof HttpError ? err : new HttpError(500, "伺服器內部錯誤");
  if (e.status >= 500) console.error(err);
  sendJson(res, e.status, { error: e.message });
}

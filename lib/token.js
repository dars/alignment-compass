import crypto from "node:crypto";
import { SESSION_SECRET } from "./config.js";
import { HttpError } from "./http.js";
import { track } from "./stats.js";

// 無狀態測驗 token：題目的隱藏資料（選項陣營、confidence）以 AES-256-GCM
// 加密後交由前端持有、原樣帶回。前端只看得到密文，GCM 認證標籤防竄改。
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

let secret = SESSION_SECRET;
if (!secret) {
  secret = crypto.randomBytes(32).toString("hex");
  console.warn(
    "未設定 SESSION_SECRET：使用隨機臨時密鑰。重啟或多實例部署（如 Vercel）會使進行中的測驗失效，正式環境請務必設定。"
  );
}
const KEY = crypto.createHash("sha256").update(secret).digest();

export function seal(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify({ ...payload, iat: Date.now() }), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}

export function unseal(token) {
  try {
    const buf = Buffer.from(String(token), "base64url");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
    decipher.setAuthTag(tag);
    const payload = JSON.parse(
      Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
    );
    if (!payload.iat || Date.now() - payload.iat > TOKEN_TTL_MS) {
      throw new Error("expired");
    }
    return payload;
  } catch {
    track("token_invalid"); // 竄改或過期
    throw new HttpError(400, "測驗資料無效或已過期，請重新開始");
  }
}

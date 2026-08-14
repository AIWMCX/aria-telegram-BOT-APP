import crypto from "node:crypto";
import { CONFIG } from "./config.js";

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface VerifiedInitData {
  user: TelegramUser;
  auth_date: number;
}

const secretKey = crypto.createHmac("sha256", "WebAppData").update(CONFIG.TELEGRAM_BOT_TOKEN).digest();
const MAX_AGE_SECONDS = 60 * 60 * 24;

export function verifyInitData(initData: string): VerifiedInitData | null {
  if (!initData || typeof initData !== "string") return null;

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return null;
  params.delete("hash");

  const pairs: string[] = [];
  for (const key of Array.from(params.keys()).sort()) {
    pairs.push(`${key}=${params.get(key)}`);
  }
  const dataCheckString = pairs.join("\n");

  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (
    computedHash.length !== receivedHash.length ||
    !crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(receivedHash))
  ) {
    return null;
  }

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate)) return null;
  if (Math.floor(Date.now() / 1000) - authDate > MAX_AGE_SECONDS) return null;

  const userJson = params.get("user");
  if (!userJson) return null;
  let user: TelegramUser;
  try {
    user = JSON.parse(userJson);
  } catch {
    return null;
  }
  if (!user.id || typeof user.id !== "number") return null;

  return { user, auth_date: authDate };
}

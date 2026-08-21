import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ENGINE_HEADERS = { credential: "x-engine-credential", timestamp: "x-engine-timestamp", nonce: "x-engine-nonce", bodyHash: "x-engine-body-sha256", signature: "x-engine-signature" } as const;
export interface RequestHeaders { [name: string]: string; }
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function bodyHash(body: string): string { return createHash("sha256").update(body, "utf8").digest("hex"); }
function canonical(method: string, path: string, timestampMs: number, nonce: string, digest: string): string { return `${method.toUpperCase()}\n${path}\n${timestampMs}\n${nonce}\n${digest}`; }
function signature(credential: string, value: string): string { return createHmac("sha256", credential).update(value, "utf8").digest("hex"); }

export function signEngineRequest(credential: string, method: string, path: string, body: string, timestampMs = Date.now(), nonce = randomBytes(18).toString("base64url")): RequestHeaders {
  const digest = bodyHash(body);
  return { [ENGINE_HEADERS.credential]: credential, [ENGINE_HEADERS.timestamp]: String(timestampMs), [ENGINE_HEADERS.nonce]: nonce, [ENGINE_HEADERS.bodyHash]: digest, [ENGINE_HEADERS.signature]: signature(credential, canonical(method, path, timestampMs, nonce, digest)) };
}

export function verifySignedRequest(headers: Headers, method: string, path: string, body: string, nowMs = Date.now()): { credential: string; timestampMs: number; nonce: string } | null {
  const credential = headers.get(ENGINE_HEADERS.credential);
  const timestampRaw = headers.get(ENGINE_HEADERS.timestamp);
  const nonce = headers.get(ENGINE_HEADERS.nonce);
  const receivedHash = headers.get(ENGINE_HEADERS.bodyHash);
  const receivedSignature = headers.get(ENGINE_HEADERS.signature);
  if (!credential || !timestampRaw || !nonce || !receivedHash || !receivedSignature || !/^[A-Za-z0-9_-]{16,256}$/.test(credential) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return null;
  const timestampMs = Number(timestampRaw);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(nowMs - timestampMs) > MAX_CLOCK_SKEW_MS) return null;
  const expectedHash = bodyHash(body);
  if (receivedHash.length !== expectedHash.length || !timingSafeEqual(Buffer.from(receivedHash), Buffer.from(expectedHash))) return null;
  const expectedSignature = signature(credential, canonical(method, path, timestampMs, nonce, expectedHash));
  if (receivedSignature.length !== expectedSignature.length || !timingSafeEqual(Buffer.from(receivedSignature), Buffer.from(expectedSignature))) return null;
  return { credential, timestampMs, nonce };
}

export const ENGINE_CLOCK_SKEW_MS = MAX_CLOCK_SKEW_MS;

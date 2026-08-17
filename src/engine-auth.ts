import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { EngineStore, Device } from "./engine-store.js";
import { engineStore } from "./engine-store.js";

export const ENGINE_HEADERS = {
  credential: "x-engine-credential",
  timestamp: "x-engine-timestamp",
  nonce: "x-engine-nonce",
  bodyHash: "x-engine-body-sha256",
  signature: "x-engine-signature",
} as const;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface RequestHeaders { [name: string]: string; }
export interface VerifiedDevice { device: Device; timestampMs: number; nonce: string; }

function bodyHash(body: string): string { return createHash("sha256").update(body, "utf8").digest("hex"); }
function canonical(method: string, path: string, timestampMs: number, nonce: string, bodyDigest: string): string {
  return `${method.toUpperCase()}\n${path}\n${timestampMs}\n${nonce}\n${bodyDigest}`;
}
function signature(credential: string, canonicalRequest: string): string {
  return createHmac("sha256", credential).update(canonicalRequest, "utf8").digest("hex");
}

export function signEngineRequest(credential: string, method: string, path: string, body: string, timestampMs = Date.now(), nonce = cryptoRandomNonce()): RequestHeaders {
  const digest = bodyHash(body);
  return {
    [ENGINE_HEADERS.credential]: credential,
    [ENGINE_HEADERS.timestamp]: String(timestampMs),
    [ENGINE_HEADERS.nonce]: nonce,
    [ENGINE_HEADERS.bodyHash]: digest,
    [ENGINE_HEADERS.signature]: signature(credential, canonical(method, path, timestampMs, nonce, digest)),
  };
}

function cryptoRandomNonce(): string {
  return randomBytes(18).toString("base64url");
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
  const expectedBodyHash = bodyHash(body);
  if (receivedHash.length !== expectedBodyHash.length || !timingSafeEqual(Buffer.from(receivedHash), Buffer.from(expectedBodyHash))) return null;
  const expectedSignature = signature(credential, canonical(method, path, timestampMs, nonce, expectedBodyHash));
  if (receivedSignature.length !== expectedSignature.length || !timingSafeEqual(Buffer.from(receivedSignature), Buffer.from(expectedSignature))) return null;
  return { credential, timestampMs, nonce };
}

export async function authenticateEngineRequest(headers: Headers, method: string, path: string, body: string, store: EngineStore | null = engineStore): Promise<VerifiedDevice | null> {
  const signed = verifySignedRequest(headers, method, path, body);
  if (!signed || !store) return null;
  const device = await store.getDeviceByCredentialHash(signed.credential);
  if (!device) return null;
  const accepted = await store.consumeNonce(device.id, signed.nonce, new Date(signed.timestampMs + MAX_CLOCK_SKEW_MS));
  return accepted ? { device, timestampMs: signed.timestampMs, nonce: signed.nonce } : null;
}

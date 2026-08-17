import type { EngineStore, Device } from "./engine-store.js";
import { engineStore } from "./engine-store.js";
import { ENGINE_CLOCK_SKEW_MS, signEngineRequest, verifySignedRequest, ENGINE_HEADERS, type RequestHeaders } from "../engine/src/protocol.js";

export { ENGINE_HEADERS, signEngineRequest, verifySignedRequest };
export type { RequestHeaders };
export interface VerifiedDevice { device: Device; timestampMs: number; nonce: string; }

export async function authenticateEngineRequest(headers: Headers, method: string, path: string, body: string, store: EngineStore | null = engineStore): Promise<VerifiedDevice | null> {
  const signed = verifySignedRequest(headers, method, path, body);
  if (!signed || !store) return null;
  const device = await store.getDeviceByCredentialHash(signed.credential);
  if (!device) return null;
  const accepted = await store.consumeNonce(device.id, signed.nonce, new Date(signed.timestampMs + ENGINE_CLOCK_SKEW_MS));
  return accepted ? { device, timestampMs: signed.timestampMs, nonce: signed.nonce } : null;
}

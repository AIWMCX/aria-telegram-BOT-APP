import { signEngineRequest } from "./protocol.js";
import type { EngineCommand, SanitizedEvent, SanitizedHeartbeat } from "./contracts.js";

export interface EngineTransport { (url: string, init: RequestInit): Promise<Response>; }

export class AuthenticatedClient {
  constructor(private readonly apiUrl: string, private readonly credential: string, private readonly transport: EngineTransport = fetch) {
    if (new URL(apiUrl).protocol !== "https:") throw new Error("engine API must use HTTPS");
  }
  private async request<T>(method: string, path: string, payload: unknown = null): Promise<T> {
    const body = method === "GET" ? "" : JSON.stringify(payload);
    const headers = signEngineRequest(this.credential, method, path, body);
    const response = await this.transport(new URL(path, this.apiUrl).toString(), { method, headers: { ...headers, "content-type": "application/json" }, body: method === "GET" ? undefined : body });
    const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string } & T;
    if (!response.ok || data.ok !== true) throw new Error("engine API request failed");
    return data;
  }
  async heartbeat(heartbeat: SanitizedHeartbeat): Promise<void> { await this.request("POST", "/api/engine/heartbeat", heartbeat); }
  async events(events: SanitizedEvent[]): Promise<void> { if (events.length) await this.request("POST", "/api/engine/events", { events }); }
  async commands(): Promise<EngineCommand[]> { const result = await this.request<{ commands: EngineCommand[] }>("GET", "/api/engine/commands"); return result.commands; }
  async acknowledge(commandId: string, accepted: boolean, reason?: string): Promise<void> { await this.request("POST", `/api/engine/commands/${encodeURIComponent(commandId)}/ack`, { accepted, reason }); }
}

export async function exchangePairingCode(apiUrl: string, code: string, transport: EngineTransport = fetch): Promise<{ deviceId: string; credential: string }> {
  if (new URL(apiUrl).protocol !== "https:") throw new Error("engine API must use HTTPS");
  const response = await transport(new URL("/api/engine/pairing/exchange", apiUrl).toString(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const result = await response.json().catch(() => ({})) as { ok?: boolean; deviceId?: string; credential?: string };
  if (!response.ok || result.ok !== true || !result.deviceId || !result.credential) throw new Error("pairing exchange failed");
  return { deviceId: result.deviceId, credential: result.credential };
}

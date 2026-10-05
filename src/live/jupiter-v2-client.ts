import { z } from "zod";

const DEFAULT_BASE_URL = "https://api.jup.ag/swap/v2";
const DEFAULT_TIMEOUT_MS = 5_000;

const DecimalString = z.string().regex(/^\d+$/, "expected decimal integer string");
const Base58Address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "invalid Solana address");

const JupiterOrderResponseSchema = z.object({
  transaction: z.string().nullable(),
  requestId: z.string().min(1),
  inAmount: DecimalString.optional(),
  outAmount: DecimalString,
  router: z.string().min(1),
  mode: z.string().min(1),
  feeBps: z.number().int().nonnegative(),
  feeMint: z.string().min(1),
  errorCode: z.number().int().optional(),
  errorMessage: z.string().optional(),
  lastValidBlockHeight: z.number().int().nonnegative().optional(),
  expireAt: z.number().int().nonnegative().optional(),
}).passthrough();

const JupiterExecuteResponseSchema = z.object({
  status: z.enum(["Success", "Failed"]),
  signature: z.string().optional().default(""),
  code: z.number().int(),
  totalInputAmount: DecimalString.optional(),
  totalOutputAmount: DecimalString.optional(),
  inputAmountResult: DecimalString.optional(),
  outputAmountResult: DecimalString.optional(),
  error: z.string().optional(),
}).passthrough();

export type JupiterOrderResponse = z.infer<typeof JupiterOrderResponseSchema>;
export type JupiterExecuteResponse = z.infer<typeof JupiterExecuteResponseSchema>;

export interface JupiterV2ClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface JupiterOrderRequest {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  taker: string;
  slippageBps: number;
  /** Optional explicit receiver. Omit to receive into the taker's wallet. */
  receiver?: string;
}

export type JupiterProviderFailureCode =
  | "NOT_CONFIGURED"
  | "INVALID_INPUT"
  | "TIMEOUT"
  | "HTTP_ERROR"
  | "INVALID_RESPONSE"
  | "ORDER_NOT_BUILDABLE"
  | "EXECUTE_REJECTED"
  | "EXECUTE_INDETERMINATE";

export type JupiterOrderResult =
  | { ok: true; order: JupiterOrderResponse; receivedAtMs: number }
  | { ok: false; code: JupiterProviderFailureCode; detail: string; httpStatus?: number; receivedAtMs: number };

export type JupiterExecuteResult =
  | { ok: true; execution: JupiterExecuteResponse; receivedAtMs: number }
  | { ok: false; code: JupiterProviderFailureCode; detail: string; httpStatus?: number; receivedAtMs: number };

function normalizeBaseUrl(raw: string): string {
  const u = new URL(raw);
  if (u.protocol !== "https:") throw new Error("Jupiter base URL must be https");
  return u.toString().replace(/\/$/, "");
}

function validateOrderRequest(input: JupiterOrderRequest): string | null {
  if (!Base58Address.safeParse(input.inputMint).success) return "invalid input mint";
  if (!Base58Address.safeParse(input.outputMint).success) return "invalid output mint";
  if (!Base58Address.safeParse(input.taker).success) return "invalid taker";
  if (input.receiver && !Base58Address.safeParse(input.receiver).success) return "invalid receiver";
  if (input.amountRaw <= 0n) return "amountRaw must be positive";
  if (!Number.isSafeInteger(input.slippageBps) || input.slippageBps < 1 || input.slippageBps > 5000) {
    return "slippageBps must be an integer in [1, 5000]";
  }
  return null;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Jupiter Swap V2 adapter for LIVE 0.1.
 *
 * This module does NOT sign anything and does NOT decide whether a trade is
 * permitted. It only obtains a route/assembled transaction and later submits
 * user-signed bytes to Jupiter's /execute endpoint.
 *
 * Transport ambiguity is represented explicitly. A timeout from /execute is
 * EXECUTE_INDETERMINATE, never "failed", because the request may have reached
 * Jupiter even when ARIA did not receive the response.
 */
export class JupiterV2Client {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JupiterV2ClientOptions) {
    this.apiKey = options.apiKey.trim();
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 250 || this.timeoutMs > 30_000) {
      throw new Error("Jupiter timeout must be an integer in [250, 30000] ms");
    }
  }

  async order(input: JupiterOrderRequest): Promise<JupiterOrderResult> {
    const receivedAtMs = Date.now();
    if (!this.apiKey) {
      return { ok: false, code: "NOT_CONFIGURED", detail: "Jupiter API key not configured", receivedAtMs };
    }
    const invalid = validateOrderRequest(input);
    if (invalid) return { ok: false, code: "INVALID_INPUT", detail: invalid, receivedAtMs };

    const params = new URLSearchParams({
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      amount: input.amountRaw.toString(),
      taker: input.taker,
      slippageBps: String(input.slippageBps),
    });
    if (input.receiver) params.set("receiver", input.receiver);

    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.fetchImpl,
        `${this.baseUrl}/order?${params.toString()}`,
        { method: "GET", headers: { "x-api-key": this.apiKey, accept: "application/json" } },
        this.timeoutMs,
      );
    } catch (err: any) {
      const timeout = err?.name === "AbortError";
      return {
        ok: false,
        code: timeout ? "TIMEOUT" : "HTTP_ERROR",
        detail: timeout ? "Jupiter /order timed out" : "Jupiter /order transport error",
        receivedAtMs: Date.now(),
      };
    }

    const body = await readJsonSafe(response);
    if (!response.ok) {
      return {
        ok: false,
        code: "HTTP_ERROR",
        detail: `Jupiter /order HTTP ${response.status}`,
        httpStatus: response.status,
        receivedAtMs: Date.now(),
      };
    }

    const parsed = JupiterOrderResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, code: "INVALID_RESPONSE", detail: "Jupiter /order response invalid", receivedAtMs: Date.now() };
    }
    if (!parsed.data.transaction) {
      return {
        ok: false,
        code: "ORDER_NOT_BUILDABLE",
        detail: parsed.data.errorCode !== undefined
          ? `Jupiter route ${parsed.data.router} could not build transaction (code ${parsed.data.errorCode})`
          : "Jupiter returned no signable transaction",
        receivedAtMs: Date.now(),
      };
    }
    return { ok: true, order: parsed.data, receivedAtMs: Date.now() };
  }

  async execute(input: { signedTransactionB64: string; requestId: string; lastValidBlockHeight?: number }): Promise<JupiterExecuteResult> {
    const receivedAtMs = Date.now();
    if (!this.apiKey) {
      return { ok: false, code: "NOT_CONFIGURED", detail: "Jupiter API key not configured", receivedAtMs };
    }
    if (!input.requestId || !input.signedTransactionB64) {
      return { ok: false, code: "INVALID_INPUT", detail: "signed transaction and requestId are required", receivedAtMs };
    }

    const payload: Record<string, unknown> = {
      signedTransaction: input.signedTransactionB64,
      requestId: input.requestId,
    };
    if (input.lastValidBlockHeight !== undefined) payload.lastValidBlockHeight = input.lastValidBlockHeight;

    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.fetchImpl,
        `${this.baseUrl}/execute`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.apiKey,
            accept: "application/json",
          },
          body: JSON.stringify(payload),
        },
        this.timeoutMs,
      );
    } catch (err: any) {
      return {
        ok: false,
        // A timed-out/failed submit call is ambiguous: Jupiter may have
        // received and forwarded the signed transaction.
        code: "EXECUTE_INDETERMINATE",
        detail: err?.name === "AbortError" ? "Jupiter /execute timed out" : "Jupiter /execute transport indeterminate",
        receivedAtMs: Date.now(),
      };
    }

    const body = await readJsonSafe(response);
    if (!response.ok) {
      // HTTP rejection before a valid provider response is not proof that
      // the transaction did not land if signed bytes were already sent.
      return {
        ok: false,
        code: "EXECUTE_INDETERMINATE",
        detail: `Jupiter /execute HTTP ${response.status}`,
        httpStatus: response.status,
        receivedAtMs: Date.now(),
      };
    }

    const parsed = JupiterExecuteResponseSchema.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        code: "EXECUTE_INDETERMINATE",
        detail: "Jupiter /execute response invalid",
        receivedAtMs: Date.now(),
      };
    }

    if (parsed.data.status === "Failed") {
      return {
        ok: false,
        code: "EXECUTE_REJECTED",
        detail: `Jupiter execute failed with code ${parsed.data.code}`,
        receivedAtMs: Date.now(),
      };
    }

    if (parsed.data.code !== 0 || !parsed.data.signature) {
      return {
        ok: false,
        code: "INVALID_RESPONSE",
        detail: "Jupiter reported Success without a valid success code/signature",
        receivedAtMs: Date.now(),
      };
    }
    return { ok: true, execution: parsed.data, receivedAtMs: Date.now() };
  }
}

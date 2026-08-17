import { z } from "zod";

export const EngineStatus = z.enum(["stopped", "starting", "paper_running", "stopping"]);
export type EngineStatus = z.infer<typeof EngineStatus>;

export const Network = z.enum(["unknown", "solana-devnet", "solana-mainnet"]);
export type Network = z.infer<typeof Network>;

export const LicenseStatus = z.enum(["valid", "expired", "invalid"]);
export type LicenseStatus = z.infer<typeof LicenseStatus>;

const finiteNonNegative = z.number().finite().min(0);

export const StrategyConfig = z.object({
  buyAmountSol: z.number().finite().positive().max(0.02),
  maxPositions: z.number().int().min(1).max(5),
  maxSlippageBps: z.number().int().min(1).max(1_000),
  stopLossPct: z.number().finite().min(0).max(100),
  takeProfit1Pct: z.number().finite().min(0).max(1_000),
  takeProfit2Pct: z.number().finite().min(0).max(5_000),
  trailingStopPct: z.number().finite().min(0).max(100),
  minimumLiquiditySol: finiteNonNegative.max(10_000),
  maximumTokenAgeSeconds: z.number().int().min(1).max(86_400),
  safetyFilters: z.object({
    requireRevokedAuthorities: z.boolean(),
    requireSocials: z.boolean(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.takeProfit2Pct < value.takeProfit1Pct) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["takeProfit2Pct"], message: "TP2 must be at least TP1" });
  }
});
export type StrategyConfig = z.infer<typeof StrategyConfig>;

export const PaperPosition = z.object({
  id: z.string().min(1).max(100),
  symbol: z.string().min(1).max(32),
  mint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  entryLamports: z.string().regex(/^[0-9]+$/),
  quantity: z.string().regex(/^(0|[1-9][0-9]*)$/),
  pnlLamports: z.string().regex(/^-?(0|[1-9][0-9]*)$/),
  openedAt: z.string().datetime({ offset: true }),
}).strict();
export type PaperPosition = z.infer<typeof PaperPosition>;

export const EngineState = z.object({
  status: EngineStatus,
  network: Network,
  publicAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).nullable(),
  balanceLamports: z.string().regex(/^[0-9]+$/).nullable(),
  licenseStatus: LicenseStatus,
  strategy: StrategyConfig,
  lastHeartbeatAt: z.string().datetime({ offset: true }).nullable(),
  paper: z.object({
    positions: z.array(PaperPosition).max(5),
    pnlLamports: z.string().regex(/^-?(0|[1-9][0-9]*)$/),
  }).strict(),
}).strict();
export type EngineState = z.infer<typeof EngineState>;

export const EngineCommand = z.object({
  id: z.string().uuid(),
  type: z.enum(["start_paper", "stop", "update_strategy"]),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  payload: z.unknown(),
}).strict();
export type EngineCommand = z.infer<typeof EngineCommand>;

export const PaperEvent = z.object({
  id: z.string().uuid(),
  kind: z.enum(["detected", "rejected", "queued", "paper_filled", "closed", "stopped"]),
  occurredAt: z.string().datetime({ offset: true }),
  message: z.string().min(1).max(500),
  symbol: z.string().max(32).optional(),
  mint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
  paperOnly: z.literal(true),
}).strict();
export type PaperEvent = z.infer<typeof PaperEvent>;

export const SanitizedHeartbeat = z.object({
  engineVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  state: EngineState,
}).strict();
export type SanitizedHeartbeat = z.infer<typeof SanitizedHeartbeat>;

export const EngineErrorCode = z.enum([
  "CONFIG_INVALID", "LICENSE_INVALID", "LICENSE_EXPIRED", "RPC_UNAVAILABLE",
  "COMMAND_INVALID", "COMMAND_EXPIRED", "CONTROL_STALE", "DEVICE_REVOKED",
  "PAPER_ONLY",
]);
export type EngineErrorCode = z.infer<typeof EngineErrorCode>;

export function serializeEngineState(state: EngineState): string {
  return JSON.stringify(state);
}

export function parseEngineCommand(input: unknown): EngineCommand {
  const command = EngineCommand.parse(input);
  if (new Date(command.expiresAt).getTime() <= new Date(command.issuedAt).getTime()) {
    throw new Error("command expiry must be after issue time");
  }
  return command;
}

import { z } from "zod";

const EngineEnvironment = z.object({
  ARIA_ENGINE_API_URL: z.string().url().refine((value) => new URL(value).protocol === "https:", "engine API must use HTTPS"),
  ARIA_ENGINE_RPC_URL: z.string().url().refine((value) => new URL(value).protocol === "https:", "RPC URL must use HTTPS"),
  ARIA_ENGINE_WALLET_REF: z.string().min(1).max(500),
  ARIA_ENGINE_PUBLIC_ADDRESS: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  ARIA_ENGINE_LICENSE: z.string().startsWith("ARIA1.").max(10_000),
  ARIA_ENGINE_NETWORK: z.enum(["solana-devnet", "solana-mainnet"]).default("solana-devnet"),
  ARIA_ENGINE_MODE: z.literal("paper").default("paper"),
  ARIA_ENGINE_VERSION: z.string().regex(/^\d+\.\d+\.\d+$/).default("0.1.0"),
  ARIA_ENGINE_CREDENTIAL_FILE: z.string().min(1).max(500).default(".aria-engine-credential"),
}).strict();

export type EngineConfig = z.infer<typeof EngineEnvironment>;

const FORBIDDEN_ENV_NAMES = [
  "PRIVATE_KEY", "PRIVATEKEY", "SEED", "SEED_PHRASE", "MNEMONIC", "SECRET_KEY",
];

export function loadEngineConfig(env: NodeJS.ProcessEnv): EngineConfig {
  for (const name of FORBIDDEN_ENV_NAMES) {
    if (env[name]) throw new Error(`forbidden secret environment variable: ${name}`);
  }
  const result = EngineEnvironment.safeParse(env);
  if (!result.success) throw new Error(`invalid engine configuration: ${result.error.issues[0]?.message ?? "invalid value"}`);
  return result.data;
}

export function redactEngineConfig(config: EngineConfig): Record<string, string> {
  return {
    apiUrl: new URL(config.ARIA_ENGINE_API_URL).origin,
    rpcHost: new URL(config.ARIA_ENGINE_RPC_URL).host,
    walletReference: "[LOCAL_ONLY]",
    license: "[REDACTED]",
    network: config.ARIA_ENGINE_NETWORK,
    mode: config.ARIA_ENGINE_MODE,
    version: config.ARIA_ENGINE_VERSION,
    credentialFile: config.ARIA_ENGINE_CREDENTIAL_FILE,
  };
}

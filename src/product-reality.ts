export type ProductEnvironment = "production" | "staging" | "development";
export type NetworkMode = "offline" | "solana-devnet" | "solana-mainnet";
export type DataMode = "unavailable" | "simulated" | "live";
export type ExecutionMode = "disabled" | "paper" | "devnet" | "mainnet";
export type ControlState = "stopped" | "starting" | "running" | "stopping";

export interface ProductReality {
  environment: ProductEnvironment;
  network: NetworkMode;
  dataMode: DataMode;
  executionMode: ExecutionMode;
  controlState: ControlState;
  paymentsEnabled: boolean;
}

export interface ProductCapabilities {
  liveData: boolean;
  paperExecution: boolean;
  devnetExecution: boolean;
  mainnetExecution: boolean;
}

export interface ParsedProductRealityConfig {
  environment?: ProductEnvironment;
  network?: NetworkMode;
  dataMode?: DataMode;
  executionMode?: ExecutionMode;
  controlState?: ControlState;
  paymentsEnabled: boolean;
  malformed: boolean;
}

const ENVIRONMENTS = ["production", "staging", "development"] as const;
const NETWORKS = ["offline", "solana-devnet", "solana-mainnet"] as const;
const DATA_MODES = ["unavailable", "simulated", "live"] as const;
const EXECUTION_MODES = ["disabled", "paper", "devnet", "mainnet"] as const;
const CONTROL_STATES = ["stopped", "starting", "running", "stopping"] as const;

const SAFE_BASELINE = {
  environment: "production",
  network: "offline",
  dataMode: "simulated",
  executionMode: "disabled",
  controlState: "stopped",
} as const;

const FAIL_CLOSED = {
  network: "offline",
  dataMode: "unavailable",
  executionMode: "disabled",
  controlState: "stopped",
} as const;

export const CURRENT_PRODUCT_CAPABILITIES: Readonly<ProductCapabilities> = Object.freeze({
  liveData: false,
  paperExecution: false,
  devnetExecution: false,
  mainnetExecution: false,
});

function readEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): { value?: T; malformed: boolean } {
  if (value === undefined || value === "") return { malformed: false };
  return allowed.includes(value as T)
    ? { value: value as T, malformed: false }
    : { malformed: true };
}

export function parseProductRealityConfig(
  env: NodeJS.ProcessEnv,
  paymentsEnabled: boolean,
): ParsedProductRealityConfig {
  const environment = readEnum(env.ARIA_PRODUCT_ENVIRONMENT, ENVIRONMENTS);
  const network = readEnum(env.ARIA_NETWORK_MODE, NETWORKS);
  const dataMode = readEnum(env.ARIA_DATA_MODE, DATA_MODES);
  const executionMode = readEnum(env.ARIA_EXECUTION_MODE, EXECUTION_MODES);
  const controlState = readEnum(env.ARIA_CONTROL_STATE, CONTROL_STATES);

  return {
    environment: environment.value,
    network: network.value,
    dataMode: dataMode.value,
    executionMode: executionMode.value,
    controlState: controlState.value,
    paymentsEnabled,
    malformed: environment.malformed || network.malformed || dataMode.malformed || executionMode.malformed || controlState.malformed,
  };
}

export function resolveProductReality(
  config: ParsedProductRealityConfig,
  capabilities: Readonly<ProductCapabilities> = CURRENT_PRODUCT_CAPABILITIES,
): Readonly<ProductReality> {
  if (config.malformed) {
    return Object.freeze({
      environment: config.environment ?? SAFE_BASELINE.environment,
      ...FAIL_CLOSED,
      paymentsEnabled: config.paymentsEnabled,
    });
  }

  const reality: ProductReality = {
    environment: config.environment ?? SAFE_BASELINE.environment,
    network: config.network ?? SAFE_BASELINE.network,
    dataMode: config.dataMode ?? SAFE_BASELINE.dataMode,
    executionMode: config.executionMode ?? SAFE_BASELINE.executionMode,
    controlState: config.controlState ?? SAFE_BASELINE.controlState,
    paymentsEnabled: config.paymentsEnabled,
  };

  if (reality.dataMode === "live" && !capabilities.liveData) {
    throw new Error("live data is not implemented");
  }
  if (reality.executionMode === "paper" && !capabilities.paperExecution) {
    throw new Error("paper execution is not implemented");
  }
  if (reality.executionMode === "devnet" && !capabilities.devnetExecution) {
    throw new Error("devnet execution is not implemented");
  }
  if (reality.executionMode === "mainnet" && !capabilities.mainnetExecution) {
    throw new Error("mainnet execution is not implemented");
  }
  if (reality.executionMode === "mainnet" && reality.network !== "solana-mainnet") {
    throw new Error("mainnet execution requires solana-mainnet network");
  }
  if (reality.executionMode === "devnet" && reality.network !== "solana-devnet") {
    throw new Error("devnet execution requires solana-devnet network");
  }
  if (reality.controlState === "running" && reality.executionMode === "disabled") {
    throw new Error("running control state requires non-disabled execution");
  }

  return Object.freeze(reality);
}

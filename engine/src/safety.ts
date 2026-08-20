export type StopReason = "user_stop" | "license_expired" | "control_stale" | "rpc_failure" | "invalid_command" | "fatal_error";

export class SafetyLatch {
  private reason: StopReason | null = null;
  trip(reason: StopReason): void { this.reason ??= reason; }
  isTripped(): boolean { return this.reason !== null; }
  stopReason(): StopReason | null { return this.reason; }
}

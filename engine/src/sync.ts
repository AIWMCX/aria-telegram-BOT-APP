import { z } from "zod";

const RuntimeState = z.enum(["UNCONFIGURED", "READY", "PAPER_RUNNING", "PAUSED", "STOPPED", "DEGRADED", "FAULTED"]);
export const SyncCommand = z.object({
  commandId: z.string().uuid(),
  installationId: z.string().uuid(),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  expectedState: RuntimeState,
  sequence: z.number().int().positive().safe(),
  type: z.enum(["paper_start", "paper_pause", "paper_stop", "refresh_entitlement", "request_snapshot"]),
  payload: z.record(z.unknown()),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "command expiry must be after issue time" });
});
export type SyncCommand = z.infer<typeof SyncCommand>;

export function isExpiredSyncCommand(command: Pick<SyncCommand, "expiresAt">, nowMs = Date.now()): boolean {
  return nowMs >= Date.parse(command.expiresAt);
}

export class CommandReplayGuard {
  private readonly seen = new Set<string>();
  private lastSequence = 0;

  accept(command: SyncCommand): boolean {
    if (this.seen.has(command.commandId) || command.sequence <= this.lastSequence) return false;
    this.seen.add(command.commandId);
    this.lastSequence = command.sequence;
    return true;
  }
}

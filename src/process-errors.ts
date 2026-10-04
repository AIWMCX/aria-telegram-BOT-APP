import { logger } from "./logger.js";

/**
 * Without these, Node prints raw uncaught errors (own fields included) to
 * stderr, bypassing the redacting logger. Log through the logger, then keep
 * Node's default fatal behaviour: exit non-zero. Never swallow a crash.
 */
export function installProcessErrorHandlers(exit: (code: number) => void = (c) => process.exit(c), log: Pick<typeof logger, "fatal"> = logger): void {
  const die = (kind: string) => (err: unknown) => {
    log.fatal({ err }, kind);
    // short delay lets an async transport (pino-pretty in dev) flush
    setTimeout(() => exit(1), 100);
    if (process.env.NODE_ENV === "production") exit(1);
  };
  process.on("unhandledRejection", die("unhandledRejection"));
  process.on("uncaughtException", die("uncaughtException"));
}

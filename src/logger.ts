import pino from "pino";
import { CONFIG } from "./config.js";
import { collectSecretValues, redactSecrets } from "./redact.js";

/**
 * Single logging boundary. Every argument (message strings, bindings objects,
 * Errors, cause chains) passes through redactSecrets() BEFORE pino serialises
 * it, with secret values read from the live environment at log time.
 *
 * Severity: pino's default JSON puts a NUMERIC `level` (50) on stdout.
 * Railway derives severity from stderr/stdout or a recognised string field,
 * so every line, errors included, showed as `severity: info` (audit §M-3).
 * We emit string `level` and `severity` fields so the platform can filter
 * and alert on error/warn.
 */
export function createLogger(destination?: pino.DestinationStream, level: pino.LevelWithSilent = CONFIG.LOG_LEVEL) {
  const opts: pino.LoggerOptions = {
  level,
  formatters: {
    level(label) {
      return { level: label, severity: label };
    },
  },
  hooks: {
    logMethod(args, method) {
      const secrets = collectSecretValues(process.env);
      const safe = args.map((a) => redactSecrets(a, secrets));
      return method.apply(this, safe as unknown as Parameters<typeof method>);
    },
  },
  transport: destination || process.env.NODE_ENV === "production"
    ? undefined
    : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname,severity" } },
  };
  return destination ? pino(opts, destination) : pino(opts);
}

export const logger = createLogger();

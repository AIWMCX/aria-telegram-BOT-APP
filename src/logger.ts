import pino from "pino";
import { CONFIG } from "./config.js";
import { collectSecretValues, redactSecrets } from "./redact.js";

/**
 * Single logging boundary. Every argument (message strings, bindings objects,
 * Errors, cause chains) passes through redactSecrets() BEFORE pino serialises
 * it, with secret values read from the live environment at log time.
 *
 * Severity (INFERENCE, not verified): pino's default JSON puts a NUMERIC
 * `level` (50) on stdout; the audit observed every line as `severity: info`
 * on Railway (§M-3), which is consistent with the platform not mapping a
 * numeric level. We now emit string `level` and `severity` fields, which a
 * platform that reads either can use. CAVEAT: on plain `docker logs` (e.g. an
 * Oracle VM) there is no platform severity at all; alerting there needs a log
 * shipper/agent that parses the JSON `level` field.
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

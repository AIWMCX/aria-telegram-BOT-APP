import pino from "pino";
import { CONFIG } from "./config.js";

export const logger = pino({
  level: CONFIG.LOG_LEVEL,
  transport: process.env.NODE_ENV === "production"
    ? undefined
    : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" } },
});

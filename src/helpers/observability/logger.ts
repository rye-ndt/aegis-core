import pino, { type Logger } from "pino";

const LEVEL = (process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug")).toLowerCase();
const PRETTY = process.env.LOG_PRETTY === "true";

const root: Logger = pino({
  level: LEVEL,
  base: { role: process.env.PROCESS_ROLE ?? "combined" },
  ...(PRETTY
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" } } }
    : {}),
});

export function createLogger(scope: string): Logger {
  return root.child({ scope });
}

export const logger = root;

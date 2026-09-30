import { format } from "util";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITIES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Get the current active log level based on MCP_LOG_LEVEL.
 * Defaults to "info" if missing or invalid.
 */
function getActiveLogLevel(): LogLevel {
  const envLevel = process.env.MCP_LOG_LEVEL;
  if (!envLevel) {
    return "info";
  }
  const normalized = envLevel.toLowerCase();
  if (
    normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error"
  ) {
    return normalized as LogLevel;
  }
  return "info";
}

/**
 * Determine if a log level should be printed.
 */
function shouldLog(level: LogLevel): boolean {
  const activeLevel = getActiveLogLevel();
  return LEVEL_PRIORITIES[level] >= LEVEL_PRIORITIES[activeLevel];
}

/**
 * Format and write a log message to process.stderr.
 */
function writeLog(level: LogLevel, ...args: any[]): void {
  if (!shouldLog(level)) {
    return;
  }
  const formatted = format(...args);
  const prefix = `[${level.toUpperCase()}]`;
  process.stderr.write(`${prefix} ${formatted}\n`);
}

export const logger = {
  debug: (...args: any[]) => writeLog("debug", ...args),
  info: (...args: any[]) => writeLog("info", ...args),
  warn: (...args: any[]) => writeLog("warn", ...args),
  error: (...args: any[]) => writeLog("error", ...args),
};

import { getRequestContext } from "../requestContext";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Minimal logging surface that the Logger can dispatch to instead of console.*.
 * Structurally compatible with Azure Functions v4 `InvocationContext` so a
 * Function handler wrapper can pass the InvocationContext directly through the
 * RequestContext as a sink.
 *
 * Why this matters: the Functions Node v4 worker only forwards context.log/
 * info/warn/error/debug/trace to Application Insights `traces`. Plain
 * `console.*` lands only in WebJobs storage, which is not queryable from
 * App Insights. Routing structured log entries through the sink restores
 * end-to-end observability.
 */
export interface LogSink {
  trace?(...args: unknown[]): void;
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  log?(...args: unknown[]): void;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: {
    callerObjectId?: string;
    callerUpn?: string;
    operation?: string;
    [key: string]: unknown;
  };
  error?: {
    message: string;
    stack?: string;
    httpStatus?: number;
  };
}

/**
 * Structured logger for the MCP server.
 * Logs are sent to console which Azure Functions captures in Application Insights.
 * Include minimal context to avoid excessive log volume in App Insights.
 */
export class Logger {
  private static readonly MIN_LOG_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";
  private static readonly INCLUDE_CALLER_IDENTITY = process.env.LOG_INCLUDE_CALLER_IDENTITY === "true";
  private static readonly INCLUDE_ERROR_STACK = process.env.LOG_INCLUDE_ERROR_STACK === "true";
  private static readonly MAX_FIELD_LENGTH = 512;
  private static readonly SENSITIVE_KEY_PATTERN = /(authorization|token|secret|password|cookie|api[_-]?key|x-functions-key|client_secret)/i;
  private static readonly EMAIL_PATTERN = /([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})/gi;
  private static readonly LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
  };

  private static truncate(value: string): string {
    if (value.length <= Logger.MAX_FIELD_LENGTH) {
      return value;
    }
    return `${value.slice(0, Logger.MAX_FIELD_LENGTH)}...[truncated]`;
  }

  private static sanitizeString(value: string): string {
    const redactedBearer = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
    const redactedBasic = redactedBearer.replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]");
    const redactedEmail = redactedBasic.replace(Logger.EMAIL_PATTERN, "[REDACTED_EMAIL]");
    return Logger.truncate(redactedEmail);
  }

  private static sanitizeValue(value: unknown, keyHint?: string): unknown {
    if (typeof value === "string") {
      if (keyHint && Logger.SENSITIVE_KEY_PATTERN.test(keyHint)) {
        return "[REDACTED]";
      }
      return Logger.sanitizeString(value);
    }

    if (typeof value === "number" || typeof value === "boolean" || value === null || typeof value === "undefined") {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map(item => Logger.sanitizeValue(item));
    }

    if (typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, innerValue] of Object.entries(value as Record<string, unknown>)) {
        output[key] = Logger.sanitizeValue(innerValue, key);
      }
      return output;
    }

    return Logger.sanitizeString(String(value));
  }

  private static getMinLogLevel(): LogLevel {
    const configuredLevel = Logger.MIN_LOG_LEVEL;

    if (configuredLevel in Logger.LOG_LEVELS) {
      return configuredLevel as LogLevel;
    }

    return "info";
  }

  private static shouldLog(level: LogLevel): boolean {
    const minLogLevel = Logger.getMinLogLevel();
    return Logger.LOG_LEVELS[level] >= Logger.LOG_LEVELS[minLogLevel];
  }

  private static formatLog(entry: LogEntry): string {
    // Format: [LEVEL] timestamp | message | context
    // Compact JSON-compatible format suitable for App Insights parsing
    const contextStr = entry.context
      ? Object.entries(entry.context)
          .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join("|")
      : "";

    const errorStr = entry.error ? `err=${entry.error.message}` : "";
    const parts = [entry.message, contextStr, errorStr].filter(Boolean).join("|");

    return `[${entry.level.toUpperCase()}] ${entry.timestamp} | ${parts}`;
  }

  private static log(level: LogLevel, message: string, context?: Record<string, unknown>, error?: unknown): void {
    if (!Logger.shouldLog(level)) {
      return;
    }

    const requestCtx = getRequestContext();
    const callerContext = Logger.INCLUDE_CALLER_IDENTITY
      ? {
          callerObjectId: requestCtx?.callerEntraObjectId,
          callerUpn: requestCtx?.callerUpn
        }
      : undefined;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: Logger.sanitizeString(message),
      context: Logger.sanitizeValue({
        ...(callerContext || {}),
        ...(context || {})
      }) as Record<string, unknown>
    };

    if (error) {
      if (error instanceof Error) {
        entry.error = {
          message: Logger.sanitizeString(error.message)
        };
        if (Logger.INCLUDE_ERROR_STACK && error.stack) {
          entry.error.stack = Logger.sanitizeString(error.stack);
        }
        // Extract httpStatus if present
        if ("httpStatus" in error && typeof (error as Record<string, unknown>).httpStatus === "number") {
          entry.error.httpStatus = (error as Record<string, unknown>).httpStatus as number;
        }
      } else {
        entry.error = {
          message: Logger.sanitizeString(String(error))
        };
      }
    }

    const formatted = Logger.formatLog(entry);
    Logger.dispatch(level, formatted);
  }

  /**
   * Routes a formatted log line to the per-request `LogSink` when one is
   * present in the current AsyncLocalStorage context, falling back to
   * `console.*` for the standalone server, unit tests, and any code path that
   * runs outside an Azure Functions invocation (e.g. module-load IIFEs).
   *
   * Public so tests can deterministically assert which sink was chosen
   * without re-creating the full Logger.log pipeline.
   */
  static dispatch(level: LogLevel, formatted: string): void {
    const sink = getRequestContext()?.logSink;

    if (sink) {
      switch (level) {
        case "error":
          sink.error(formatted);
          return;
        case "warn":
          sink.warn(formatted);
          return;
        case "debug":
          if (typeof sink.debug === "function") {
            sink.debug(formatted);
          } else {
            sink.info(formatted);
          }
          return;
        default:
          sink.info(formatted);
          return;
      }
    }

    if (level === "error") {
      console.error(formatted);
    } else if (level === "warn") {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }
  }

  static debug(message: string, context?: Record<string, unknown>): void {
    Logger.log("debug", message, context);
  }

  static info(message: string, context?: Record<string, unknown>): void {
    Logger.log("info", message, context);
  }

  static warn(message: string, context?: Record<string, unknown>, error?: unknown): void {
    Logger.log("warn", message, context, error);
  }

  static error(message: string, context?: Record<string, unknown>, error?: unknown): void {
    Logger.log("error", message, context, error);
  }
}

export default Logger;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Logger, { LogSink } from "../src/utils/logger";
import { runWithRequestContext, getRequestContext } from "../src/requestContext";

const captureConsole = () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  return { log, warn, error };
};

const createSink = (): LogSink & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
} => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
});

describe("Logger LogSink dispatch", () => {
  let consoleSpies: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    consoleSpies = captureConsole();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to console.* when no LogSink is in the active context", () => {
    Logger.info("no sink present");
    Logger.warn("no sink warn");
    Logger.error("no sink error");

    expect(consoleSpies.log).toHaveBeenCalledTimes(1);
    expect(consoleSpies.warn).toHaveBeenCalledTimes(1);
    expect(consoleSpies.error).toHaveBeenCalledTimes(1);
  });

  it("routes info/warn/error/debug through the active LogSink", async () => {
    const sink = createSink();

    await runWithRequestContext({ logSink: sink }, async () => {
      Logger.info("hello", { operation: "info_op" });
      Logger.warn("almost", { operation: "warn_op" });
      Logger.error("oops", { operation: "err_op" }, new Error("boom"));
      // Force-allow debug so the log() pipeline doesn't drop it.
      const original = process.env.LOG_LEVEL;
      try {
        // The static MIN_LOG_LEVEL is captured at class load time, so we
        // can't flip it here. Instead invoke the dispatch helper directly.
        Logger.dispatch("debug", "[DEBUG] direct dispatch | operation=debug_dispatch");
      } finally {
        if (original === undefined) {
          delete process.env.LOG_LEVEL;
        } else {
          process.env.LOG_LEVEL = original;
        }
      }
    });

    expect(sink.info).toHaveBeenCalledTimes(1);
    expect(sink.warn).toHaveBeenCalledTimes(1);
    expect(sink.error).toHaveBeenCalledTimes(1);
    expect(sink.debug).toHaveBeenCalledTimes(1);

    // Console must NOT be touched when a sink is active.
    expect(consoleSpies.log).not.toHaveBeenCalled();
    expect(consoleSpies.warn).not.toHaveBeenCalled();
    expect(consoleSpies.error).not.toHaveBeenCalled();

    // Formatted line shape is preserved through the sink.
    const infoLine = String(sink.info.mock.calls[0][0]);
    expect(infoLine).toContain("[INFO]");
    expect(infoLine).toContain("operation=info_op");
  });

  it("falls back from sink.debug to sink.info when debug is unavailable", () => {
    const sink: LogSink = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
      // intentionally no debug
    };

    return runWithRequestContext({ logSink: sink }, async () => {
      Logger.dispatch("debug", "[DEBUG] no debug method | operation=fallback");
      expect((sink.info as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
      expect((sink.warn as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });
  });

  it("inner runWithRequestContext preserves the outer logSink (merge semantics)", async () => {
    const sink = createSink();

    await runWithRequestContext({ logSink: sink }, async () => {
      // Simulate what the MCP / catalog handlers do: they call
      // runWithRequestContext again with caller identity, NOT a sink.
      await runWithRequestContext(
        { callerUpn: "alice@contoso.com", callerEntraObjectId: "oid-1" },
        async () => {
          Logger.info("inner scope log", { operation: "inner" });
          // Sanity: the outer logSink is still reachable.
          expect(getRequestContext()?.logSink).toBe(sink);
          expect(getRequestContext()?.callerUpn).toBe("alice@contoso.com");
        }
      );
    });

    expect(sink.info).toHaveBeenCalledTimes(1);
  });
});

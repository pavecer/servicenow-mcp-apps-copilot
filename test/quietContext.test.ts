import { describe, it, expect, vi } from "vitest";
import { createQuietContext } from "../src/functions/mcp";

// Verifies the noise-suppression proxy used to stop serverless-http's Azure
// provider from dumping the entire ServerResponse object into App Insights on
// every request, while preserving all other context behavior (string logs and
// the info/warn/error/debug methods our Logger sink uses).

function makeContext() {
  return {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    invocationId: "abc-123"
  };
}

describe("createQuietContext", () => {
  it("swallows object-only log() calls (the ServerResponse dump)", () => {
    const ctx = makeContext();
    const quiet = createQuietContext(ctx);

    quiet.log({ _header: "HTTP/1.1 200 OK", socket: {} }); // serverless-http dump
    quiet.log([1, 2, 3]); // any single object arg

    expect(ctx.log).not.toHaveBeenCalled();
  });

  it("forwards string log() calls untouched", () => {
    const ctx = makeContext();
    const quiet = createQuietContext(ctx);

    quiet.log("a normal log line");
    quiet.log("with", "multiple", "args");

    expect(ctx.log).toHaveBeenCalledTimes(2);
    expect(ctx.log).toHaveBeenNthCalledWith(1, "a normal log line");
    expect(ctx.log).toHaveBeenNthCalledWith(2, "with", "multiple", "args");
  });

  it("passes through info/warn/error/debug (the Logger sink methods)", () => {
    const ctx = makeContext();
    const quiet = createQuietContext(ctx);

    quiet.info("i");
    quiet.warn("w");
    quiet.error("e");
    quiet.debug("d");

    expect(ctx.info).toHaveBeenCalledWith("i");
    expect(ctx.warn).toHaveBeenCalledWith("w");
    expect(ctx.error).toHaveBeenCalledWith("e");
    expect(ctx.debug).toHaveBeenCalledWith("d");
  });

  it("passes through non-function members", () => {
    const ctx = makeContext();
    const quiet = createQuietContext(ctx);
    expect(quiet.invocationId).toBe("abc-123");
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Logger from "../src/utils/logger";

const captureConsole = () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  return { log, warn, error };
};

describe("Logger sanitization", () => {
  let spies: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    spies = captureConsole();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redacts Bearer tokens from log messages", () => {
    Logger.info("Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig");
    const written = spies.log.mock.calls.map(c => String(c[0])).join("\n");
    expect(written).toContain("Bearer [REDACTED]");
    expect(written).not.toContain("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("redacts Basic auth headers from log messages", () => {
    Logger.warn("Failure with header Basic Y2xpZW50OnNlY3JldA==");
    const written = spies.warn.mock.calls.map(c => String(c[0])).join("\n");
    expect(written).toContain("Basic [REDACTED]");
    expect(written).not.toContain("Y2xpZW50OnNlY3JldA");
  });

  it("redacts email addresses from messages and context strings", () => {
    Logger.info("user logged in", { user: "alice@contoso.com" });
    const written = spies.log.mock.calls.map(c => String(c[0])).join("\n");
    expect(written).toContain("[REDACTED_EMAIL]");
    expect(written).not.toContain("alice@contoso.com");
  });

  it("redacts values whose key suggests a secret", () => {
    Logger.info("settings", {
      authorization: "Bearer realtoken",
      api_key: "shhh",
      client_secret: "supersecret",
      friendlyField: "kept"
    });
    const written = spies.log.mock.calls.map(c => String(c[0])).join("\n");
    expect(written).toContain("authorization=[REDACTED]");
    expect(written).toContain("api_key=[REDACTED]");
    expect(written).toContain("client_secret=[REDACTED]");
    expect(written).toContain("friendlyField=kept");
  });

  it("emits an error entry for Logger.error", () => {
    Logger.error("boom", { operation: "test_op" }, new Error("inner"));
    expect(spies.error).toHaveBeenCalledTimes(1);
    const written = String(spies.error.mock.calls[0][0]);
    expect(written).toContain("[ERROR]");
    expect(written).toContain("operation=test_op");
    expect(written).toContain("err=inner");
  });
});

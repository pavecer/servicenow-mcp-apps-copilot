import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Verifies the OBO token-exchange service:
//   - throws when ENTRA_OBO_ENABLED is false (default, prod-safe)
//   - throws when invoked without a caller token
//   - exchanges the caller token via MSAL and returns the downstream token
//   - caches the downstream token per-user (keyed on Entra `oid`)
//   - single-flights concurrent misses for the same user
//   - never mixes tokens across different users
//
// MSAL is mocked at the module level so no network call is made.

const acquireMock = vi.fn();

class ConfidentialClientApplicationMock {
  constructor(_config: unknown) {
    // Configuration captured by the mock; real auth options are not needed.
  }
  acquireTokenOnBehalfOf(...args: unknown[]): unknown {
    return acquireMock(...args);
  }
}

vi.mock("@azure/msal-node", () => ({
  ConfidentialClientApplication: ConfidentialClientApplicationMock
}));

const ENV_KEYS = [
  "ENTRA_OBO_ENABLED",
  "ENTRA_OBO_DOWNSTREAM_SCOPE",
  "ENTRA_TENANT_ID",
  "ENTRA_CLIENT_ID",
  "ENTRA_CLIENT_SECRET"
] as const;
let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function snapshotEnv(): void {
  originalEnv = {};
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const prev = originalEnv[key];
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}

async function loadFreshOboService() {
  vi.resetModules();
  return import("../src/services/oboTokenService");
}

describe("oboTokenService", () => {
  beforeEach(() => {
    snapshotEnv();
    acquireMock.mockReset();
    process.env.ENTRA_TENANT_ID = "tenant-aaa";
    process.env.ENTRA_CLIENT_ID = "client-bbb";
    process.env.ENTRA_CLIENT_SECRET = "secret-ccc";
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  it("isOboEnabled returns false when flag is not set", async () => {
    delete process.env.ENTRA_OBO_ENABLED;
    delete process.env.ENTRA_OBO_DOWNSTREAM_SCOPE;
    const svc = await loadFreshOboService();
    expect(svc.isOboEnabled()).toBe(false);
  });

  it("isOboEnabled returns false when scope is missing", async () => {
    process.env.ENTRA_OBO_ENABLED = "true";
    delete process.env.ENTRA_OBO_DOWNSTREAM_SCOPE;
    const svc = await loadFreshOboService();
    expect(svc.isOboEnabled()).toBe(false);
  });

  it("isOboEnabled returns true when flag and scope are both set", async () => {
    process.env.ENTRA_OBO_ENABLED = "true";
    process.env.ENTRA_OBO_DOWNSTREAM_SCOPE = "api://server/ServiceNow.Use";
    const svc = await loadFreshOboService();
    expect(svc.isOboEnabled()).toBe(true);
  });

  it("throws when called while disabled", async () => {
    delete process.env.ENTRA_OBO_ENABLED;
    const svc = await loadFreshOboService();
    await expect(svc.getDownstreamTokenForCaller({ callerAccessToken: "u-jwt", callerObjectId: "oid-1" }))
      .rejects.toThrow(/ENTRA_OBO_ENABLED is false/);
  });

  it("throws when called without a caller token", async () => {
    process.env.ENTRA_OBO_ENABLED = "true";
    process.env.ENTRA_OBO_DOWNSTREAM_SCOPE = "api://server/scope";
    const svc = await loadFreshOboService();
    await expect(svc.getDownstreamTokenForCaller({ callerAccessToken: "", callerObjectId: "oid-1" }))
      .rejects.toThrow(/without a caller access token/);
  });

  it("returns the downstream token from MSAL on success", async () => {
    process.env.ENTRA_OBO_ENABLED = "true";
    process.env.ENTRA_OBO_DOWNSTREAM_SCOPE = "api://server/ServiceNow.Use";
    acquireMock.mockResolvedValue({
      accessToken: "downstream-jwt-1",
      expiresOn: new Date(Date.now() + 3600_000)
    });
    const svc = await loadFreshOboService();

    const token = await svc.getDownstreamTokenForCaller({
      callerAccessToken: "user-jwt",
      callerObjectId: "oid-1"
    });

    expect(token).toBe("downstream-jwt-1");
    expect(acquireMock).toHaveBeenCalledTimes(1);
    expect(acquireMock).toHaveBeenCalledWith({
      oboAssertion: "user-jwt",
      scopes: ["api://server/ServiceNow.Use"]
    });
  });

  it("caches the downstream token per user (second call does not hit MSAL)", async () => {
    process.env.ENTRA_OBO_ENABLED = "true";
    process.env.ENTRA_OBO_DOWNSTREAM_SCOPE = "api://server/scope";
    acquireMock.mockResolvedValue({
      accessToken: "downstream-cached",
      expiresOn: new Date(Date.now() + 3600_000)
    });
    const svc = await loadFreshOboService();

    const first = await svc.getDownstreamTokenForCaller({ callerAccessToken: "u-jwt", callerObjectId: "oid-X" });
    const second = await svc.getDownstreamTokenForCaller({ callerAccessToken: "u-jwt-different-but-same-user", callerObjectId: "oid-X" });

    expect(first).toBe("downstream-cached");
    expect(second).toBe("downstream-cached");
    expect(acquireMock).toHaveBeenCalledTimes(1);
  });

  it("keeps per-user caches isolated (different oids → separate MSAL calls)", async () => {
    process.env.ENTRA_OBO_ENABLED = "true";
    process.env.ENTRA_OBO_DOWNSTREAM_SCOPE = "api://server/scope";
    acquireMock
      .mockResolvedValueOnce({ accessToken: "token-alice", expiresOn: new Date(Date.now() + 3600_000) })
      .mockResolvedValueOnce({ accessToken: "token-bob", expiresOn: new Date(Date.now() + 3600_000) });
    const svc = await loadFreshOboService();

    const a = await svc.getDownstreamTokenForCaller({ callerAccessToken: "alice-jwt", callerObjectId: "oid-alice" });
    const b = await svc.getDownstreamTokenForCaller({ callerAccessToken: "bob-jwt", callerObjectId: "oid-bob" });

    expect(a).toBe("token-alice");
    expect(b).toBe("token-bob");
    expect(acquireMock).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent misses for the same user", async () => {
    process.env.ENTRA_OBO_ENABLED = "true";
    process.env.ENTRA_OBO_DOWNSTREAM_SCOPE = "api://server/scope";

    let release: (value: { accessToken: string; expiresOn: Date }) => void = () => undefined;
    const pending = new Promise<{ accessToken: string; expiresOn: Date }>(resolve => {
      release = resolve;
    });
    acquireMock.mockReturnValue(pending);

    const svc = await loadFreshOboService();

    const N = 6;
    const callers = Array.from({ length: N }, () =>
      svc.getDownstreamTokenForCaller({ callerAccessToken: "u-jwt", callerObjectId: "oid-single" })
    );

    release({ accessToken: "single-flight-token", expiresOn: new Date(Date.now() + 3600_000) });
    const results = await Promise.all(callers);

    expect(results.every(t => t === "single-flight-token")).toBe(true);
    expect(acquireMock).toHaveBeenCalledTimes(1);
  });

  it("throws when MSAL returns no access token", async () => {
    process.env.ENTRA_OBO_ENABLED = "true";
    process.env.ENTRA_OBO_DOWNSTREAM_SCOPE = "api://server/scope";
    acquireMock.mockResolvedValue(null);
    const svc = await loadFreshOboService();

    await expect(
      svc.getDownstreamTokenForCaller({ callerAccessToken: "u-jwt", callerObjectId: "oid-empty" })
    ).rejects.toThrow(/no access token/);
  });
});

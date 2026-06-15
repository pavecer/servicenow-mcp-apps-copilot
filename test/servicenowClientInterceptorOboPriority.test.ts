import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import axios, { type InternalAxiosRequestConfig } from "axios";

// Verifies the ServiceNowClient request interceptor's auth-resolution chain:
//   1. x-servicenow-access-token header (RequestContext.serviceNowAccessToken)
//   2. OBO exchange (when ENTRA_OBO_ENABLED + caller Entra token present)
//   3. Integration-user TokenManager.getAccessToken() fallback
//   4. SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN=true short-circuits the fallback
//
// Strategy: stub axios.create so we capture the interceptor function the
// client registers, then invoke that interceptor directly with a fake
// request config inside a runWithRequestContext scope.

const ENV_KEYS = [
  "ENTRA_OBO_ENABLED",
  "ENTRA_OBO_DOWNSTREAM_SCOPE",
  "ENTRA_TENANT_ID",
  "ENTRA_CLIENT_ID",
  "ENTRA_CLIENT_SECRET",
  "SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN"
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

type InterceptorFn = (request: InternalAxiosRequestConfig) => Promise<InternalAxiosRequestConfig>;

interface Loaded {
  interceptor: InterceptorFn;
  runWithRequestContext: typeof import("../src/requestContext").runWithRequestContext;
  tokenManagerGetAccessToken: ReturnType<typeof vi.fn>;
  oboGetTokenSpy: ReturnType<typeof vi.fn>;
}

async function loadFreshClient(): Promise<Loaded> {
  vi.resetModules();

  // Capture the interceptor handler the client registers on axios.create.
  let captured: InterceptorFn | undefined;
  const fakeInstance = {
    interceptors: {
      request: {
        use: (fn: InterceptorFn) => {
          captured = fn;
        }
      }
    }
  };
  vi.spyOn(axios, "create").mockReturnValue(fakeInstance as unknown as ReturnType<typeof axios.create>);

  // Mock the OBO service before importing the client so its import resolves
  // to the spy. Tests override the mock implementation as needed.
  const oboGetTokenSpy = vi.fn();
  vi.doMock("../src/services/oboTokenService", () => ({
    isOboEnabled: () => process.env.ENTRA_OBO_ENABLED === "true" && Boolean(process.env.ENTRA_OBO_DOWNSTREAM_SCOPE),
    getDownstreamTokenForCaller: oboGetTokenSpy
  }));

  // Mock TokenManager to a deterministic value so the integration-user branch
  // is testable without touching ServiceNow.
  const tokenManagerGetAccessToken = vi.fn().mockResolvedValue("integration-user-token");
  class TokenManagerMock {
    getAccessToken(): Promise<string> {
      return tokenManagerGetAccessToken();
    }
  }
  vi.doMock("../src/services/tokenManager", () => ({
    TokenManager: TokenManagerMock
  }));

  const { ServiceNowClient } = await import("../src/services/servicenowClient");
  const { TokenManager } = await import("../src/services/tokenManager");
  const { runWithRequestContext } = await import("../src/requestContext");

  // Constructing the client registers the interceptor on our fake instance.
  new ServiceNowClient(new TokenManager());

  if (!captured) {
    throw new Error("ServiceNowClient did not register a request interceptor");
  }

  return {
    interceptor: captured,
    runWithRequestContext,
    tokenManagerGetAccessToken,
    oboGetTokenSpy
  };
}

function makeRequest(): InternalAxiosRequestConfig {
  // Minimal shape the interceptor reads/writes.
  return {
    headers: {} as Record<string, string>,
    method: "get",
    url: "/api/now/table/sys_user"
  } as unknown as InternalAxiosRequestConfig;
}

function authHeader(req: InternalAxiosRequestConfig): string | undefined {
  return (req.headers as Record<string, string> | undefined)?.Authorization;
}

describe("ServiceNowClient request interceptor — OBO priority chain", () => {
  beforeEach(() => {
    snapshotEnv();
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
    vi.doUnmock("../src/services/oboTokenService");
    vi.doUnmock("../src/services/tokenManager");
  });

  it("uses x-servicenow-access-token from RequestContext when present (highest priority)", async () => {
    delete process.env.ENTRA_OBO_ENABLED;
    delete process.env.SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN;

    const { interceptor, runWithRequestContext, tokenManagerGetAccessToken, oboGetTokenSpy } = await loadFreshClient();

    const req = await runWithRequestContext(
      {
        serviceNowAccessToken: "caller-header-token",
        callerEntraAccessToken: "user-jwt",
        callerEntraObjectId: "oid-1"
      },
      () => interceptor(makeRequest())
    );

    expect(authHeader(req)).toBe("Bearer caller-header-token");
    expect(oboGetTokenSpy).not.toHaveBeenCalled();
    expect(tokenManagerGetAccessToken).not.toHaveBeenCalled();
  });

  it("uses OBO downstream token when ENTRA_OBO_ENABLED and caller Entra token present", async () => {
    process.env.ENTRA_OBO_ENABLED = "true";
    process.env.ENTRA_OBO_DOWNSTREAM_SCOPE = "api://server/ServiceNow.Use";
    delete process.env.SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN;

    const { interceptor, runWithRequestContext, tokenManagerGetAccessToken, oboGetTokenSpy } = await loadFreshClient();
    oboGetTokenSpy.mockResolvedValue("downstream-obo-token");

    const req = await runWithRequestContext(
      {
        callerEntraAccessToken: "user-jwt",
        callerEntraObjectId: "oid-2"
      },
      () => interceptor(makeRequest())
    );

    expect(authHeader(req)).toBe("Bearer downstream-obo-token");
    expect(oboGetTokenSpy).toHaveBeenCalledWith({
      callerAccessToken: "user-jwt",
      callerObjectId: "oid-2"
    });
    expect(tokenManagerGetAccessToken).not.toHaveBeenCalled();
  });

  it("falls back to integration user when nothing else is available", async () => {
    delete process.env.ENTRA_OBO_ENABLED;
    delete process.env.SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN;

    const { interceptor, runWithRequestContext, tokenManagerGetAccessToken, oboGetTokenSpy } = await loadFreshClient();

    const req = await runWithRequestContext({}, () => interceptor(makeRequest()));

    expect(authHeader(req)).toBe("Bearer integration-user-token");
    expect(oboGetTokenSpy).not.toHaveBeenCalled();
    expect(tokenManagerGetAccessToken).toHaveBeenCalledTimes(1);
  });

  it("falls back to integration user when OBO is enabled but no caller Entra token present", async () => {
    process.env.ENTRA_OBO_ENABLED = "true";
    process.env.ENTRA_OBO_DOWNSTREAM_SCOPE = "api://server/ServiceNow.Use";
    delete process.env.SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN;

    const { interceptor, runWithRequestContext, tokenManagerGetAccessToken, oboGetTokenSpy } = await loadFreshClient();

    const req = await runWithRequestContext({}, () => interceptor(makeRequest()));

    expect(authHeader(req)).toBe("Bearer integration-user-token");
    expect(oboGetTokenSpy).not.toHaveBeenCalled();
    expect(tokenManagerGetAccessToken).toHaveBeenCalledTimes(1);
  });

  it("falls back to integration user when OBO exchange throws (and require flag is off)", async () => {
    process.env.ENTRA_OBO_ENABLED = "true";
    process.env.ENTRA_OBO_DOWNSTREAM_SCOPE = "api://server/ServiceNow.Use";
    delete process.env.SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN;

    const { interceptor, runWithRequestContext, tokenManagerGetAccessToken, oboGetTokenSpy } = await loadFreshClient();
    oboGetTokenSpy.mockRejectedValue(new Error("AAD outage"));

    const req = await runWithRequestContext(
      {
        callerEntraAccessToken: "user-jwt",
        callerEntraObjectId: "oid-3"
      },
      () => interceptor(makeRequest())
    );

    expect(authHeader(req)).toBe("Bearer integration-user-token");
    expect(oboGetTokenSpy).toHaveBeenCalledTimes(1);
    expect(tokenManagerGetAccessToken).toHaveBeenCalledTimes(1);
  });

  it("throws when SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN=true and no caller identity is available", async () => {
    process.env.SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN = "true";
    delete process.env.ENTRA_OBO_ENABLED;

    const { interceptor, runWithRequestContext, tokenManagerGetAccessToken, oboGetTokenSpy } = await loadFreshClient();

    await expect(
      runWithRequestContext({}, () => interceptor(makeRequest()))
    ).rejects.toThrow(/caller access token is required/);

    expect(oboGetTokenSpy).not.toHaveBeenCalled();
    expect(tokenManagerGetAccessToken).not.toHaveBeenCalled();
  });

  it("re-throws OBO error when SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN=true (no silent fallback)", async () => {
    process.env.SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN = "true";
    process.env.ENTRA_OBO_ENABLED = "true";
    process.env.ENTRA_OBO_DOWNSTREAM_SCOPE = "api://server/ServiceNow.Use";

    const { interceptor, runWithRequestContext, tokenManagerGetAccessToken, oboGetTokenSpy } = await loadFreshClient();
    oboGetTokenSpy.mockRejectedValue(new Error("AAD outage during OBO"));

    await expect(
      runWithRequestContext(
        {
          callerEntraAccessToken: "user-jwt",
          callerEntraObjectId: "oid-4"
        },
        () => interceptor(makeRequest())
      )
    ).rejects.toThrow(/AAD outage during OBO/);

    expect(tokenManagerGetAccessToken).not.toHaveBeenCalled();
  });
});

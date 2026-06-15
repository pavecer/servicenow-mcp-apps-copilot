import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AxiosInstance } from "axios";
import { ServiceNowClient } from "../src/services/servicenowClient";
import { runWithRequestContext } from "../src/requestContext";

// Tests for the four `requested_for` resolution branches in
// src/services/servicenowClient.ts -> resolveRequestedFor():
//
//   - "explicit"        : caller passed an explicit requestedFor argument.
//   - "caller_lookup"   : no explicit value, callerUpn from RequestContext
//                         resolved against sys_user via the configured lookup
//                         fields (default: email, user_name).
//   - "caller_fallback" : no explicit value, lookup failed/empty, fallback
//                         to the raw caller value enabled (default).
//   - "none"            : no explicit value AND no caller context (or
//                         lookup failed and fallback is disabled).
//
// The method is private; tests reach it via bracket access since
// ServiceNowClient deliberately keeps its internals encapsulated and we don't
// want to widen the public surface just to test.
//
// `client.get` (the SN /api/now/table/sys_user lookup) is the only
// network-touching call inside resolveRequestedFor; we mock it directly.

interface MockAxios {
  get: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
}

function createMockAxios(): MockAxios {
  return {
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn()
  };
}

type ResolveRequestedForResult = {
  value?: string;
  diagnostics: {
    source: "explicit" | "caller_lookup" | "caller_fallback" | "none";
    explicitRequestedForProvided: boolean;
    resolvedRequestedFor: string | null;
    [key: string]: unknown;
  };
};

async function resolve(
  client: ServiceNowClient,
  axiosMock: MockAxios,
  explicitRequestedFor?: string
): Promise<ResolveRequestedForResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internal = client as unknown as { resolveRequestedFor: (c: AxiosInstance, e?: string) => Promise<ResolveRequestedForResult> };
  return internal.resolveRequestedFor(axiosMock as unknown as AxiosInstance, explicitRequestedFor);
}

const MUTATED_ENV_KEYS = [
  "SERVICENOW_REQUESTED_FOR_LOOKUP_FIELDS",
  "SERVICENOW_REQUESTED_FOR_CALLER_FIELDS",
  "SERVICENOW_REQUESTED_FOR_FALLBACK_TO_CALLER_VALUE"
] as const;
let originalEnv: Partial<Record<string, string | undefined>> = {};

function snapshotEnv(): void {
  originalEnv = {};
  for (const key of MUTATED_ENV_KEYS) {
    originalEnv[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of MUTATED_ENV_KEYS) {
    const previous = originalEnv[key];
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

describe("ServiceNowClient.resolveRequestedFor branches", () => {
  beforeEach(() => {
    snapshotEnv();
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  it("source=\"explicit\": uses lookup-resolved sys_id when explicit value resolves to a sys_user", async () => {
    const mock = createMockAxios();
    mock.get.mockResolvedValueOnce({
      data: {
        result: [
          { sys_id: "user-explicit-sysid", email: "explicit@example.com" }
        ]
      }
    });

    const client = new ServiceNowClient();

    const result = await resolve(client, mock, "explicit@example.com");

    expect(mock.get).toHaveBeenCalledTimes(1);
    expect(result.diagnostics.source).toBe("explicit");
    expect(result.diagnostics.explicitRequestedForProvided).toBe(true);
    expect(result.value).toBe("user-explicit-sysid");
    // diagnostics.resolvedRequestedFor is masked by withPiiPolicy() when
    // SERVICENOW_REQUESTED_FOR_DIAGNOSTICS_INCLUDE_PII != "true" (default),
    // so we do not assert it here. The unmasked value above is the real signal.
  });

  it("source=\"explicit\" passthrough: returns the raw explicit value unchanged when lookup throws", async () => {
    const mock = createMockAxios();
    mock.get.mockRejectedValueOnce(new Error("upstream SN unavailable"));

    const client = new ServiceNowClient();

    const result = await resolve(client, mock, "lookup-fails@example.com");

    expect(mock.get).toHaveBeenCalledTimes(1);
    expect(result.diagnostics.source).toBe("explicit");
    expect(result.value).toBe("lookup-fails@example.com");
  });

  it("source=\"caller_lookup\": no explicit value, callerUpn in context resolves via sys_user lookup", async () => {
    const mock = createMockAxios();
    mock.get.mockResolvedValueOnce({
      data: {
        result: [
          { sys_id: "user-from-upn-sysid", email: "alice@contoso.com" }
        ]
      }
    });

    const client = new ServiceNowClient();

    const result = await runWithRequestContext(
      { callerUpn: "alice@contoso.com" },
      () => resolve(client, mock)
    );

    expect(mock.get).toHaveBeenCalledTimes(1);
    expect(result.diagnostics.source).toBe("caller_lookup");
    expect(result.diagnostics.explicitRequestedForProvided).toBe(false);
    expect(result.value).toBe("user-from-upn-sysid");
  });

  it("source=\"caller_fallback\": no explicit value, lookup returns no rows, fallback to raw callerUpn (default)", async () => {
    const mock = createMockAxios();
    mock.get.mockResolvedValueOnce({ data: { result: [] } });

    const client = new ServiceNowClient();

    const result = await runWithRequestContext(
      { callerUpn: "bob@contoso.com" },
      () => resolve(client, mock)
    );

    expect(mock.get).toHaveBeenCalledTimes(1);
    expect(result.diagnostics.source).toBe("caller_fallback");
    expect(result.value).toBe("bob@contoso.com");
  });

  it("source=\"none\": no explicit value AND no caller context", async () => {
    const mock = createMockAxios();
    // No GET should fire because there are no candidate values to look up.

    const client = new ServiceNowClient();

    const result = await resolve(client, mock);

    expect(mock.get).not.toHaveBeenCalled();
    expect(result.diagnostics.source).toBe("none");
    expect(result.diagnostics.explicitRequestedForProvided).toBe(false);
    expect(result.value).toBeUndefined();
    expect(result.diagnostics.resolvedRequestedFor).toBeNull();
  });

  it("source=\"none\": lookup empty AND fallback disabled via SERVICENOW_REQUESTED_FOR_FALLBACK_TO_CALLER_VALUE=false", async () => {
    process.env.SERVICENOW_REQUESTED_FOR_FALLBACK_TO_CALLER_VALUE = "false";
    // Re-import to get a fresh ServiceNowClient bound to a fresh config.
    vi.resetModules();
    const { ServiceNowClient: FreshClient } = await import("../src/services/servicenowClient");
    const { runWithRequestContext: freshRun } = await import("../src/requestContext");

    const mock = createMockAxios();
    mock.get.mockResolvedValueOnce({ data: { result: [] } });

    const client = new FreshClient();

    const result = await freshRun(
      { callerUpn: "carol@contoso.com" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (client as any).resolveRequestedFor(mock as unknown as AxiosInstance) as Promise<ResolveRequestedForResult>
    );

    expect(mock.get).toHaveBeenCalledTimes(1);
    expect(result.diagnostics.source).toBe("none");
    expect(result.value).toBeUndefined();
    expect(result.diagnostics.resolvedRequestedFor).toBeNull();
  });
});

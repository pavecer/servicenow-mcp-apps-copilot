import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Verifies the module-load IIFE in src/utils/entraAuthMiddleware.ts that
// emits a single startup log line stating the effective Entra tenant policy.
// Each test mutates env, vi.resetModules() to drop the cached config +
// middleware modules, then dynamic-imports BOTH the (fresh) Logger module
// and the middleware so the spy is attached to the same Logger instance the
// middleware will use when its IIFE fires.

const MUTATED_ENV_KEYS = [
  "ENTRA_AUTH_DISABLED",
  "ENTRA_TENANT_ID",
  "ENTRA_CLIENT_ID",
  "ENTRA_ALLOW_ANY_TENANT",
  "ENTRA_TRUSTED_TENANT_IDS"
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

interface LogCall {
  message: string;
  context: Record<string, unknown> | undefined;
}

interface PolicySpyResult {
  level: "info" | "warn";
  call: LogCall;
}

async function loadAndCapturePolicyLog(): Promise<PolicySpyResult[]> {
  vi.resetModules();
  // Import the FRESH Logger module first so we can attach spies to the same
  // instance the middleware will reach when its IIFE runs.
  const { default: FreshLogger } = await import("../src/utils/logger");

  const calls: PolicySpyResult[] = [];
  vi.spyOn(FreshLogger, "info").mockImplementation((message: string, context?: Record<string, unknown>) => {
    if (context?.operation === "entra_auth_policy") {
      calls.push({ level: "info", call: { message, context } });
    }
  });
  vi.spyOn(FreshLogger, "warn").mockImplementation((message: string, context?: Record<string, unknown>) => {
    if (context?.operation === "entra_auth_policy") {
      calls.push({ level: "warn", call: { message, context } });
    }
  });

  // Importing the middleware fires the bottom-of-file IIFE once.
  await import("../src/utils/entraAuthMiddleware");
  return calls;
}

describe("entraAuthMiddleware startup tenant-policy log (FU#10)", () => {
  beforeEach(() => {
    snapshotEnv();
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  it("logs WARN with mode=disabled when ENTRA_AUTH_DISABLED=true", async () => {
    process.env.ENTRA_AUTH_DISABLED = "true";
    delete process.env.ENTRA_ALLOW_ANY_TENANT;
    delete process.env.ENTRA_TRUSTED_TENANT_IDS;

    const calls = await loadAndCapturePolicyLog();

    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("warn");
    expect(calls[0].call.message).toMatch(/DISABLED/);
    expect(calls[0].call.context?.mode).toBe("disabled");
  });

  it("logs WARN with mode=allow_any_tenant when ENTRA_ALLOW_ANY_TENANT=true", async () => {
    process.env.ENTRA_AUTH_DISABLED = "false";
    process.env.ENTRA_TENANT_ID = "tenant-guid";
    process.env.ENTRA_CLIENT_ID = "client-guid";
    process.env.ENTRA_ALLOW_ANY_TENANT = "true";
    delete process.env.ENTRA_TRUSTED_TENANT_IDS;

    const calls = await loadAndCapturePolicyLog();

    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("warn");
    expect(calls[0].call.message).toMatch(/ANY Microsoft tenant/);
    expect(calls[0].call.context?.mode).toBe("allow_any_tenant");
    expect(calls[0].call.context?.trustedTenantCount).toBe(0);
  });

  it("logs INFO with mode=trusted_multi_tenant when ENTRA_TRUSTED_TENANT_IDS is set", async () => {
    process.env.ENTRA_AUTH_DISABLED = "false";
    process.env.ENTRA_TENANT_ID = "tenant-guid";
    process.env.ENTRA_CLIENT_ID = "client-guid";
    delete process.env.ENTRA_ALLOW_ANY_TENANT;
    process.env.ENTRA_TRUSTED_TENANT_IDS = "remote-tenant-1,remote-tenant-2";

    const calls = await loadAndCapturePolicyLog();

    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("info");
    expect(calls[0].call.context?.mode).toBe("trusted_multi_tenant");
    expect(calls[0].call.context?.trustedTenantCount).toBe(2);
  });

  it("logs INFO with mode=single_tenant when no cross-tenant flags are set", async () => {
    process.env.ENTRA_AUTH_DISABLED = "false";
    process.env.ENTRA_TENANT_ID = "tenant-guid";
    process.env.ENTRA_CLIENT_ID = "client-guid";
    delete process.env.ENTRA_ALLOW_ANY_TENANT;
    delete process.env.ENTRA_TRUSTED_TENANT_IDS;

    const calls = await loadAndCapturePolicyLog();

    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("info");
    expect(calls[0].call.context?.mode).toBe("single_tenant");
    expect(calls[0].call.context?.hasTenantId).toBe(true);
    expect(calls[0].call.context?.hasClientId).toBe(true);
  });

  it("emits exactly one entra_auth_policy log per cold start (no duplicate calls)", async () => {
    process.env.ENTRA_AUTH_DISABLED = "false";
    process.env.ENTRA_TENANT_ID = "tenant-guid";
    process.env.ENTRA_CLIENT_ID = "client-guid";
    delete process.env.ENTRA_ALLOW_ANY_TENANT;
    delete process.env.ENTRA_TRUSTED_TENANT_IDS;

    const calls = await loadAndCapturePolicyLog();
    expect(calls).toHaveLength(1);
  });
});

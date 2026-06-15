import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { HttpRequest, InvocationContext } from "@azure/functions";

// Tests for the /oauth/register Dynamic Client Registration handler in
// src/functions/oidc.ts. Verifies the secure-by-default token gate documented
// in the file header:
//
//   1. Closed by default when no ENTRA_DCR_REGISTRATION_TOKEN is set and
//      ENTRA_DCR_ALLOW_UNAUTHENTICATED is not "true" (-> 403).
//   2. With ENTRA_DCR_REGISTRATION_TOKEN set, valid Bearer token returns 201.
//   3. With ENTRA_DCR_REGISTRATION_TOKEN set, missing or wrong Bearer token
//      returns 401 with WWW-Authenticate.
//   4. With ENTRA_DCR_ALLOW_UNAUTHENTICATED=true and no registration token,
//      anonymous requests return 201 (explicit operator opt-in).
//   5. When ENTRA_CLIENT_ID/SECRET are missing the endpoint reports 404
//      ("DCR not enabled on this server").

// Env keys we manipulate per scenario. Snapshotting + restoring is required
// because the test file uses dynamic re-imports to pick up fresh `config`
// values for each scenario.
const MUTATED_ENV_KEYS = [
  "ENTRA_CLIENT_ID",
  "ENTRA_CLIENT_SECRET",
  "ENTRA_DCR_REGISTRATION_TOKEN",
  "ENTRA_DCR_ALLOW_UNAUTHENTICATED"
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

function makeRequest(headers: Record<string, string> = {}): HttpRequest {
  // Minimal stub mirroring the @azure/functions HttpRequest shape used by the
  // handler: only `headers.get(name)` is touched.
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    headers: {
      get: (name: string): string | null => lower[name.toLowerCase()] ?? null
    }
  } as unknown as HttpRequest;
}

const dummyContext = {} as InvocationContext;

async function loadHandler(): Promise<typeof import("../src/functions/oidc").oauthRegisterHandler> {
  // Re-import after env is set so config picks up the new values.
  // vi.resetModules() drops the cache for src/config and src/functions/oidc.
  vi.resetModules();
  const mod = await import("../src/functions/oidc");
  return mod.oauthRegisterHandler;
}

describe("/oauth/register DCR token gate", () => {
  beforeEach(() => {
    snapshotEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it("returns 404 when DCR is not enabled (no client_id / client_secret)", async () => {
    delete process.env.ENTRA_CLIENT_ID;
    delete process.env.ENTRA_CLIENT_SECRET;
    delete process.env.ENTRA_DCR_REGISTRATION_TOKEN;
    delete process.env.ENTRA_DCR_ALLOW_UNAUTHENTICATED;

    const handler = await loadHandler();
    const res = await handler(makeRequest(), dummyContext);

    expect(res.status).toBe(404);
    const body = JSON.parse(String(res.body));
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("returns 403 closed-by-default when no token configured and unauth not explicitly enabled", async () => {
    process.env.ENTRA_CLIENT_ID = "test-client-id";
    process.env.ENTRA_CLIENT_SECRET = "test-client-secret";
    delete process.env.ENTRA_DCR_REGISTRATION_TOKEN;
    delete process.env.ENTRA_DCR_ALLOW_UNAUTHENTICATED;

    const handler = await loadHandler();
    const res = await handler(makeRequest(), dummyContext);

    expect(res.status).toBe(403);
    const body = JSON.parse(String(res.body));
    expect(body.error).toBe("access_denied");
    expect(body.error_description).toMatch(/disabled without a registration token/i);
  });

  it("returns 401 when ENTRA_DCR_REGISTRATION_TOKEN is set but caller omits Authorization header", async () => {
    process.env.ENTRA_CLIENT_ID = "test-client-id";
    process.env.ENTRA_CLIENT_SECRET = "test-client-secret";
    process.env.ENTRA_DCR_REGISTRATION_TOKEN = "expected-init-token";
    delete process.env.ENTRA_DCR_ALLOW_UNAUTHENTICATED;

    const handler = await loadHandler();
    const res = await handler(makeRequest(), dummyContext);

    expect(res.status).toBe(401);
    expect(res.headers).toBeDefined();
    expect((res.headers as Record<string, string>)["WWW-Authenticate"]).toMatch(/^Bearer/);
    const body = JSON.parse(String(res.body));
    expect(body.error).toBe("unauthorized");
  });

  it("returns 401 when the presented Bearer token does not match", async () => {
    process.env.ENTRA_CLIENT_ID = "test-client-id";
    process.env.ENTRA_CLIENT_SECRET = "test-client-secret";
    process.env.ENTRA_DCR_REGISTRATION_TOKEN = "expected-init-token";
    delete process.env.ENTRA_DCR_ALLOW_UNAUTHENTICATED;

    const handler = await loadHandler();
    const res = await handler(
      makeRequest({ authorization: "Bearer wrong-token" }),
      dummyContext
    );

    expect(res.status).toBe(401);
  });

  it("returns 401 when only the length differs (constant-time comparison still rejects)", async () => {
    process.env.ENTRA_CLIENT_ID = "test-client-id";
    process.env.ENTRA_CLIENT_SECRET = "test-client-secret";
    process.env.ENTRA_DCR_REGISTRATION_TOKEN = "expected-init-token";
    delete process.env.ENTRA_DCR_ALLOW_UNAUTHENTICATED;

    const handler = await loadHandler();
    const res = await handler(
      makeRequest({ authorization: "Bearer expected-init-token-extra" }),
      dummyContext
    );

    expect(res.status).toBe(401);
  });

  it("returns 201 + client credentials when the presented Bearer token matches", async () => {
    process.env.ENTRA_CLIENT_ID = "test-client-id";
    process.env.ENTRA_CLIENT_SECRET = "test-client-secret";
    process.env.ENTRA_DCR_REGISTRATION_TOKEN = "expected-init-token";
    delete process.env.ENTRA_DCR_ALLOW_UNAUTHENTICATED;

    const handler = await loadHandler();
    const res = await handler(
      makeRequest({ authorization: "Bearer expected-init-token" }),
      dummyContext
    );

    expect(res.status).toBe(201);
    const body = JSON.parse(String(res.body));
    expect(body.client_id).toBe("test-client-id");
    expect(body.client_secret).toBe("test-client-secret");
    expect(body.token_endpoint_auth_method).toBe("client_secret_post");
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
  });

  it("returns 201 anonymously when ENTRA_DCR_ALLOW_UNAUTHENTICATED=true and no token is configured", async () => {
    process.env.ENTRA_CLIENT_ID = "test-client-id";
    process.env.ENTRA_CLIENT_SECRET = "test-client-secret";
    delete process.env.ENTRA_DCR_REGISTRATION_TOKEN;
    process.env.ENTRA_DCR_ALLOW_UNAUTHENTICATED = "true";

    const handler = await loadHandler();
    const res = await handler(makeRequest(), dummyContext);

    expect(res.status).toBe(201);
    const body = JSON.parse(String(res.body));
    expect(body.client_id).toBe("test-client-id");
    expect(body.client_secret).toBe("test-client-secret");
  });

  it("still requires a valid Bearer token even when ENTRA_DCR_ALLOW_UNAUTHENTICATED=true if a registration token is also configured (token wins)", async () => {
    process.env.ENTRA_CLIENT_ID = "test-client-id";
    process.env.ENTRA_CLIENT_SECRET = "test-client-secret";
    process.env.ENTRA_DCR_REGISTRATION_TOKEN = "expected-init-token";
    process.env.ENTRA_DCR_ALLOW_UNAUTHENTICATED = "true";

    const handler = await loadHandler();

    // Anonymous request -> the token gate runs and rejects.
    const anonymous = await handler(makeRequest(), dummyContext);
    expect(anonymous.status).toBe(401);

    // Correct Bearer -> 201.
    const authorized = await handler(
      makeRequest({ authorization: "Bearer expected-init-token" }),
      dummyContext
    );
    expect(authorized.status).toBe(201);
  });
});

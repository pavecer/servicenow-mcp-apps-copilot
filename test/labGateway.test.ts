import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { describeBearer, gatewayKeyMatches, readLabGatewaySettings, summarizeLabRequest } from "../src/utils/labGateway";
import type { Request } from "express";

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

describe("lab gateway settings", () => {
  it("defaults every flag to off", () => {
    expect(readLabGatewaySettings({})).toEqual({
      requestDiagnostics: false,
      requireGatewayHeader: false,
      gatewaySharedSecret: undefined
    });
  });

  it("only enables on the literal string true", () => {
    const s = readLabGatewaySettings({ LAB_REQUEST_DIAGNOSTICS: "1", REQUIRE_GATEWAY_HEADER: "TRUE" });
    expect(s.requestDiagnostics).toBe(false);
    expect(s.requireGatewayHeader).toBe(false);
  });
});

describe("describeBearer", () => {
  it("returns undefined without a bearer", () => {
    expect(describeBearer(undefined)).toBeUndefined();
    expect(describeBearer("Basic abc")).toBeUndefined();
  });

  it("keeps only non-PII shape fields", () => {
    const shape = describeBearer(`Bearer ${fakeJwt({ aud: "api://x", appid: "app", idtyp: "app", preferred_username: "a@b.c", oid: "o", roles: ["r"] })}`);
    expect(shape).toEqual({ aud: "api://x", appid: "app", idtyp: "app", ver: undefined, hasPreferredUsername: true, hasScp: false, hasRoles: true });
    expect(JSON.stringify(shape)).not.toContain("a@b.c");
  });

  it("tolerates malformed tokens", () => {
    expect(describeBearer("Bearer not-a-jwt")).toEqual({ hasPreferredUsername: false, hasScp: false, hasRoles: false });
  });
});

describe("summarizeLabRequest", () => {
  it("reports presence booleans only, never header values", () => {
    const token = fakeJwt({ aud: "api://x", scp: "x" });
    const req = {
      headers: { authorization: `Bearer ${token}`, "api-key": "SECRET-KEY", "x-gateway-key": "SECRET-GW" },
      header(name: string) { return (this.headers as Record<string, string>)[name.toLowerCase()]; }
    } as unknown as Request;
    const s = summarizeLabRequest(req);
    expect(s.present_bearer).toBe(true);
    expect(s.present_gw_runtime_key).toBe(true);
    expect(s.present_x_gateway_key).toBe(true);
    expect(s.bearer_has_scp).toBe(true);
    const text = JSON.stringify(s);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain(token);
  });
});

describe("gatewayKeyMatches", () => {
  it("compares safely across lengths", () => {
    expect(gatewayKeyMatches("abc", "abc")).toBe(true);
    expect(gatewayKeyMatches("abcd", "abc")).toBe(false);
    expect(gatewayKeyMatches(undefined, "abc")).toBe(false);
    expect(gatewayKeyMatches("", "abc")).toBe(false);
  });
});

describe("lab middleware wired into the MCP app", { timeout: 30_000 }, () => {
  let server: Server | undefined;
  const envBackup = { ...process.env };

  async function start(env: Record<string, string>): Promise<string> {
    Object.assign(process.env, env);
    vi.resetModules();
    const { createMcpExpressApp } = await import("../src/app");
    const app = createMcpExpressApp();
    server = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  }

  const listTools = (url: string, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });

  beforeEach(() => {
    delete process.env.LAB_REQUEST_DIAGNOSTICS;
    delete process.env.REQUIRE_GATEWAY_HEADER;
    delete process.env.GATEWAY_SHARED_SECRET;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    process.env = { ...envBackup };
  });

  it("is a no-op when flags are off", async () => {
    const url = await start({});
    const res = await listTools(url);
    expect(res.status).toBe(200);
  });

  it("rejects POSTs without the gateway header when enforcement is on", async () => {
    const url = await start({ REQUIRE_GATEWAY_HEADER: "true", GATEWAY_SHARED_SECRET: "s3cret" });
    expect((await listTools(url)).status).toBe(403);
    expect((await listTools(url, { "x-gateway-key": "wrong" })).status).toBe(403);
    expect((await listTools(url, { "x-gateway-key": "s3cret" })).status).toBe(200);
  });

  it("fails closed when enforcement is on but the secret is missing", async () => {
    const url = await start({ REQUIRE_GATEWAY_HEADER: "true" });
    expect((await listTools(url, { "x-gateway-key": "anything" })).status).toBe(503);
  });

  it("emits one redacted diagnostics line when enabled", async () => {
    const url = await start({ LAB_REQUEST_DIAGNOSTICS: "true" });
    const { default: FreshLogger } = await import("../src/utils/logger");
    const spy = vi.spyOn(FreshLogger, "info");
    await listTools(url, { "api-key": "SECRET-KEY" });
    await new Promise(r => setTimeout(r, 20));
    const call = spy.mock.calls.find(c => (c[1] as Record<string, unknown> | undefined)?.operation === "lab_request_diagnostics");
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({ present_gw_runtime_key: true, present_bearer: false, status: 200 });
    expect(JSON.stringify(call)).not.toContain("SECRET-KEY");
  });
});


import { describe, it, expect, afterEach, vi } from "vitest";

// Verifies that place_order stamps the real ordering user onto the created
// sc_request (and its sc_req_item rows) by patching opened_by / requested_by /
// requested_for after the order_now call. ServiceNow stamps opened_by with
// whoever authenticated the REST call (the integration user), so without this
// patch the record shows "Opened by: System Administrator".
//
// `config` reads env at import time, so tests that flip
// SERVICENOW_ATTRIBUTE_OWNERSHIP_TO_CALLER reset the module registry and import
// a fresh client + request context (matching the resolveRequestedFor tests).

const CALLER_SYS_ID = "62826bf03710200044e0bfc8bcbe5df1"; // 32-hex, valid sys_id
const REQUEST_SYS_ID = "6cfa0dfc83650b547505f0b6feaad3f3";
const ITEM_SYS_ID = "11118173e9756cd1021983d1e6253af1";
const CAT_ITEM_SYS_ID = "04b7e94b4f7b4200086eeed18110c7fd";

interface MockAxios {
  get: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
}

function createMockAxios(): MockAxios {
  return {
    get: vi.fn(async (url: string) => {
      if (url === "/api/now/table/sys_user") {
        // Caller lookup resolves the Entra UPN to a ServiceNow sys_id.
        return { data: { result: [{ sys_id: CALLER_SYS_ID, email: "abel.tuter@example.com" }] } };
      }
      if (url === "/api/now/table/sc_req_item") {
        return { data: { result: [{ sys_id: ITEM_SYS_ID }] } };
      }
      return { data: { result: [] } };
    }),
    post: vi.fn(async () => ({
      data: { result: { sys_id: REQUEST_SYS_ID, request_number: "REQ0010111", number: "REQ0010111" } }
    })),
    patch: vi.fn(async () => ({ data: { result: {} } }))
  };
}

async function placeOrderWithFlag(flag: "on" | "off", mock: MockAxios): Promise<void> {
  if (flag === "off") process.env.SERVICENOW_ATTRIBUTE_OWNERSHIP_TO_CALLER = "false";
  else delete process.env.SERVICENOW_ATTRIBUTE_OWNERSHIP_TO_CALLER; // default = on

  // Re-import to bind a fresh ServiceNowClient + request context to a fresh config.
  vi.resetModules();
  const { ServiceNowClient } = await import("../src/services/servicenowClient");
  const { runWithRequestContext } = await import("../src/requestContext");

  const client = new ServiceNowClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).getClient = async () => mock;

  await runWithRequestContext({ callerUpn: "abel.tuter@example.com" }, async () => {
    await client.placeOrder(CAT_ITEM_SYS_ID, { variables: {}, quantity: 1 });
  });
}

function findPatch(mock: MockAxios, url: string): Record<string, string> | undefined {
  const call = mock.patch.mock.calls.find(([u]) => u === url);
  return call?.[1] as Record<string, string> | undefined;
}

describe("place_order attribution (opened_by / requested_by)", () => {
  const originalFlag = process.env.SERVICENOW_ATTRIBUTE_OWNERSHIP_TO_CALLER;

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.SERVICENOW_ATTRIBUTE_OWNERSHIP_TO_CALLER;
    else process.env.SERVICENOW_ATTRIBUTE_OWNERSHIP_TO_CALLER = originalFlag;
    vi.restoreAllMocks();
  });

  it("patches opened_by, requested_by and requested_for on the sc_request to the caller", async () => {
    const mock = createMockAxios();
    await placeOrderWithFlag("on", mock);

    const requestBody = findPatch(mock, `/api/now/table/sc_request/${REQUEST_SYS_ID}`);
    expect(requestBody).toBeDefined();
    expect(requestBody?.opened_by).toBe(CALLER_SYS_ID);
    expect(requestBody?.requested_by).toBe(CALLER_SYS_ID);
    expect(requestBody?.requested_for).toBe(CALLER_SYS_ID);

    const itemBody = findPatch(mock, `/api/now/table/sc_req_item/${ITEM_SYS_ID}`);
    expect(itemBody).toBeDefined();
    expect(itemBody?.opened_by).toBe(CALLER_SYS_ID);
    expect(itemBody?.requested_for).toBe(CALLER_SYS_ID);
  });

  it("does NOT patch opened_by when SERVICENOW_ATTRIBUTE_OWNERSHIP_TO_CALLER=false", async () => {
    const mock = createMockAxios();
    await placeOrderWithFlag("off", mock);

    // requested_for is still patched (existing behavior), but ownership is not.
    const requestBody = findPatch(mock, `/api/now/table/sc_request/${REQUEST_SYS_ID}`);
    expect(requestBody).toBeDefined();
    expect(requestBody?.requested_for).toBe(CALLER_SYS_ID);
    expect(requestBody?.opened_by).toBeUndefined();
    expect(requestBody?.requested_by).toBeUndefined();
  });
});

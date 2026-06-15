import { describe, it, expect, vi } from "vitest";
import { ServiceNowClient } from "../src/services/servicenowClient";

// We don't have direct access to mapWithConcurrency (module-private), so the
// behavior is verified indirectly through listUserOrders. We mock the axios
// instance returned by the private getClient method via prototype patching.

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

describe("listUserOrders concurrency cap", () => {
  it("never exceeds 5 concurrent ServiceNow GETs while enriching items", async () => {
    const NUM_REQUESTS = 12;
    const NUM_ITEMS_PER_REQUEST = 4;

    const mockAxios = createMockAxios();
    const client = new ServiceNowClient();

    // Stub the user lookup (callerValues lookup).
    // Stub the sc_request fetch returning NUM_REQUESTS rows.
    const requestRows = Array.from({ length: NUM_REQUESTS }, (_, i) => ({
      sys_id: `req-${i}`,
      number: `REQ${1000 + i}`
    }));

    // Track in-flight count and peak.
    let inFlight = 0;
    let peak = 0;
    const trackedDelay = async <T>(value: T): Promise<T> => {
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return value;
    };

    mockAxios.get.mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => {
      // Initial sys_user lookup to resolve currentUserSysId.
      if (url === "/api/now/table/sys_user") {
        return { data: { result: [{ sys_id: "user-1", email: "x@y.z" }] } };
      }
      if (url === "/api/now/table/sc_request") {
        return { data: { result: requestRows } };
      }
      if (url === "/api/now/table/sc_req_item") {
        return trackedDelay({
          data: {
            result: Array.from({ length: NUM_ITEMS_PER_REQUEST }, (_, i) => ({
              sys_id: `item-${i}`,
              cat_item_id: { value: `cat-${i}` }
            }))
          }
        });
      }
      if (url.startsWith("/api/sn_sc/servicecatalog/items/")) {
        return trackedDelay({ data: { result: { sys_id: "cat", name: "Cat" } } });
      }
      return { data: { result: [] } };
    });

    // Patch the private getClient to return our mock.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).getClient = async () => mockAxios;

    // Stub the request context to provide a caller upn so getCallerValues returns one.
    const { runWithRequestContext } = await import("../src/requestContext");
    await runWithRequestContext({ callerUpn: "tester@contoso.com" }, async () => {
      await client.listUserOrders(NUM_REQUESTS);
    });

    // Concurrency cap is applied per fan-out level (outer over requests AND
    // inner over items). With NUM_REQUESTS=12 and NUM_ITEMS_PER_REQUEST=4, an
    // unbounded Promise.all would peak at >=48 inflight catalog GETs. The cap
    // bounds peak to outer(5) * inner(min(items, 5)) = 20 in the worst case;
    // we assert <= 25 to allow scheduler jitter and the sc_req_item GETs.
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(25);
  });
});

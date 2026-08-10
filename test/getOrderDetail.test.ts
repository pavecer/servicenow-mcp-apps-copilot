import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerGetOrderDetailTool } from "../src/tools/getOrderDetail";
import type { ServiceNowClient } from "../src/services/servicenowClient";

interface RegisteredTool {
  name: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function createFakeServer(): { server: { tool: (n: string, d: string, s: Record<string, unknown>, h: RegisteredTool["handler"]) => void }; tools: RegisteredTool[] } {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    server: {
      tool: (name, _desc, schema, handler) => {
        tools.push({ name, schema, handler });
      }
    }
  };
}

describe("get_order_detail tool", () => {
  let getOrderDetailMock: ReturnType<typeof vi.fn>;
  let registered: RegisteredTool;
  let fakeClient: ServiceNowClient;

  beforeEach(() => {
    getOrderDetailMock = vi.fn().mockResolvedValue({
      order: { sys_id: "abc", number: "REQ0001", short_description: "Test order" },
      items: [{ sys_id: "item1", number: "RITM0001" }],
      approvals: []
    });
    fakeClient = { getOrderDetail: getOrderDetailMock } as unknown as ServiceNowClient;

    const fake = createFakeServer();
    registerGetOrderDetailTool(fake.server as never, fakeClient);
    registered = fake.tools[0];
  });

  it("registers a tool named get_order_detail", () => {
    expect(registered.name).toBe("get_order_detail");
  });

  it("forwards orderSysId and explicit includeApprovals through to the client", async () => {
    await registered.handler({ orderSysId: "abc", includeApprovals: true });
    expect(getOrderDetailMock).toHaveBeenCalledTimes(1);
    expect(getOrderDetailMock).toHaveBeenCalledWith("abc", { includeApprovals: true });
  });

  it("respects includeApprovals=false when caller opts out", async () => {
    await registered.handler({ orderSysId: "abc", includeApprovals: false });
    expect(getOrderDetailMock).toHaveBeenCalledWith("abc", { includeApprovals: false });
  });

  it("returns the order, items, approvals in structuredContent with a concise summary", async () => {
    const result = await registered.handler({ orderSysId: "abc" }) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, unknown>;
    };
    // Content is a concise, neutral model-facing summary (not a JSON blob).
    expect(result.content[0].text).toContain("REQ0001");
    expect(() => JSON.parse(result.content[0].text)).toThrow();
    // The full record travels in structuredContent for the order-detail widget.
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toBeDefined();
    expect((sc.order as Record<string, unknown>).number).toBe("REQ0001");
    expect((sc.items as unknown[]).length).toBe(1);
    expect((sc.approvals as unknown[]).length).toBe(0);
  });

  it("returns a structured failure when the client throws", async () => {
    getOrderDetailMock.mockRejectedValueOnce(new Error("not found"));
    const result = await registered.handler({ orderSysId: "missing" }) as {
      content: Array<{ type: string; text: string }>;
    };
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("not found");
  });
});

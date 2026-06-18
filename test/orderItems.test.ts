import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerUpdateOrderItemTool, registerRemoveOrderItemTool } from "../src/tools/orderItems";
import type { ServiceNowClient } from "../src/services/servicenowClient";

interface RegisteredTool {
  name: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function createFakeServer(): {
  server: { tool: (name: string, desc: string, schema: Record<string, unknown>, handler: RegisteredTool["handler"]) => void };
  tools: RegisteredTool[];
} {
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

describe("update_order_item tool", () => {
  let updateOrderItemMock: ReturnType<typeof vi.fn>;
  let getOrderDetailMock: ReturnType<typeof vi.fn>;
  let getParentMock: ReturnType<typeof vi.fn>;
  let registered: RegisteredTool;
  let fakeClient: ServiceNowClient;

  beforeEach(() => {
    updateOrderItemMock = vi.fn().mockResolvedValue({ sys_id: "item1" });
    getOrderDetailMock = vi.fn().mockResolvedValue({
      order: { sys_id: "req1", number: "REQ001" },
      items: [{ sys_id: "item1", quantity: "2" }],
      approvals: []
    });
    getParentMock = vi.fn().mockResolvedValue("req1");
    fakeClient = {
      updateOrderItem: updateOrderItemMock,
      getOrderDetail: getOrderDetailMock,
      getOrderItemRequestSysId: getParentMock
    } as unknown as ServiceNowClient;

    const fake = createFakeServer();
    registerUpdateOrderItemTool(fake.server as never, fakeClient);
    registered = fake.tools[0];
  });

  it("registers a tool named update_order_item", () => {
    expect(registered.name).toBe("update_order_item");
  });

  it("forwards only allowlisted fields and refreshes the order via explicit orderSysId", async () => {
    await registered.handler({
      orderItemSysId: "item1",
      orderSysId: "req1",
      updates: { quantity: 3, short_description: "renamed" }
    });

    expect(updateOrderItemMock).toHaveBeenCalledTimes(1);
    expect(updateOrderItemMock).toHaveBeenCalledWith("item1", {
      quantity: 3,
      short_description: "renamed"
    });
    // Refreshes via getOrderDetail; explicit orderSysId means no parent lookup.
    expect(getParentMock).not.toHaveBeenCalled();
    expect(getOrderDetailMock).toHaveBeenCalledWith("req1", { includeApprovals: true });
  });

  it("resolves the parent request when orderSysId is omitted", async () => {
    await registered.handler({
      orderItemSysId: "item1",
      updates: { quantity: 2 }
    });

    expect(getParentMock).toHaveBeenCalledWith("item1");
    expect(getOrderDetailMock).toHaveBeenCalledWith("req1", { includeApprovals: true });
  });

  it("returns a structured failure when no allowed field is provided", async () => {
    const result = await registered.handler({
      orderItemSysId: "item1",
      updates: {}
    }) as { content: Array<{ type: string; text: string }> };

    expect(updateOrderItemMock).not.toHaveBeenCalled();
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(payload.success).toBe(false);
    expect(String(payload.error)).toMatch(/no allowed fields/i);
  });

  it("returns a structured failure when the update throws", async () => {
    updateOrderItemMock.mockRejectedValueOnce(new Error("boom"));
    const result = await registered.handler({
      orderItemSysId: "item1",
      orderSysId: "req1",
      updates: { quantity: 2 }
    }) as { content: Array<{ type: string; text: string }> };

    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("boom");
  });
});

describe("remove_order_item tool", () => {
  let removeOrderItemMock: ReturnType<typeof vi.fn>;
  let getOrderDetailMock: ReturnType<typeof vi.fn>;
  let getParentMock: ReturnType<typeof vi.fn>;
  let registered: RegisteredTool;
  let fakeClient: ServiceNowClient;

  beforeEach(() => {
    removeOrderItemMock = vi.fn().mockResolvedValue(undefined);
    getOrderDetailMock = vi.fn().mockResolvedValue({
      order: { sys_id: "req1", number: "REQ001" },
      items: [],
      approvals: []
    });
    getParentMock = vi.fn().mockResolvedValue("req1");
    fakeClient = {
      removeOrderItem: removeOrderItemMock,
      getOrderDetail: getOrderDetailMock,
      getOrderItemRequestSysId: getParentMock
    } as unknown as ServiceNowClient;

    const fake = createFakeServer();
    registerRemoveOrderItemTool(fake.server as never, fakeClient);
    registered = fake.tools[0];
  });

  it("registers a tool named remove_order_item", () => {
    expect(registered.name).toBe("remove_order_item");
  });

  it("resolves the parent BEFORE removal so it can refresh the order after", async () => {
    await registered.handler({ orderItemSysId: "item1" });

    expect(getParentMock).toHaveBeenCalledWith("item1");
    expect(removeOrderItemMock).toHaveBeenCalledWith("item1");
    expect(getOrderDetailMock).toHaveBeenCalledWith("req1", { includeApprovals: true });

    // Parent must be resolved before the destructive delete.
    const parentOrder = getParentMock.mock.invocationCallOrder[0];
    const removeOrder = removeOrderItemMock.mock.invocationCallOrder[0];
    expect(parentOrder).toBeLessThan(removeOrder);
  });

  it("uses an explicit orderSysId without a parent lookup", async () => {
    await registered.handler({ orderItemSysId: "item1", orderSysId: "req9" });

    expect(getParentMock).not.toHaveBeenCalled();
    expect(removeOrderItemMock).toHaveBeenCalledWith("item1");
    expect(getOrderDetailMock).toHaveBeenCalledWith("req9", { includeApprovals: true });
  });

  it("returns a structured failure when removal throws", async () => {
    removeOrderItemMock.mockRejectedValueOnce(new Error("denied"));
    const result = await registered.handler({
      orderItemSysId: "item1",
      orderSysId: "req1"
    }) as { content: Array<{ type: string; text: string }> };

    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("denied");
  });
});

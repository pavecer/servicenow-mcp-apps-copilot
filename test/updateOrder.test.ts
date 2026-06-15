import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerUpdateOrderTool } from "../src/tools/updateOrder";
import type { ServiceNowClient } from "../src/services/servicenowClient";

interface RegisteredTool {
  name: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function createFakeServer(): { server: { tool: (name: string, desc: string, schema: Record<string, unknown>, handler: RegisteredTool["handler"]) => void }; tools: RegisteredTool[] } {
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

describe("update_order tool", () => {
  let updateOrderMock: ReturnType<typeof vi.fn>;
  let registered: RegisteredTool;
  let fakeClient: ServiceNowClient;

  beforeEach(() => {
    updateOrderMock = vi.fn().mockResolvedValue({ sys_id: "abc", short_description: "ok" });
    fakeClient = {
      updateOrder: updateOrderMock
    } as unknown as ServiceNowClient;

    const fake = createFakeServer();
    registerUpdateOrderTool(fake.server as never, fakeClient);
    registered = fake.tools[0];
  });

  it("registers a tool named update_order", () => {
    expect(registered.name).toBe("update_order");
  });

  it("forwards only allowlisted fields to the ServiceNow client", async () => {
    await registered.handler({
      orderSysId: "abc",
      updates: {
        short_description: "new desc",
        comments: "please expedite"
      }
    });

    expect(updateOrderMock).toHaveBeenCalledTimes(1);
    expect(updateOrderMock).toHaveBeenCalledWith("abc", {
      short_description: "new desc",
      comments: "please expedite"
    });
  });

  it("returns a structured failure when no allowed field is provided", async () => {
    const result = await registered.handler({
      orderSysId: "abc",
      updates: {}
    }) as { content: Array<{ type: string; text: string }> };

    expect(updateOrderMock).not.toHaveBeenCalled();
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(payload.success).toBe(false);
    expect(String(payload.error)).toMatch(/no allowed fields/i);
  });

  it("returns a structured failure response when ServiceNow update throws", async () => {
    updateOrderMock.mockRejectedValueOnce(new Error("boom"));
    const result = await registered.handler({
      orderSysId: "abc",
      updates: { short_description: "x" }
    }) as { content: Array<{ type: string; text: string }> };

    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("boom");
    expect(payload.orderSysId).toBe("abc");
  });
});

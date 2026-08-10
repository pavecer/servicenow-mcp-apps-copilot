import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerApproveOrderApprovalTool,
  registerRejectOrderApprovalTool
} from "../src/tools/orderApprovals";
import type { ServiceNowClient } from "../src/services/servicenowClient";

interface RegisteredTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function createFakeServer() {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    server: {
      tool: (
        name: string,
        _desc: string,
        _schema: Record<string, unknown>,
        handler: RegisteredTool["handler"]
      ) => {
        tools.push({ name, handler });
      }
    }
  };
}

describe("order approval tools", () => {
  let decideOrderApproval: ReturnType<typeof vi.fn>;
  let getOrderDetail: ReturnType<typeof vi.fn>;
  let fakeClient: ServiceNowClient;

  beforeEach(() => {
    decideOrderApproval = vi.fn().mockResolvedValue({ sys_id: "ap1", state: "approved" });
    getOrderDetail = vi.fn().mockResolvedValue({
      order: { sys_id: "req1", number: "REQ001" },
      items: [{ sys_id: "ritm1" }],
      approvals: [{ sys_id: "ap1", state: "approved" }]
    });

    fakeClient = {
      decideOrderApproval,
      getOrderDetail
    } as unknown as ServiceNowClient;
  });

  it("registers approve_order_approval and forwards comment", async () => {
    const fake = createFakeServer();
    registerApproveOrderApprovalTool(fake.server as never, fakeClient);
    const registered = fake.tools[0];
    expect(registered.name).toBe("approve_order_approval");

    await registered.handler({
      orderSysId: "req1",
      approvalSysId: "ap1",
      comment: "Looks good"
    });

    expect(decideOrderApproval).toHaveBeenCalledWith("ap1", "approved", {
      requestSysId: "req1",
      comment: "Looks good"
    });
    expect(getOrderDetail).toHaveBeenCalledWith("req1", { includeApprovals: true });
  });

  it("registers reject_order_approval and forwards reason as comment", async () => {
    const fake = createFakeServer();
    registerRejectOrderApprovalTool(fake.server as never, fakeClient);
    const registered = fake.tools[0];
    expect(registered.name).toBe("reject_order_approval");

    await registered.handler({
      orderSysId: "req1",
      approvalSysId: "ap1",
      reason: "Need budget approval first"
    });

    expect(decideOrderApproval).toHaveBeenCalledWith("ap1", "rejected", {
      requestSysId: "req1",
      comment: "Need budget approval first"
    });
    expect(getOrderDetail).toHaveBeenCalledWith("req1", { includeApprovals: true });
  });

  it("returns a structured failure envelope when approval update fails", async () => {
    decideOrderApproval.mockRejectedValueOnce(new Error("forbidden"));
    const fake = createFakeServer();
    registerApproveOrderApprovalTool(fake.server as never, fakeClient);

    const result = (await fake.tools[0].handler({
      orderSysId: "req1",
      approvalSysId: "ap1"
    })) as { content: Array<{ text: string }> };

    expect(result.content[0].text).toContain("forbidden");
    expect((result as { structuredContent?: Record<string, unknown> }).structuredContent).toMatchObject({
      success: false,
      error: "forbidden"
    });
  });

  it("reports a recorded approval as successful when detail refresh fails", async () => {
    getOrderDetail.mockRejectedValueOnce(new Error("refresh unavailable"));
    const fake = createFakeServer();
    registerApproveOrderApprovalTool(fake.server as never, fakeClient);

    const result = await fake.tools[0].handler({
      orderSysId: "req1",
      approvalSysId: "ap1"
    }) as { structuredContent?: Record<string, unknown> };

    expect(decideOrderApproval).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      success: true,
      approvalRecorded: true,
      approvalSysId: "ap1",
      decision: "approved"
    });
  });
});

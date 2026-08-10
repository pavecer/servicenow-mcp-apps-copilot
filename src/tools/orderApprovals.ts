import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceNowClient } from "../services/servicenowClient";
import Logger from "../utils/logger";
import { buildOrderDetailResult } from "./getOrderDetail";

type Decision = "approved" | "rejected";

async function decideAndRefresh(
  client: ServiceNowClient,
  input: {
    orderSysId: string;
    approvalSysId: string;
    decision: Decision;
    comment?: string;
  }
) {
  const approval = await client.decideOrderApproval(input.approvalSysId, input.decision, {
    requestSysId: input.orderSysId,
    comment: input.comment
  });

  try {
    return await buildOrderDetailResult(client, input.orderSysId, { includeApprovals: true });
  } catch {
    const success = {
      success: true,
      approvalRecorded: true,
      approvalSysId: input.approvalSysId,
      decision: input.decision,
      message: "Approval decision was recorded, but refreshed order details are temporarily unavailable.",
      approval
    };
    return {
      structuredContent: success,
      content: [{ type: "text" as const, text: success.message }]
    };
  }
}

export function registerApproveOrderApprovalTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "approve_order_approval",
    [
      "Approve a pending ServiceNow order approval (sysapproval_approver row) for a request.",
      "Use this when a manager wants to approve a request from the order-detail approvals section.",
      "Returns refreshed order detail so the widget re-renders with updated approval state."
    ].join(" "),
    {
      orderSysId: z
        .string()
        .min(1)
        .describe("The parent order sys_id (sc_request)."),
      approvalSysId: z
        .string()
        .min(1)
        .describe("The approval row sys_id (sysapproval_approver)."),
      comment: z
        .string()
        .max(4000)
        .optional()
        .describe("Optional approval comment recorded in ServiceNow.")
    },
    async ({ orderSysId, approvalSysId, comment }) => {
      try {
        return await decideAndRefresh(client, {
          orderSysId,
          approvalSysId,
          decision: "approved",
          comment
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        Logger.warn("approve_order_approval tool failed", {
          operation: "tool.approve_order_approval",
          orderSysId,
          approvalSysId
        }, error);
        const failure = {
          success: false,
          error: errorMessage,
          message: "Failed to approve the order request",
          orderSysId,
          approvalSysId
        };
        return {
          structuredContent: failure,
          content: [
            {
              type: "text" as const,
              text: `Could not approve order ${orderSysId}: ${errorMessage}`
            }
          ]
        };
      }
    }
  );
}

export function registerRejectOrderApprovalTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "reject_order_approval",
    [
      "Reject a pending ServiceNow order approval (sysapproval_approver row) for a request.",
      "Use this when a manager wants to reject a request from the order-detail approvals section.",
      "Returns refreshed order detail so the widget re-renders with updated approval state."
    ].join(" "),
    {
      orderSysId: z
        .string()
        .min(1)
        .describe("The parent order sys_id (sc_request)."),
      approvalSysId: z
        .string()
        .min(1)
        .describe("The approval row sys_id (sysapproval_approver)."),
      reason: z
        .string()
        .min(1)
        .max(4000)
        .describe("Rejection reason to store in ServiceNow comments.")
    },
    async ({ orderSysId, approvalSysId, reason }) => {
      try {
        return await decideAndRefresh(client, {
          orderSysId,
          approvalSysId,
          decision: "rejected",
          comment: reason
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        Logger.warn("reject_order_approval tool failed", {
          operation: "tool.reject_order_approval",
          orderSysId,
          approvalSysId
        }, error);
        const failure = {
          success: false,
          error: errorMessage,
          message: "Failed to reject the order request",
          orderSysId,
          approvalSysId
        };
        return {
          structuredContent: failure,
          content: [
            {
              type: "text" as const,
              text: `Could not reject order ${orderSysId}: ${errorMessage}`
            }
          ]
        };
      }
    }
  );
}

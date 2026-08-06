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
  await client.decideOrderApproval(input.approvalSysId, input.decision, {
    requestSysId: input.orderSysId,
    comment: input.comment
  });

  return buildOrderDetailResult(client, input.orderSysId, { includeApprovals: true });
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
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: errorMessage,
                message: "Failed to approve the order request",
                orderSysId,
                approvalSysId
              }, null, 2)
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
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: errorMessage,
                message: "Failed to reject the order request",
                orderSysId,
                approvalSysId
              }, null, 2)
            }
          ]
        };
      }
    }
  );
}

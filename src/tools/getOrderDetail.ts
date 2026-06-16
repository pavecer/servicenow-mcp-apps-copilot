import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceNowClient } from "../services/servicenowClient";
import { config } from "../config";

export function registerGetOrderDetailTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "get_order_detail",
    [
      "Retrieve a single ServiceNow service catalog request (sc_request) by sys_id, including its items and approval records.",
      "Use this tool when the user wants to drill into a specific order returned by list_user_orders.",
      "Returns the request header, child request items (with catalog item display data), and approval rows."
    ].join(" "),
    {
      orderSysId: z
        .string()
        .min(1)
        .describe("The sys_id of the order (sc_request). Typically obtained from list_user_orders or the order confirmation."),
      includeApprovals: z
        .boolean()
        .optional()
        .default(true)
        .describe("When true (default), also fetches sysapproval_approver rows for this request.")
    },
    async ({ orderSysId, includeApprovals }) => {
      try {
        const detail = await client.getOrderDetail(orderSysId, { includeApprovals });

        const payload: Record<string, unknown> = {
          success: true,
          order: detail.order,
          items: detail.items,
          approvals: detail.approvals,
          itemCount: detail.items.length,
          approvalCount: detail.approvals.length
        };

        const result: {
          content: Array<{ type: "text"; text: string }>;
          structuredContent?: Record<string, unknown>;
        } = {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(payload, null, 2)
            }
          ]
        };

        // SEP-1865 MCP Apps widget consumes structuredContent at mount time.
        // Cap is 64 KiB inlined; if oversized, the host pulls via tools/call.
        if (config.mcpApps.enabled) {
          const instanceUrl = config.serviceNow.instanceUrl.replace(/\/$/, "");
          const orderSysIdValue =
            typeof detail.order.sys_id === "string" ? detail.order.sys_id : orderSysId;
          result.structuredContent = {
            order: detail.order,
            items: detail.items,
            approvals: detail.approvals,
            // Direct record deep link so the widget's "View in ServiceNow"
            // button works (sandbox-safe via the host bridge openExternal).
            link: orderSysIdValue ? `${instanceUrl}/sc_request.do?sys_id=${orderSysIdValue}` : instanceUrl
          };

          // Keep `content` a concise model-facing summary only — the
          // order-detail widget renders the full request from
          // structuredContent. Returning the full JSON payload here makes
          // Microsoft 365 Copilot render a verbose text fallback instead of
          // mounting the widget. The full JSON stays in `content` only in the
          // default (non-MCP-Apps) surface.
          const orderNumber =
            typeof detail.order.number === "string" ? detail.order.number : orderSysId;
          result.content = [
            {
              type: "text" as const,
              text: `Order ${orderNumber}: ${detail.items.length} item(s), ${detail.approvals.length} approval(s).`
            }
          ];
        }

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: errorMessage,
                message: "Failed to retrieve order detail",
                orderSysId
              }, null, 2)
            }
          ]
        };
      }
    }
  );
}

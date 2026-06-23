import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceNowClient } from "../services/servicenowClient";
import { config } from "../config";

type OrderDetailToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
};

/**
 * Read a ServiceNow field that may be a plain string or, when fetched with
 * sysparm_display_value=all, a { display_value, value } object.
 */
function readField(
  value: unknown,
  prefer: "value" | "display_value"
): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const primary = obj[prefer];
    if (typeof primary === "string" && primary) return primary;
    const fallback = prefer === "value" ? obj.display_value : obj.value;
    if (typeof fallback === "string" && fallback) return fallback;
  }
  return undefined;
}

/**
 * Fetch a request's full detail and shape it into the standard order-detail
 * tool result (text summary + MCP Apps structuredContent bound to the
 * order-detail widget). Shared by get_order_detail and the order item tools so
 * editing/removing a line item re-renders the same widget in place.
 */
export async function buildOrderDetailResult(
  client: ServiceNowClient,
  orderSysId: string,
  options?: { includeApprovals?: boolean }
): Promise<OrderDetailToolResult> {
  const includeApprovals = options?.includeApprovals !== false;
  const detail = await client.getOrderDetail(orderSysId, { includeApprovals });

  const payload: Record<string, unknown> = {
    success: true,
    order: detail.order,
    items: detail.items,
    approvals: detail.approvals,
    itemCount: detail.items.length,
    approvalCount: detail.approvals.length
  };

  const result: OrderDetailToolResult = {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };

  if (config.mcpApps.enabled) {
    const instanceUrl = config.serviceNow.instanceUrl.replace(/\/$/, "");
    const orderSysIdValue = readField(detail.order.sys_id, "value") ?? orderSysId;
    result.structuredContent = {
      order: detail.order,
      items: detail.items,
      approvals: detail.approvals,
      link: orderSysIdValue ? `${instanceUrl}/sc_request.do?sys_id=${orderSysIdValue}` : instanceUrl
    };

    const orderNumber = readField(detail.order.number, "display_value") ?? orderSysId;
    result.content = [
      {
        type: "text" as const,
        text: `Order ${orderNumber}: ${detail.items.length} item(s), ${detail.approvals.length} approval(s).`
      }
    ];
  }

  return result;
}

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
        return await buildOrderDetailResult(client, orderSysId, { includeApprovals });
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

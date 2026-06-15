import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceNowClient } from "../services/servicenowClient";
import { config } from "../config";

// Compact field projection delivered to the SEP-1865 widget. The widget
// itself re-fetches the full record via tools/call when the user clicks an
// order, so the inlined payload stays well under Cowork's 64 KiB cap even
// for the maximum default page size of 50.
function readDisplay(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (record.display_value as string) || (record.value as string) || "";
  }
  return String(value);
}

function toWidgetOrder(order: Record<string, unknown>): Record<string, unknown> {
  return {
    sys_id: readDisplay(order.sys_id),
    number: readDisplay(order.number),
    state: readDisplay(order.state) || readDisplay(order.request_status),
    short_description: readDisplay(order.short_description),
    description: readDisplay(order.description),
    updated_on: readDisplay(order.updated_on) || readDisplay(order.sys_updated_on),
    created_on: readDisplay(order.created_on) || readDisplay(order.sys_created_on),
    assigned_to: readDisplay(order.assigned_to)
  };
}

export function registerListUserOrdersTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "list_user_orders",
    [
      "Retrieve all current (non-closed) orders for the authenticated user.",
      "Lists service catalog orders that are not in a closed/resolved state.",
      "Returns order details including order number, status, description, and assignment information."
    ].join(" "),
    {
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(50)
        .describe("Maximum number of orders to return (default: 50)"),
      fields: z
        .array(z.string())
        .optional()
        .describe(
          "Optional list of specific fields to include in the response. If not provided, returns: sys_id, number, short_description, description, state, assignment_group, assigned_to, created_on, updated_on, request_status"
        )
    },
    async ({ limit, fields }) => {
      try {
        const orders = await client.listUserOrders(limit, fields);

        if (orders.length === 0) {
          const emptyResult: {
            content: Array<{ type: "text"; text: string }>;
            structuredContent?: Record<string, unknown>;
          } = {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  message: "No open orders found for the current user",
                  orders: [],
                  count: 0
                }, null, 2)
              }
            ]
          };
          if (config.mcpApps.enabled) {
            emptyResult.structuredContent = { count: 0, orders: [] };
            emptyResult.content = [
              {
                type: "text" as const,
                text: "The user has no open orders. The empty state is shown above."
              }
            ];
          }
          return emptyResult;
        }

        const result: {
          content: Array<{ type: "text"; text: string }>;
          structuredContent?: Record<string, unknown>;
        } = {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                count: orders.length,
                orders: orders
              }, null, 2)
            }
          ]
        };

        // SEP-1865 MCP Apps: the my-orders widget renders the orders from
        // structuredContent. Keep `content` a concise model-facing summary only
        // — returning the full JSON list makes Microsoft 365 Copilot render a
        // verbose text fallback instead of mounting the widget. The full
        // enrichment stays in the text payload only in the flag-off Copilot
        // Studio surface.
        if (config.mcpApps.enabled) {
          result.structuredContent = {
            count: orders.length,
            orders: orders.map(toWidgetOrder)
          };
          result.content = [
            {
              type: "text" as const,
              text: `Found ${orders.length} open order(s) for the user. They are shown above as a selectable list.`
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
                message: "Failed to retrieve user orders"
              }, null, 2)
            }
          ]
        };
      }
    }
  );
}

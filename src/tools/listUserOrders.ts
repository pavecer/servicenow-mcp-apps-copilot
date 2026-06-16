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
  // sc_request.short_description is usually empty — the meaningful "what was
  // ordered" lives on the child request items (sc_req_item), which
  // listUserOrders enriches with their catalog item. Derive a human label and
  // an item summary so the list card shows the ordered product, not just a
  // bare REQ number.
  const requestItems = Array.isArray(order.requestItems)
    ? (order.requestItems as Array<Record<string, unknown>>)
    : [];
  const itemNames = requestItems
    .map(item => {
      const catalogItem = item.catalogItem as Record<string, unknown> | undefined;
      return (
        readDisplay(catalogItem?.name) ||
        readDisplay(catalogItem?.short_description) ||
        readDisplay(item.short_description) ||
        readDisplay(item.number)
      );
    })
    .filter(name => name.length > 0);
  const firstItem = itemNames[0] || "";
  const itemSummary =
    itemNames.length > 1 ? `${firstItem} +${itemNames.length - 1} more` : firstItem;

  return {
    sys_id: readDisplay(order.sys_id),
    number: readDisplay(order.number),
    state: readDisplay(order.state) || readDisplay(order.request_status),
    // Prefer the request's own short description; otherwise show the ordered
    // catalog item(s) so the card isn't blank.
    short_description: readDisplay(order.short_description) || itemSummary,
    description: readDisplay(order.description),
    itemSummary,
    itemCount: itemNames.length,
    updated_on:
      readDisplay(order.updated_on) || readDisplay(order.sys_updated_on),
    created_on:
      readDisplay(order.created_on) || readDisplay(order.sys_created_on),
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
        .default(10)
        .describe(
          "Maximum number of orders to return, newest activity first. The server caps this at 10 (default: 10)."
        ),
      fields: z
        .array(z.string())
        .optional()
        .describe(
          "Optional list of specific fields to include in the response. If not provided, returns: sys_id, number, short_description, description, state, assignment_group, assigned_to, created_on, updated_on, request_status"
        )
    },
    async ({ limit, fields }) => {
      try {
        // Hard-cap at 10 newest orders regardless of what the model requests —
        // the my-orders widget is a top-10 list, and a larger page is both a
        // UX mess and risks the 64 KiB inlined-result limit once enriched.
        const effectiveLimit = Math.min(limit ?? 10, 10);
        const orders = await client.listUserOrders(effectiveLimit, fields);

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
                text: "No open orders."
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
              text: `${orders.length} open order(s).`
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

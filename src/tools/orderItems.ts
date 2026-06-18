import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceNowClient } from "../services/servicenowClient";
import Logger from "../utils/logger";
import { buildOrderDetailResult } from "./getOrderDetail";

// Fields a requestor may change on an individual requested item (sc_req_item).
// Workflow- and assignment-related fields (state, stage, assigned_to,
// assignment_group, approval, work_notes, …) are intentionally excluded so the
// tool cannot bypass ServiceNow process controls when called with the
// integration-user token.
const ALLOWED_ITEM_UPDATE_FIELDS = [
  "quantity",
  "comments",
  "short_description",
  "description"
] as const;

const itemUpdateFieldSchema = z
  .object({
    quantity: z.union([z.string(), z.number()]).optional(),
    comments: z.string().max(4000).optional(),
    short_description: z.string().min(1).max(160).optional(),
    description: z.string().max(4000).optional()
  })
  .strict();

/**
 * After mutating a line item, return the refreshed parent order so the
 * order-detail widget re-renders in place. Falls back to a minimal success
 * payload when the parent request cannot be resolved (e.g. the last item was
 * removed and the request is empty).
 */
async function refreshedOrderResult(
  client: ServiceNowClient,
  orderItemSysId: string,
  explicitOrderSysId: string | undefined,
  fallback: { success: true; message: string; [key: string]: unknown }
) {
  const orderSysId =
    explicitOrderSysId || (await client.getOrderItemRequestSysId(orderItemSysId));

  if (!orderSysId) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(fallback, null, 2)
        }
      ]
    };
  }

  return buildOrderDetailResult(client, orderSysId);
}

export function registerUpdateOrderItemTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "update_order_item",
    [
      "Update a single requested item (line item) on an existing ServiceNow order from the requestor's perspective.",
      `Allowed fields: ${ALLOWED_ITEM_UPDATE_FIELDS.join(", ")}.`,
      "Use this to change the quantity of one item or add a comment/description to it without touching the rest of the order.",
      "Workflow fields (state, stage, assigned_to, approval) are not modifiable through this tool.",
      "Returns the refreshed order so the order-detail widget re-renders with the updated item."
    ].join(" "),
    {
      orderItemSysId: z
        .string()
        .min(1)
        .describe("The sys_id of the requested item (sc_req_item) to update. Obtained from get_order_detail item rows."),
      orderSysId: z
        .string()
        .min(1)
        .optional()
        .describe("Optional sys_id of the parent order (sc_request). When omitted it is resolved from the item."),
      updates: itemUpdateFieldSchema.describe(
        `Key-value pairs of fields to update. Allowed fields: ${ALLOWED_ITEM_UPDATE_FIELDS.join(", ")}.`
      )
    },
    async ({ orderItemSysId, orderSysId, updates }) => {
      try {
        const sanitizedUpdates: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(updates ?? {})) {
          if ((ALLOWED_ITEM_UPDATE_FIELDS as readonly string[]).includes(key) && value !== undefined) {
            sanitizedUpdates[key] = value;
          }
        }

        if (Object.keys(sanitizedUpdates).length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  error: "No allowed fields provided for update",
                  message: `Specify at least one of: ${ALLOWED_ITEM_UPDATE_FIELDS.join(", ")}`
                }, null, 2)
              }
            ]
          };
        }

        await client.updateOrderItem(orderItemSysId, sanitizedUpdates);

        return await refreshedOrderResult(client, orderItemSysId, orderSysId, {
          success: true,
          message: "Order item updated successfully",
          updatedFields: Object.keys(sanitizedUpdates),
          orderItemSysId
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        Logger.warn("update_order_item tool failed", { operation: "tool.update_order_item", orderItemSysId }, error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: errorMessage,
                message: "Failed to update order item",
                orderItemSysId
              }, null, 2)
            }
          ]
        };
      }
    }
  );
}

export function registerRemoveOrderItemTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "remove_order_item",
    [
      "Remove a single requested item (line item) from an existing ServiceNow order.",
      "Use this when the user wants to drop one item from a multi-item order without cancelling the whole request.",
      "The item (sc_req_item) is deleted in ServiceNow; the rest of the order is left intact.",
      "Returns the refreshed order so the order-detail widget re-renders without the removed item."
    ].join(" "),
    {
      orderItemSysId: z
        .string()
        .min(1)
        .describe("The sys_id of the requested item (sc_req_item) to remove. Obtained from get_order_detail item rows."),
      orderSysId: z
        .string()
        .min(1)
        .optional()
        .describe("Optional sys_id of the parent order (sc_request). When omitted it is resolved from the item before removal.")
    },
    async ({ orderItemSysId, orderSysId }) => {
      try {
        // Resolve the parent BEFORE deleting so we can still refresh the order
        // view afterwards (the item row is gone once removed).
        const parentOrderSysId =
          orderSysId || (await client.getOrderItemRequestSysId(orderItemSysId));

        await client.removeOrderItem(orderItemSysId);

        return await refreshedOrderResult(client, orderItemSysId, parentOrderSysId, {
          success: true,
          message: "Order item removed successfully",
          orderItemSysId
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        Logger.warn("remove_order_item tool failed", { operation: "tool.remove_order_item", orderItemSysId }, error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: errorMessage,
                message: "Failed to remove order item",
                orderItemSysId
              }, null, 2)
            }
          ]
        };
      }
    }
  );
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceNowClient } from "../services/servicenowClient";

// Fields that an end-user (the requestor) is allowed to update on their own
// sc_request record. Workflow- and assignment-related fields (state,
// assigned_to, assignment_group, requested_for, approval, work_notes, etc.)
// are intentionally excluded so this tool cannot be used to bypass ServiceNow
// process controls when the call is made with the integration user token.
const ALLOWED_UPDATE_FIELDS = [
  "short_description",
  "description",
  "comments",
  "urgency",
  "priority"
] as const;

const updateFieldSchema = z
  .object({
    short_description: z.string().min(1).max(160).optional(),
    description: z.string().max(4000).optional(),
    comments: z.string().max(4000).optional(),
    urgency: z.union([z.string(), z.number()]).optional(),
    priority: z.union([z.string(), z.number()]).optional()
  })
  .strict();

export function registerUpdateOrderTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "update_order",
    [
      "Update a service catalog order from the requestor's perspective.",
      "Allows the end user (requestor) to update a small set of mutable fields on their own order.",
      `Allowed fields: ${ALLOWED_UPDATE_FIELDS.join(", ")}.`,
      "Workflow fields (state, assigned_to, assignment_group, requested_for, approval) are not modifiable through this tool.",
      "The order is updated directly in ServiceNow and returns the updated order details."
    ].join(" "),
    {
      orderSysId: z
        .string()
        .min(1)
        .describe("The sys_id of the order (sc_request) to update. Can be obtained from list_user_orders or the order confirmation."),
      updates: updateFieldSchema.describe(
        `Key-value pairs of fields to update. Allowed fields: ${ALLOWED_UPDATE_FIELDS.join(", ")}.`
      )
    },
    async ({ orderSysId, updates }) => {
      try {
        // Belt-and-braces: even though the Zod schema is strict, double-check
        // at runtime so a future schema change cannot accidentally widen the
        // surface area for a privileged integration-user token.
        const sanitizedUpdates: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(updates ?? {})) {
          if ((ALLOWED_UPDATE_FIELDS as readonly string[]).includes(key) && value !== undefined) {
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
                  message: `Specify at least one of: ${ALLOWED_UPDATE_FIELDS.join(", ")}`
                }, null, 2)
              }
            ]
          };
        }

        const updatedOrder = await client.updateOrder(orderSysId, sanitizedUpdates);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: "Order updated successfully",
                updatedFields: Object.keys(sanitizedUpdates),
                updatedOrder: updatedOrder
              }, null, 2)
            }
          ]
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: errorMessage,
                message: "Failed to update order",
                orderSysId: orderSysId
              }, null, 2)
            }
          ]
        };
      }
    }
  );
}

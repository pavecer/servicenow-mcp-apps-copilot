import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceNowClient } from "../services/servicenowClient";
import { buildOrderConfirmationAdaptiveCard } from "../utils/adaptiveCards";
import { config } from "../config";
import Logger from "../utils/logger";

export function registerPlaceOrderTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "place_order",
    [
      "Submit an order for a ServiceNow catalog item using the field values collected from the user.",
      "Use this tool after the user has filled in all required fields from the get_catalog_item_form result.",
      "Returns an Adaptive Card with the order confirmation, including the request number, status, and a direct link to the request in ServiceNow."
    ].join(" "),
    {
      itemSysId: z
        .string()
        .min(1)
        .describe("The sys_id of the catalog item to order (from search_catalog_items or get_catalog_item_form)"),
      variables: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .describe(
          "Key-value pairs mapping each form field name (variable.name) to the value provided by the user"
        ),
      quantity: z
        .number()
        .int()
        .positive()
        .optional()
        .default(1)
        .describe("Quantity to order (default: 1)"),
      requestedFor: z
        .string()
        .optional()
        .describe(
          "Optional sys_id or email address of the user the item is being ordered for (defaults to the authenticated user)"
        )
    },
    async ({ itemSysId, variables, quantity, requestedFor }) => {
      const response = await client.placeOrder(itemSysId, {
        variables,
        quantity,
        requestedFor
      });

      const adaptiveCard = buildOrderConfirmationAdaptiveCard(
        response.result,
        config.serviceNow.instanceUrl
      );

      const requestId = response.result.request_id ?? null;
      const requestNumber = response.result.request_number;
      const instanceUrl = config.serviceNow.instanceUrl.replace(/\/$/, "");
      // Direct form deep link. Avoid the nav_to.do?uri=sc_request.do?sys_id=
      // wrapper — its nested, unencoded `?` makes ServiceNow throw an
      // "Invalid URL" / record-not-found error when opened straight from the
      // widget. The plain record URL opens the request reliably.
      const requestLink = requestId
        ? `${instanceUrl}/sc_request.do?sys_id=${requestId}`
        : instanceUrl;

      const payload: Record<string, unknown> = {
        success: true,
        requestNumber,
        requestId,
        adaptiveCard
      };

      if (config.serviceNow.requestedForDiagnosticsEnabled) {
        payload.requestedForDiagnostics = response.requestedForDiagnostics;
      }

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

      // SEP-1865 MCP Apps: render the placed order as the order-detail widget so
      // the user sees the whole ordered request (items, status, ServiceNow link)
      // instead of a plain-text request number. We fetch the created request;
      // if that lookup fails (timing/permissions) we still mount the widget with
      // a minimal "submitted" payload so the confirmation is never a dead end.
      if (config.mcpApps.enabled) {
        let order: Record<string, unknown> = {
          number: requestNumber,
          sys_id: requestId ?? "",
          state: "Submitted",
          short_description: `Order ${requestNumber}`
        };
        let items: Array<Record<string, unknown>> = [];
        let approvals: Array<Record<string, unknown>> = [];

        if (requestId) {
          try {
            const detail = await client.getOrderDetail(requestId, { includeApprovals: true });
            order = detail.order;
            items = detail.items;
            approvals = detail.approvals;
          } catch (error) {
            Logger.warn("Order placed but detail lookup failed; rendering minimal confirmation", {
              operation: "order.place_detail_lookup_failed",
              requestId
            }, error);
          }
        }

        result.structuredContent = {
          submitted: true,
          requestNumber,
          link: requestLink,
          order,
          items,
          approvals
        };

        // Concise model-facing summary only — the widget shows the full
        // confirmation. Avoid restating the request number/status in prose so
        // Microsoft 365 Copilot mounts the widget instead of a text fallback.
        result.content = [
          {
            type: "text" as const,
            text: `Order ${requestNumber} was submitted to ServiceNow. The confirmation is shown above for the user.`
          }
        ];
      }

      return result;
    }
  );
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceNowClient } from "../services/servicenowClient";
import { config } from "../config";
import Logger from "../utils/logger";
import type { ServiceNowCart } from "../types/servicenow";

// ── ServiceNow cart / basket MCP tools (SEP-1865 MCP Apps only) ─────────────
// These tools are registered ONLY when MCP_APPS_ENABLED=true. They let the user
// build a multi-item basket (the same server-side cart the ServiceNow portal
// uses) and submit it as a single request. The cart is keyed to the
// authenticated ServiceNow user, so this is only correct under per-user
// identity (caller token / OBO) — the same auth path the other tools use.

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
};

/** Compact cart projection for the cart widget's structuredContent. */
function projectCart(cart: ServiceNowCart): Record<string, unknown> {
  return {
    cartId: cart.cartId ?? null,
    subtotalPrice: cart.subtotalPrice ?? null,
    subtotalRecurringPrice: cart.subtotalRecurringPrice ?? null,
    subtotalRecurringFrequency: cart.subtotalRecurringFrequency ?? null,
    items: cart.items.map(line => ({
      cartItemId: line.cartItemId,
      catalogItemId: line.catalogItemId ?? null,
      name: line.name,
      quantity: line.quantity,
      price: line.price ?? null,
      recurringPrice: line.recurringPrice ?? null,
      recurringFrequency: line.recurringFrequency ?? null,
      shortDescription: line.shortDescription ?? null
    }))
  };
}

/** One-line model-facing summary of the cart. */
function summarizeCart(cart: ServiceNowCart): string {
  const count = cart.items.reduce((sum, line) => sum + (line.quantity || 1), 0);
  const lines = cart.items.length;
  if (lines === 0) {
    return "The ServiceNow cart is empty.";
  }
  const subtotal = cart.subtotalPrice ? ` Subtotal ${cart.subtotalPrice}.` : "";
  return `Cart: ${lines} line item(s), ${count} unit(s) total.${subtotal}`;
}

/** Builds the standard tool result for any cart-mutating/read operation. */
function cartResult(cart: ServiceNowCart): ToolResult {
  const projected = projectCart(cart);
  const result: ToolResult = {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ success: true, cart: projected }, null, 2)
      }
    ]
  };

  if (config.mcpApps.enabled) {
    result.structuredContent = { cart: projected };
    result.content = [{ type: "text" as const, text: summarizeCart(cart) }];
  }

  return result;
}

function cartFailure(operation: string, error: unknown, extra?: Record<string, unknown>): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ success: false, error: message, operation, ...extra }, null, 2)
      }
    ]
  };
}

export function registerAddToCartTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "add_to_cart",
    [
      "Add a ServiceNow catalog item to the user's cart (basket) without ordering yet.",
      "Use this when the user wants to collect multiple items before checking out, instead of place_order which submits a single item immediately.",
      "Mandatory item variables are required, exactly as for place_order. Returns the updated cart."
    ].join(" "),
    {
      itemSysId: z
        .string()
        .min(1)
        .describe("The sys_id of the catalog item to add (from search_catalog_items or get_catalog_item_form)"),
      variables: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Key-value pairs mapping each form field name (variable.name) to the value provided by the user"),
      quantity: z
        .number()
        .int()
        .positive()
        .optional()
        .default(1)
        .describe("Quantity to add (default: 1)")
    },
    async ({ itemSysId, variables, quantity }) => {
      try {
        const cart = await client.addToCart(itemSysId, { variables, quantity });
        return cartResult(cart);
      } catch (error) {
        Logger.warn("add_to_cart tool failed", { operation: "tool.add_to_cart", itemSysId }, error);
        return cartFailure("add_to_cart", error, { itemSysId });
      }
    }
  );
}

export function registerViewCartTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "view_cart",
    [
      "Retrieve the authenticated user's current ServiceNow cart (basket) contents.",
      "Returns each line item with its quantity and price plus the cart subtotal. Use before submit_cart to review the basket."
    ].join(" "),
    {},
    async () => {
      try {
        const cart = await client.getCart();
        return cartResult(cart);
      } catch (error) {
        Logger.warn("view_cart tool failed", { operation: "tool.view_cart" }, error);
        return cartFailure("view_cart", error);
      }
    }
  );
}

export function registerUpdateCartItemTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "update_cart_item",
    [
      "Update a line item already in the ServiceNow cart — change its quantity and/or variable values.",
      "Use the cartItemId returned by add_to_cart or view_cart. Returns the updated cart."
    ].join(" "),
    {
      cartItemId: z
        .string()
        .min(1)
        .describe("The cart line identifier (cartItemId) from add_to_cart or view_cart"),
      quantity: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("New quantity for the line item"),
      variables: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Updated key-value pairs for the item's form fields")
    },
    async ({ cartItemId, quantity, variables }) => {
      if (quantity == null && (!variables || Object.keys(variables).length === 0)) {
        return cartFailure("update_cart_item", new Error("Provide quantity and/or variables to update."), {
          cartItemId
        });
      }
      try {
        const cart = await client.updateCartItem(cartItemId, { quantity, variables });
        return cartResult(cart);
      } catch (error) {
        Logger.warn("update_cart_item tool failed", { operation: "tool.update_cart_item", cartItemId }, error);
        return cartFailure("update_cart_item", error, { cartItemId });
      }
    }
  );
}

export function registerRemoveCartItemTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "remove_cart_item",
    [
      "Remove a single line item from the ServiceNow cart.",
      "Use the cartItemId returned by add_to_cart or view_cart. Returns the updated cart."
    ].join(" "),
    {
      cartItemId: z
        .string()
        .min(1)
        .describe("The cart line identifier (cartItemId) to remove")
    },
    async ({ cartItemId }) => {
      try {
        const cart = await client.removeCartItem(cartItemId);
        return cartResult(cart);
      } catch (error) {
        Logger.warn("remove_cart_item tool failed", { operation: "tool.remove_cart_item", cartItemId }, error);
        return cartFailure("remove_cart_item", error, { cartItemId });
      }
    }
  );
}

export function registerSubmitCartTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "submit_cart",
    [
      "Submit the entire ServiceNow cart as a single request (one REQ with multiple requested items).",
      "Use this after the user has finished adding items with add_to_cart and reviewed them with view_cart.",
      "Returns the created request so it can be shown as an order confirmation."
    ].join(" "),
    {
      requestedFor: z
        .string()
        .optional()
        .describe("Optional sys_id or email of the user the order is for (defaults to the authenticated user)")
    },
    async ({ requestedFor }) => {
      try {
        const response = await client.submitCart({ requestedFor });
        const requestNumber = response.result.request_number;
        const requestId = response.result.request_id ?? response.result.sys_id ?? null;
        const instanceUrl = config.serviceNow.instanceUrl.replace(/\/$/, "");
        const requestLink = requestId ? `${instanceUrl}/sc_request.do?sys_id=${requestId}` : instanceUrl;

        const payload: Record<string, unknown> = {
          success: true,
          requestNumber,
          requestId
        };
        if (config.serviceNow.requestedForDiagnosticsEnabled) {
          payload.requestedForDiagnostics = response.requestedForDiagnostics;
        }

        const result: ToolResult = {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }]
        };

        // SEP-1865 MCP Apps: render the submitted cart as the order-detail
        // widget (the same confirmation place_order uses). Fetch the created
        // request; on failure still mount a minimal confirmation so checkout is
        // never a dead end.
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
              Logger.warn("Cart submitted but detail lookup failed; rendering minimal confirmation", {
                operation: "cart.submit_detail_lookup_failed",
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
          result.content = [
            { type: "text" as const, text: `Cart submitted to ServiceNow as ${requestNumber}.` }
          ];
        }

        return result;
      } catch (error) {
        Logger.warn("submit_cart tool failed", { operation: "tool.submit_cart" }, error);
        return cartFailure("submit_cart", error);
      }
    }
  );
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CART_HTML,
  CATALOG_BROWSE_HTML,
  MY_ORDERS_HTML,
  ORDER_DETAIL_HTML,
  ORDER_FORM_HTML
} from "./widgets/generated";
import { config } from "../config";
import Logger from "../utils/logger";

/**
 * SEP-1865 "MCP Apps" widget registry.
 *
 * Each widget is an HTML resource served via the MCP `resources/read` request
 * with mime type `text/html;profile=mcp-app`. The HTML body is fully
 * self-contained (inline CSS + JS, no external fetches) so it runs inside the
 * sandboxed iframe Microsoft 365 Copilot Cowork provides.
 *
 * The widget is associated with a tool by setting `_meta.ui.resourceUri` on
 * the tool's `tools/list` entry. After a tool call, Cowork mounts the widget
 * and delivers the tool's `structuredContent` to it via the host bridge.
 *
 * Reference:
 *   https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-mcp-apps
 *   https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/mcp-apps-support
 *   https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 *
 * Cowork only honours `csp.frameDomains` (not `connectDomains` / `resourceDomains`)
 * and the camelCase permission allowlist:
 *   camera, microphone, geolocation, clipboardWrite.
 */

export interface WidgetDescriptor {
  /**
   * Tool name this widget is associated with. The matching `tools/list` entry
   * gets `_meta.ui.resourceUri = <uri>` when the feature flag is on.
   */
  toolName: string;
  /**
   * Additional tool names that should mount this same widget. Lets several
   * tools share one widget (e.g. both `get_order_detail` and `place_order`
   * render the order-detail widget so a placed order shows the full request).
   */
  boundToolNames?: string[];
  /**
   * Stable resource URI. Cowork enforces the `ui://` scheme and a 1024-char
   * cap.
   */
  uri: string;
  /**
   * Logical resource name used in MCP `resources/list`.
   */
  name: string;
  /**
   * Short human-readable description surfaced in `resources/list`.
   */
  description: string;
  /**
   * Inline HTML body of the widget. Already template-literal-escaped.
   */
  html: string;
  /**
   * Optional `_meta.ui.csp.frameDomains` (only nested-iframe origins are
   * honoured by Cowork).
   */
  frameDomains?: string[];
  /**
   * Optional `_meta.ui.permissions` (camelCase tokens — Cowork rejects
   * hyphenated W3C spellings).
   */
  permissions?: Array<"camera" | "microphone" | "geolocation" | "clipboardWrite">;
}

const WIDGET_URI_NAMESPACE = "ui://servicenow-mcp";

export const WIDGETS: readonly WidgetDescriptor[] = [
  {
    toolName: "search_catalog_items",
    uri: `${WIDGET_URI_NAMESPACE}/catalog-browse.html`,
    name: "catalog-browse",
    description: "Browse ServiceNow catalog search results as a grid of cards.",
    html: CATALOG_BROWSE_HTML,
    permissions: ["clipboardWrite"]
  },
  {
    toolName: "get_catalog_item_form",
    uri: `${WIDGET_URI_NAMESPACE}/order-form.html`,
    name: "order-form",
    description: "Render a ServiceNow catalog order form and submit place_order.",
    html: ORDER_FORM_HTML,
    permissions: ["clipboardWrite"]
  },
  {
    toolName: "list_user_orders",
    uri: `${WIDGET_URI_NAMESPACE}/my-orders.html`,
    name: "my-orders",
    description: "List the authenticated user's open ServiceNow orders.",
    html: MY_ORDERS_HTML,
    permissions: ["clipboardWrite"]
  },
  {
    toolName: "get_order_detail",
    // place_order also mounts this widget: after a successful order we fetch
    // the created request and render it here as the confirmation, so the user
    // sees the whole ordered item (items, status, ServiceNow link) instead of
    // a plain-text request number. submit_cart reuses the same confirmation.
    // update_order_item/remove_order_item also return order-detail
    // structuredContent so editing or removing a line item re-renders this
    // widget in place.
    boundToolNames: ["place_order", "submit_cart", "update_order_item", "remove_order_item"],
    uri: `${WIDGET_URI_NAMESPACE}/order-detail.html`,
    name: "order-detail",
    description: "Show a single ServiceNow request with items, approvals, and a comment form.",
    html: ORDER_DETAIL_HTML,
    permissions: ["clipboardWrite"]
  },
  {
    toolName: "view_cart",
    // All cart-mutating tools render the same cart widget so add/update/remove
    // re-render the cart in place.
    boundToolNames: ["add_to_cart", "update_cart_item", "remove_cart_item"],
    uri: `${WIDGET_URI_NAMESPACE}/cart.html`,
    name: "cart",
    description: "Show the user's ServiceNow cart with quantity controls and a submit action.",
    html: CART_HTML,
    permissions: ["clipboardWrite"]
  }
];

const WIDGETS_BY_TOOL = new Map<string, WidgetDescriptor>();
for (const widget of WIDGETS) {
  WIDGETS_BY_TOOL.set(widget.toolName, widget);
  for (const bound of widget.boundToolNames ?? []) {
    WIDGETS_BY_TOOL.set(bound, widget);
  }
}

/**
 * Look up the widget associated with a tool, returning `undefined` if the
 * MCP Apps feature flag is off or no widget exists for that tool.
 */
export function getWidgetForTool(toolName: string): WidgetDescriptor | undefined {
  if (!config.mcpApps.enabled) return undefined;
  return WIDGETS_BY_TOOL.get(toolName);
}

/**
 * Register all SEP-1865 widget resources on the given MCP server.
 *
 * No-op when `config.mcpApps.enabled` is false — this is the single safety
 * gate that keeps the default (non-MCP-Apps) surface byte-identical.
 */
export function registerWidgetResources(server: McpServer): void {
  if (!config.mcpApps.enabled) return;

  for (const widget of WIDGETS) {
    server.registerResource(
      widget.name,
      widget.uri,
      {
        title: widget.description,
        mimeType: "text/html;profile=mcp-app"
      },
      async () => {
        // Build the `_meta.ui` block exactly as SEP-1865 specifies:
        // csp and permissions belong on the UI resource, NOT on the tool.
        const meta: Record<string, unknown> = {};
        const ui: Record<string, unknown> = {};
        if (widget.frameDomains && widget.frameDomains.length > 0) {
          ui.csp = { frameDomains: widget.frameDomains };
        }
        if (widget.permissions && widget.permissions.length > 0) {
          ui.permissions = widget.permissions;
        }
        if (Object.keys(ui).length > 0) {
          meta.ui = ui;
        }

        return {
          contents: [
            {
              uri: widget.uri,
              mimeType: "text/html;profile=mcp-app",
              text: widget.html,
              ...(Object.keys(meta).length > 0 ? { _meta: meta } : {})
            }
          ]
        };
      }
    );
  }

  Logger.info("Registered MCP App widget resources", {
    operation: "mcp_apps.widgets_registered",
    count: WIDGETS.length
  });
}

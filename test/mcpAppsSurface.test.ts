import { describe, it, expect } from "vitest";
import { getMinimalToolDefinitions } from "../src/tools/index";
import { WIDGETS, getWidgetForTool } from "../src/ui/widgets";

// MCP Apps is always on: this server targets the SEP-1865 widget surface. These
// tests assert the widget registry, the tool/widget binding via `_meta.ui`, and
// the widget-resource registration are all wired up.

describe("MCP Apps surface", () => {
  it("WIDGETS registry exposes exactly eight widgets with ui:// URIs", () => {
    expect(WIDGETS.length).toBe(8);
    const toolNames = WIDGETS.map(w => w.toolName).sort();
    expect(toolNames).toEqual([
      "get_catalog_item_form",
      "get_incident_detail",
      "get_incident_form",
      "get_order_detail",
      "list_user_incidents",
      "list_user_orders",
      "search_catalog_items",
      "view_cart"
    ]);
    for (const w of WIDGETS) {
      expect(w.uri.startsWith("ui://")).toBe(true);
      expect(w.uri.length).toBeLessThanOrEqual(1024);
      expect(w.html.includes("<!doctype html>")).toBe(true);
    }
  });

  it("getWidgetForTool resolves widget-backed tools and returns undefined otherwise", () => {
    expect(getWidgetForTool("search_catalog_items")?.uri).toMatch(/catalog-browse\.html$/);
    expect(getWidgetForTool("place_order")?.uri).toMatch(/order-detail\.html$/);
    expect(getWidgetForTool("validate_servicenow_config")).toBeUndefined();
    expect(getWidgetForTool("update_order")).toBeUndefined();
  });

  it("tool manifest carries _meta.ui.resourceUri on the widget-backed tools and ONLY those", () => {
    const defs = getMinimalToolDefinitions();
    const widgetToolNames = new Map<string, RegExp>([
      ["search_catalog_items", /catalog-browse\.html$/],
      ["get_catalog_item_form", /order-form\.html$/],
      ["list_user_orders", /my-orders\.html$/],
      ["get_order_detail", /order-detail\.html$/],
      // place_order is bound to the order-detail widget so a placed order
      // renders as the confirmation widget.
      ["place_order", /order-detail\.html$/],
      // Cart tools: view/add/update/remove render the cart widget; submit_cart
      // reuses the order-detail confirmation widget.
      ["view_cart", /cart\.html$/],
      ["add_to_cart", /cart\.html$/],
      ["update_cart_item", /cart\.html$/],
      ["remove_cart_item", /cart\.html$/],
      ["submit_cart", /order-detail\.html$/],
      // Order line-item tools re-render the order-detail widget in place.
      ["update_order_item", /order-detail\.html$/],
      ["remove_order_item", /order-detail\.html$/],
      // Incident tools: form, list, detail. report_incident + add_incident_comment
      // render the incident-detail widget.
      ["get_incident_form", /incident-form\.html$/],
      ["list_user_incidents", /my-incidents\.html$/],
      ["get_incident_detail", /incident-detail\.html$/],
      ["report_incident", /incident-detail\.html$/],
      ["add_incident_comment", /incident-detail\.html$/],
      ["add_incident_attachment", /incident-detail\.html$/]
    ]);
    for (const def of defs) {
      const meta = (def as { _meta?: { ui?: { resourceUri?: string; visibility?: string[] } } })._meta;
      const expected = widgetToolNames.get(def.name);
      if (expected) {
        expect(meta?.ui?.resourceUri).toMatch(expected);
        expect(meta?.ui?.visibility).toEqual(["model", "app"]);
      } else {
        expect(meta).toBeUndefined();
      }
    }
  });
});

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Verifies the MCP_APPS_ENABLED feature flag gates every SEP-1865-specific
// behavior. We import each flag state ONCE per describe block (instead of
// re-importing per test) to keep the suite cheap — re-importing src/tools
// pulls the full transitive graph (axios, msal, adaptive-cards utils, ...)
// which is slow enough to disturb other parallel suites if done per-test.

async function loadWithFlag(enabled: boolean) {
  process.env.MCP_APPS_ENABLED = enabled ? "true" : "false";
  vi.resetModules();
  const tools = await import("../src/tools/index");
  const widgets = await import("../src/ui/widgets");
  const cfg = await import("../src/config");
  return { tools, widgets, config: cfg.config };
}

describe("MCP Apps gating: MCP_APPS_ENABLED=false (default)", () => {
  const originalFlag = process.env.MCP_APPS_ENABLED;
  let loaded: Awaited<ReturnType<typeof loadWithFlag>>;

  beforeAll(async () => {
    loaded = await loadWithFlag(false);
  });
  afterAll(() => {
    if (originalFlag === undefined) delete process.env.MCP_APPS_ENABLED;
    else process.env.MCP_APPS_ENABLED = originalFlag;
  });

  it("config.mcpApps.enabled is false", () => {
    expect(loaded.config.mcpApps.enabled).toBe(false);
  });

  it("tool manifest carries NO _meta on any tool", () => {
    const defs = loaded.tools.getMinimalToolDefinitions();
    for (const def of defs) {
      expect((def as { _meta?: unknown })._meta).toBeUndefined();
    }
  });

  it("getWidgetForTool returns undefined for every tool name", () => {
    const names = [
      "search_catalog_items",
      "get_catalog_item_form",
      "list_user_orders",
      "get_order_detail",
      "place_order",
      "update_order",
      "validate_servicenow_config"
    ];
    for (const name of names) {
      expect(loaded.widgets.getWidgetForTool(name)).toBeUndefined();
    }
  });
});

describe("MCP Apps gating: MCP_APPS_ENABLED=true", () => {
  const originalFlag = process.env.MCP_APPS_ENABLED;
  let loaded: Awaited<ReturnType<typeof loadWithFlag>>;

  beforeAll(async () => {
    loaded = await loadWithFlag(true);
  });
  afterAll(() => {
    if (originalFlag === undefined) delete process.env.MCP_APPS_ENABLED;
    else process.env.MCP_APPS_ENABLED = originalFlag;
  });

  it("config.mcpApps.enabled is true", () => {
    expect(loaded.config.mcpApps.enabled).toBe(true);
  });

  it("WIDGETS registry exposes exactly five widgets with ui:// URIs", () => {
    expect(loaded.widgets.WIDGETS.length).toBe(5);
    const toolNames = loaded.widgets.WIDGETS.map(w => w.toolName).sort();
    expect(toolNames).toEqual([
      "get_catalog_item_form",
      "get_order_detail",
      "list_user_orders",
      "search_catalog_items",
      "view_cart"
    ]);
    for (const w of loaded.widgets.WIDGETS) {
      expect(w.uri.startsWith("ui://")).toBe(true);
      expect(w.uri.length).toBeLessThanOrEqual(1024);
      expect(w.html.includes("<!doctype html>")).toBe(true);
    }
  });

  it("tool manifest carries _meta.ui.resourceUri on the widget-backed tools and ONLY those", () => {
    const defs = loaded.tools.getMinimalToolDefinitions();
    // The four widget-owning tools plus place_order, which is bound to the
    // order-detail widget so a placed order renders as the confirmation widget.
    const widgetToolNames = new Map<string, RegExp>([
      ["search_catalog_items", /catalog-browse\.html$/],
      ["get_catalog_item_form", /order-form\.html$/],
      ["list_user_orders", /my-orders\.html$/],
      ["get_order_detail", /order-detail\.html$/],
      ["place_order", /order-detail\.html$/],
      // Cart tools: view/add/update/remove render the cart widget; submit_cart
      // reuses the order-detail confirmation widget.
      ["view_cart", /cart\.html$/],
      ["add_to_cart", /cart\.html$/],
      ["update_cart_item", /cart\.html$/],
      ["remove_cart_item", /cart\.html$/],
      ["submit_cart", /order-detail\.html$/]
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

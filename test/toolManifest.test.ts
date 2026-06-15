import { describe, it, expect } from "vitest";
import { getMinimalToolDefinitions } from "../src/tools/index";

describe("getMinimalToolDefinitions", () => {
  const tools = getMinimalToolDefinitions();
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));

  it("exposes exactly the seven expected MCP tools", () => {
    expect(tools.map(t => t.name).sort()).toEqual([
      "get_catalog_item_form",
      "get_order_detail",
      "list_user_orders",
      "place_order",
      "search_catalog_items",
      "update_order",
      "validate_servicenow_config"
    ]);
  });

  it("each tool definition has a name, description, and object inputSchema", () => {
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(0);
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.properties).toBeTypeOf("object");
    }
  });

  it("place_order accepts string|number|boolean variable values", () => {
    const variables = (
      ((byName.place_order.inputSchema as Record<string, unknown>).properties as Record<string, unknown>).variables as Record<string, unknown>
    );
    const additional = variables.additionalProperties as Record<string, unknown>;
    expect(additional.type).toEqual(["string", "number", "boolean"]);
  });

  it("search_catalog_items.limit is bounded 1..50", () => {
    const limit = (
      ((byName.search_catalog_items.inputSchema as Record<string, unknown>).properties as Record<string, unknown>).limit as Record<string, unknown>
    );
    expect(limit.type).toBe("integer");
    expect(limit.minimum).toBe(1);
    expect(limit.maximum).toBe(50);
  });

  it("update_order rejects unknown fields via additionalProperties:false", () => {
    const updates = (
      ((byName.update_order.inputSchema as Record<string, unknown>).properties as Record<string, unknown>).updates as Record<string, unknown>
    );
    expect(updates.additionalProperties).toBe(false);
    const props = updates.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual([
      "comments",
      "description",
      "priority",
      "short_description",
      "urgency"
    ]);
  });

  it("validate_servicenow_config uses the renamed forceConfiguredCredentials parameter", () => {
    const props = (
      (byName.validate_servicenow_config.inputSchema as Record<string, unknown>).properties as Record<string, unknown>
    );
    expect(props.forceConfiguredCredentials).toBeDefined();
    expect(props.forceClientCredentials).toBeUndefined();
  });
});

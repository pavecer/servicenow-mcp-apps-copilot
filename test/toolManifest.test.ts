import { describe, it, expect } from "vitest";
import { getMinimalToolDefinitions } from "../src/tools/index";

describe("getMinimalToolDefinitions", () => {
  const tools = getMinimalToolDefinitions();
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));

  it("exposes exactly the expected MCP Apps tools", () => {
    expect(tools.map(t => t.name).sort()).toEqual([
      "add_incident_attachment",
      "add_incident_comment",
      "add_to_cart",
      "approve_order_approval",
      "create_incident_from_knowledge",
      "get_catalog_item_form",
      "get_incident_detail",
      "get_incident_form",
      "get_knowledge_article",
      "get_order_detail",
      "list_user_incidents",
      "list_user_orders",
      "place_order",
      "reject_order_approval",
      "remove_cart_item",
      "remove_incident_attachment",
      "remove_order_item",
      "report_incident",
      "search_catalog_items",
      "search_knowledge",
      "submit_cart",
      "submit_knowledge_feedback",
      "update_cart_item",
      "update_order",
      "update_order_item",
      "validate_servicenow_config",
      "view_cart"
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

  it("marks Knowledge incident escalation as mutating and constrains consent inputs", () => {
    const definition = byName.create_incident_from_knowledge;
    expect(definition.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false
    });
    const props = (definition.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props.userConfirmed.enum).toEqual([true]);
    expect(props.attemptCount.enum).toEqual([3]);
    expect(props.urgency.enum).toEqual(["1", "2", "3"]);
    expect(props.impact.enum).toEqual(["1", "2", "3"]);
  });

  it("marks native Knowledge feedback as mutating and constrains native values", () => {
    const definition = byName.submit_knowledge_feedback;
    expect(definition.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    const props = (definition.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props.useful.enum).toEqual(["yes", "no"]);
    expect(props.reason.enum).toEqual(["1", "2", "3", "4"]);
    expect(props.rating).toMatchObject({ minimum: 1, maximum: 5 });
  });
});

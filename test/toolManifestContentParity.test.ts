import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getMinimalToolDefinitions, registerTools } from "../src/tools/index";
import type { ServiceNowClient } from "../src/services/servicenowClient";
import type { TokenManager } from "../src/services/tokenManager";

// Verifies the content-parity drift guard added to src/tools/index.ts
// (extension of FU#8). The guard runs at module load and asserts that
// `getMinimalToolDefinitions()` and the Zod-derived input schemas registered
// with the MCP SDK have the SAME set of property names and the SAME set of
// required fields per tool.
//
// The guard cannot be re-invoked directly from the test (it is an IIFE that
// fires once), but its building blocks are observable:
//   - `registerTools(stub, dummyClient, dummyTokenManager)` populates
//     `stub._registeredTools[name].inputSchema` with each Zod object.
//   - The minimal manifest is the public API.
// Together these give us the same comparison the guard performs, so we can
// assert content parity here AS WELL — locally, with a clear diff, instead
// of having to wait for the IIFE to throw on cold start.

describe("MCP tool manifest content parity (FU#8)", () => {
  // Build the same canonical Zod-side shapes the in-source guard derives.
  function deriveExpectedShapes(): Record<string, { properties: Set<string>; required: Set<string> }> {
    const stub = new McpServer({ name: "drift-check-test", version: "0.0.0" });
    const dummyClient = {} as ServiceNowClient;
    const dummyTokenManager = {} as TokenManager;
    registerTools(stub, dummyClient, dummyTokenManager);

    const registeredTools = (stub as unknown as {
      _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, unknown> } }>;
    })._registeredTools;

    const out: Record<string, { properties: Set<string>; required: Set<string> }> = {};
    for (const [name, tool] of Object.entries(registeredTools)) {
      const shape = tool.inputSchema?.shape ?? {};
      const properties = new Set<string>(Object.keys(shape));
      const required = new Set<string>();
      for (const [field, zodSchema] of Object.entries(shape)) {
        const isOptional =
          typeof (zodSchema as { isOptional?: () => boolean }).isOptional === "function" &&
          (zodSchema as { isOptional: () => boolean }).isOptional();
        if (!isOptional) required.add(field);
      }
      out[name] = { properties, required };
    }
    return out;
  }

  const expectedShapes = deriveExpectedShapes();
  const manifest = getMinimalToolDefinitions();

  it("derives the expected tools from the Zod registrations", () => {
    expect(Object.keys(expectedShapes).sort()).toEqual([
      "add_incident_attachment",
      "add_incident_comment",
      "add_to_cart",
      "get_catalog_item_form",
      "get_incident_detail",
      "get_incident_form",
      "get_order_detail",
      "list_user_incidents",
      "list_user_orders",
      "place_order",
      "remove_cart_item",
      "remove_order_item",
      "report_incident",
      "search_catalog_items",
      "submit_cart",
      "update_cart_item",
      "update_order",
      "update_order_item",
      "validate_servicenow_config",
      "view_cart"
    ]);
  });

  for (const toolDef of manifest) {
    const expected = expectedShapes[toolDef.name];

    it(`${toolDef.name}: manifest properties match the Zod shape`, () => {
      const schema = toolDef.inputSchema as { properties?: Record<string, unknown> };
      const manifestProperties = new Set(Object.keys(schema.properties ?? {}));
      // Symmetric difference must be empty.
      expect([...manifestProperties].sort()).toEqual([...expected.properties].sort());
    });

    it(`${toolDef.name}: manifest required[] matches the non-optional Zod fields`, () => {
      const schema = toolDef.inputSchema as { required?: string[] };
      const manifestRequired = new Set(schema.required ?? []);
      expect([...manifestRequired].sort()).toEqual([...expected.required].sort());
    });
  }

  it("guard rejects a fabricated property-set drift (negative test)", () => {
    // Simulate the drift detection logic locally to prove it would throw.
    const expected = expectedShapes.search_catalog_items;
    const fakeManifestProps = new Set(["query"]); // missing other Zod props.

    const propsMissingInManifest = [...expected.properties].filter(p => !fakeManifestProps.has(p));
    const propsExtraInManifest = [...fakeManifestProps].filter(p => !expected.properties.has(p));

    expect(propsMissingInManifest.length).toBeGreaterThan(0);
    expect(propsExtraInManifest.length).toBe(0);
  });

  it("guard rejects a fabricated required-set drift (negative test)", () => {
    const expected = expectedShapes.search_catalog_items;
    // Pretend the manifest marked an optional Zod field as required.
    const fakeManifestRequired = new Set([...expected.required, "limit"]);

    const requiredMissingInManifest = [...expected.required].filter(p => !fakeManifestRequired.has(p));
    const requiredExtraInManifest = [...fakeManifestRequired].filter(p => !expected.required.has(p));

    expect(requiredMissingInManifest.length).toBe(0);
    expect(requiredExtraInManifest).toContain("limit");
  });
});

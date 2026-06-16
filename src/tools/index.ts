import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ServiceNowClient } from "../services/servicenowClient";
import { TokenManager } from "../services/tokenManager";
import { registerSearchCatalogItemsTool } from "./searchCatalogItems";
import { registerGetCatalogItemFormTool } from "./getCatalogItemForm";
import { registerPlaceOrderTool } from "./placeOrder";
import { registerValidateServiceNowConfigurationTool } from "./validateServiceNowConfiguration";
import { registerListUserOrdersTool } from "./listUserOrders";
import { registerUpdateOrderTool } from "./updateOrder";
import { registerGetOrderDetailTool } from "./getOrderDetail";
import {
  registerAddToCartTool,
  registerViewCartTool,
  registerUpdateCartItemTool,
  registerRemoveCartItemTool,
  registerSubmitCartTool
} from "./cart";
import { config } from "../config";
import { getWidgetForTool, registerWidgetResources } from "../ui/widgets";

/**
 * Single source of truth for the names of MCP tools this server exposes.
 *
 * Two surfaces consume this list:
 *
 *  - `registerTools(server)` registers a Zod-typed handler for each tool with
 *    the MCP SDK. The SDK normally returns a rich JSON-Schema for each tool
 *    via tools/list, but some MCP clients are sensitive to extra MCP
 *    SDK fields (execution metadata, richer JSON Schema keywords, ...).
 *  - `getMinimalToolDefinitions()` returns a hand-authored, minimal manifest
 *    that app.ts uses to override the SDK's tools/list response.
 *
 * Keeping the two in sync was previously implicit. The startup assertion at
 * the bottom of this file now fails fast if a tool is added to one surface
 * without the other.
 */
const BASE_TOOL_NAMES = [
  "search_catalog_items",
  "get_catalog_item_form",
  "place_order",
  "validate_servicenow_config",
  "list_user_orders",
  "update_order",
  "get_order_detail"
] as const;

// Cart/basket tools are part of the SEP-1865 "MCP Apps" experience and are
// only exposed when MCP_APPS_ENABLED=true. Gating them on the flag keeps the
// default tools/list byte-identical (still the seven base tools) and avoids
// surfacing widget-only tools to generic MCP clients.
const CART_TOOL_NAMES = [
  "add_to_cart",
  "view_cart",
  "update_cart_item",
  "remove_cart_item",
  "submit_cart"
] as const;

export type RegisteredToolName =
  | (typeof BASE_TOOL_NAMES)[number]
  | (typeof CART_TOOL_NAMES)[number];

// The effective set of tool names for the current configuration. Both the
// minimal manifest and registerTools() derive from the same gate so the
// import-time drift guard stays consistent in either flag state.
function effectiveToolNames(): string[] {
  return config.mcpApps.enabled
    ? [...BASE_TOOL_NAMES, ...CART_TOOL_NAMES]
    : [...BASE_TOOL_NAMES];
}

export function getMinimalToolDefinitions() {
  // NOTE: This minimal manifest is hand-maintained and intentionally returned
  // by the MCP tools/list handler instead of the SDK-derived schema. Some MCP
  // clients have historically rejected manifests that include
  // execution metadata or richer JSON Schema keywords (oneOf/anyOf, format,
  // negative numeric bounds, etc.). KEEP IN SYNC with the Zod schemas in each
  // tool file when adding/removing parameters or changing types.
  //
  // When config.mcpApps.enabled is true, widget-backed tools are decorated
  // with `_meta.ui.resourceUri` (SEP-1865 "MCP Apps"). When false, the
  // manifest is byte-identical to the default (non-MCP-Apps) surface so
  // generic MCP clients keep working.
  const definitions: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }> = [
    {
      name: "search_catalog_items",
      description: "Search ServiceNow catalog items using a natural-language query.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "User request to search for, such as laptop or VPN access"
          },
          catalogSysId: {
            type: "string",
            description: "Optional catalog sys_id filter"
          },
          categorySysId: {
            type: "string",
            description: "Optional category sys_id filter"
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Optional maximum number of results (1-50, default 25)"
          }
        },
        required: ["query"]
      }
    },
    {
      name: "get_catalog_item_form",
      description: "Get the order form for a selected ServiceNow catalog item, optionally prefilled from conversation context.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          itemSysId: {
            type: "string",
            description: "Selected catalog item sys_id"
          },
          userContext: {
            type: "string",
            description: "Optional free-text summary of the conversation used to prefill the form (e.g. 'User wants a black iPhone with 256GB on Verizon')."
          },
          prefillHints: {
            type: "object",
            description: "Optional structured field/value hints extracted from the conversation. Keys may be ServiceNow variable names or label keywords (color, storage, carrier, model, justification, quantity).",
            additionalProperties: {
              type: ["string", "number", "boolean"]
            }
          }
        },
        required: ["itemSysId"]
      }
    },
    {
      name: "place_order",
      description: "Place a ServiceNow catalog order with the collected form values.",
      inputSchema: {
        type: "object",
        properties: {
          itemSysId: {
            type: "string",
            description: "Catalog item sys_id"
          },
          variables: {
            type: "object",
            description: "Form field values keyed by variable name. Values may be string, number, or boolean.",
            additionalProperties: {
              type: ["string", "number", "boolean"]
            }
          },
          quantity: {
            type: "integer",
            minimum: 1,
            description: "Optional order quantity (default 1)"
          },
          requestedFor: {
            type: "string",
            description: "Optional sys_id or email of the user the item is being ordered for"
          }
        },
        required: ["itemSysId", "variables"]
      }
    },
    {
      name: "validate_servicenow_config",
      description: "Validate ServiceNow authentication and catalog access.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search term used for validation"
          },
          limit: {
            type: "integer",
            description: "Optional maximum number of validation results"
          },
          forceConfiguredCredentials: {
            type: "boolean",
            description: "Use configured app credentials (password or client_credentials grant) instead of the caller's x-servicenow-access-token"
          },
          probeOrderNow: {
            type: "boolean",
            description: "Optionally probe order endpoint access"
          },
          orderProbeItemSysId: {
            type: "string",
            description: "Optional item sys_id for order probe"
          },
          orderProbeVariables: {
            type: "object",
            description: "Optional order probe field values",
            additionalProperties: {
              type: "string"
            }
          }
        }
      }
    },
    {
      name: "list_user_orders",
      description: "Retrieve all current (non-closed) orders for the authenticated user.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            description: "Maximum number of orders to return (default: 50)"
          },
          fields: {
            type: "array",
            items: {
              type: "string"
            },
            description: "Optional list of specific fields to include in the response"
          }
        }
      }
    },
    {
      name: "update_order",
      description: "Update a service catalog order from the requestor's perspective. Allowed fields: short_description, description, comments, urgency, priority.",
      inputSchema: {
        type: "object",
        properties: {
          orderSysId: {
            type: "string",
            description: "The sys_id of the order (sc_request) to update"
          },
          updates: {
            type: "object",
            description: "Allowed fields: short_description, description, comments, urgency, priority",
            additionalProperties: false,
            properties: {
              short_description: { type: "string" },
              description: { type: "string" },
              comments: { type: "string" },
              urgency: { type: ["string", "number"] },
              priority: { type: ["string", "number"] }
            }
          }
        },
        required: ["orderSysId", "updates"]
      }
    },
    {
      name: "get_order_detail",
      description: "Retrieve a single ServiceNow service catalog request (sc_request) by sys_id, including its items and approval records.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          orderSysId: {
            type: "string",
            description: "The sys_id of the order (sc_request) to retrieve"
          },
          includeApprovals: {
            type: "boolean",
            description: "When true (default), also fetches sysapproval_approver rows for this request"
          }
        },
        required: ["orderSysId"]
      }
    }
  ];

  // Cart/basket tools — exposed only in the MCP Apps surface. Pushed before the
  // `_meta.ui` decoration loop so they pick up their widget binding too.
  if (config.mcpApps.enabled) {
    definitions.push(
      {
        name: "add_to_cart",
        description: "Add a ServiceNow catalog item to the user's cart (basket) without ordering yet.",
        inputSchema: {
          type: "object",
          properties: {
            itemSysId: {
              type: "string",
              description: "Catalog item sys_id"
            },
            variables: {
              type: "object",
              description: "Form field values keyed by variable name. Values may be string, number, or boolean.",
              additionalProperties: {
                type: ["string", "number", "boolean"]
              }
            },
            quantity: {
              type: "integer",
              minimum: 1,
              description: "Optional quantity to add (default 1)"
            }
          },
          required: ["itemSysId"]
        }
      },
      {
        name: "view_cart",
        description: "Retrieve the authenticated user's current ServiceNow cart (basket) contents.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "update_cart_item",
        description: "Update a line item in the ServiceNow cart — change its quantity and/or variable values.",
        inputSchema: {
          type: "object",
          properties: {
            cartItemId: {
              type: "string",
              description: "Cart line identifier (cartItemId) from add_to_cart or view_cart"
            },
            quantity: {
              type: "integer",
              minimum: 1,
              description: "Optional new quantity for the line item"
            },
            variables: {
              type: "object",
              description: "Optional updated form field values keyed by variable name.",
              additionalProperties: {
                type: ["string", "number", "boolean"]
              }
            }
          },
          required: ["cartItemId"]
        }
      },
      {
        name: "remove_cart_item",
        description: "Remove a single line item from the ServiceNow cart.",
        inputSchema: {
          type: "object",
          properties: {
            cartItemId: {
              type: "string",
              description: "Cart line identifier (cartItemId) to remove"
            }
          },
          required: ["cartItemId"]
        }
      },
      {
        name: "submit_cart",
        description: "Submit the entire ServiceNow cart as a single request (one REQ with multiple requested items).",
        inputSchema: {
          type: "object",
          properties: {
            requestedFor: {
              type: "string",
              description: "Optional sys_id or email of the user the order is for (defaults to the authenticated user)"
            }
          }
        }
      }
    );
  }

  // Decorate widget-backed tools with `_meta.ui.resourceUri` when the
  // MCP Apps feature is enabled. `getWidgetForTool()` already returns
  // undefined when the flag is off, so this is a no-op in the default state
  // and keeps the manifest byte-identical to the default (non-MCP-Apps)
  // surface.
  if (config.mcpApps.enabled) {
    for (const definition of definitions) {
      const widget = getWidgetForTool(definition.name);
      if (!widget) continue;
      definition._meta = {
        ...(definition._meta ?? {}),
        ui: {
          resourceUri: widget.uri,
          // visibility defaults to ["model","app"] per spec — be explicit so
          // hosts that fail-close on unknown shape see the intent.
          visibility: ["model", "app"]
        },
        // Also emit the flat `ui/resourceUri` key alongside the nested form.
        // This is exactly what the official `@modelcontextprotocol/ext-apps`
        // `registerAppTool` helper produces, and Microsoft 365 Copilot's MCP
        // Apps host keys off this flat field to bind a tool result to its
        // widget. Without it the tool runs but Copilot renders the result as
        // plain text instead of mounting the widget.
        "ui/resourceUri": widget.uri
      };
    }
  }

  return definitions;
}

export function registerTools(
  server: McpServer,
  client: ServiceNowClient,
  tokenManager: TokenManager
): void {
  registerSearchCatalogItemsTool(server, client);
  registerGetCatalogItemFormTool(server, client);
  registerPlaceOrderTool(server, client);
  registerValidateServiceNowConfigurationTool(server, tokenManager);
  registerListUserOrdersTool(server, client);
  registerUpdateOrderTool(server, client);
  registerGetOrderDetailTool(server, client);

  // Cart/basket tools — MCP Apps surface only (see effectiveToolNames()).
  if (config.mcpApps.enabled) {
    registerAddToCartTool(server, client);
    registerViewCartTool(server, client);
    registerUpdateCartItemTool(server, client);
    registerRemoveCartItemTool(server, client);
    registerSubmitCartTool(server, client);
  }

  // SEP-1865 widget resources. No-op when MCP_APPS_ENABLED != "true".
  registerWidgetResources(server);
}

// Module-load drift guard: the minimal manifest exposed via tools/list and
// the canonical TOOL_NAMES list must stay in sync. Throw early at import time
// if they diverge — better to fail fast on cold start than to silently expose
// an inconsistent tools/list response.
(function assertToolManifestConsistency(): void {
  const manifest = getMinimalToolDefinitions();
  const manifestNames = manifest.map(tool => tool.name).sort();
  const expectedNames = [...effectiveToolNames()].sort();
  const same =
    manifestNames.length === expectedNames.length &&
    manifestNames.every((name, index) => name === expectedNames[index]);

  if (!same) {
    throw new Error(
      "MCP tool manifest drift detected. " +
        `Expected tools: [${expectedNames.join(", ")}]. ` +
        `Manifest tools: [${manifestNames.join(", ")}]. ` +
        "Update both src/tools/index.ts BASE_TOOL_NAMES/CART_TOOL_NAMES and getMinimalToolDefinitions()."
    );
  }

  // Content parity: property names + required-field set must match between
  // the hand-authored minimal manifest and the Zod schemas registered with
  // the MCP SDK. Type-level details are intentionally NOT compared because
  // the minimal manifest deliberately strips/simplifies JSON Schema
  // keywords for broad MCP client compatibility (see comment on
  // getMinimalToolDefinitions() above). What MUST match exactly:
  //   - the set of property names
  //   - the set of required (i.e. non-optional) fields
  //
  // The expected shapes are derived by registering all tools against a stub
  // McpServer with dummy dependencies. The register* functions only store
  // closures at registration time; they do not invoke the dummies.
  const expectedShapes = deriveExpectedToolShapesFromZod();

  for (const toolDef of manifest) {
    const expected = expectedShapes[toolDef.name];
    if (!expected) {
      // Unreachable given the name-set assertion above, but kept for clarity.
      throw new Error(`MCP tool '${toolDef.name}' has no Zod-side registration to compare against.`);
    }

    const schema = toolDef.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    const manifestProperties = new Set(Object.keys(schema.properties ?? {}));
    const manifestRequired = new Set<string>(schema.required ?? []);

    const propsMissingInManifest = [...expected.properties].filter(p => !manifestProperties.has(p));
    const propsExtraInManifest = [...manifestProperties].filter(p => !expected.properties.has(p));
    if (propsMissingInManifest.length > 0 || propsExtraInManifest.length > 0) {
      throw new Error(
        `MCP tool '${toolDef.name}' input property drift. ` +
          `Missing in manifest: [${propsMissingInManifest.join(", ")}]. ` +
          `Extra in manifest: [${propsExtraInManifest.join(", ")}]. ` +
          "Update getMinimalToolDefinitions() to match the Zod schema."
      );
    }

    const requiredMissingInManifest = [...expected.required].filter(p => !manifestRequired.has(p));
    const requiredExtraInManifest = [...manifestRequired].filter(p => !expected.required.has(p));
    if (requiredMissingInManifest.length > 0 || requiredExtraInManifest.length > 0) {
      throw new Error(
        `MCP tool '${toolDef.name}' required-field drift. ` +
          `Missing in manifest: [${requiredMissingInManifest.join(", ")}]. ` +
          `Extra in manifest: [${requiredExtraInManifest.join(", ")}]. ` +
          "Update getMinimalToolDefinitions() (or the Zod schema) so required[] matches."
      );
    }
  }
})();

function deriveExpectedToolShapesFromZod(): Record<string, { properties: Set<string>; required: Set<string> }> {
  // Tool register* functions only store closures; the dummy client and token
  // manager are never invoked at registration time. Keep this stub-driven
  // registration isolated so it never reaches a real McpServer instance.
  const stubServer = new McpServer({ name: "drift-check", version: "0.0.0" });
  const dummyClient = {} as ServiceNowClient;
  const dummyTokenManager = {} as TokenManager;
  registerTools(stubServer, dummyClient, dummyTokenManager);

  // McpServer keeps registrations on a private `_registeredTools` map keyed
  // by tool name. Accessed via bracket cast so the production code does not
  // depend on @modelcontextprotocol/sdk internals at type level.
  const registeredTools = (stubServer as unknown as {
    _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, unknown> } }>;
  })._registeredTools;

  const result: Record<string, { properties: Set<string>; required: Set<string> }> = {};
  for (const [name, tool] of Object.entries(registeredTools)) {
    const shape = tool.inputSchema?.shape ?? {};
    const properties = new Set<string>(Object.keys(shape));
    const required = new Set<string>();
    for (const [field, zodSchema] of Object.entries(shape)) {
      // Zod 4: ZodType.isOptional() returns true for ZodOptional / ZodDefault /
      // wrapped optional unions — anything that does not require the caller to
      // supply the field. Anything else is required.
      const isOptional =
        typeof (zodSchema as { isOptional?: () => boolean }).isOptional === "function" &&
        (zodSchema as { isOptional: () => boolean }).isOptional();
      if (!isOptional) {
        required.add(field);
      }
    }
    result[name] = { properties, required };
  }
  return result;
}

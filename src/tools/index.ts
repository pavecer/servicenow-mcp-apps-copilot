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
  registerUpdateOrderItemTool,
  registerRemoveOrderItemTool
} from "./orderItems";
import {
  registerAddToCartTool,
  registerViewCartTool,
  registerUpdateCartItemTool,
  registerRemoveCartItemTool,
  registerSubmitCartTool
} from "./cart";
import { registerGetIncidentFormTool } from "./getIncidentForm";
import { registerReportIncidentTool } from "./reportIncident";
import { registerListUserIncidentsTool } from "./listUserIncidents";
import { registerGetIncidentDetailTool } from "./getIncidentDetail";
import { registerAddIncidentCommentTool } from "./addIncidentComment";
import { registerAddIncidentAttachmentTool } from "./addIncidentAttachment";
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

// Cart/basket tools are part of the SEP-1865 "MCP Apps" experience. They let
// the user build a multi-item basket and submit it as a single request.
const CART_TOOL_NAMES = [
  "add_to_cart",
  "view_cart",
  "update_cart_item",
  "remove_cart_item",
  "submit_cart"
] as const;

// Order line-item tools are also part of the SEP-1865 "MCP Apps" experience —
// they let the user edit/remove individual items in an existing order and
// re-render the order-detail widget in place.
const ORDER_ITEM_TOOL_NAMES = [
  "update_order_item",
  "remove_order_item"
] as const;

// Incident-management tools — the end-user "report a problem & track it" flow.
// report/list/detail/comment each mount a SEP-1865 widget (incident-form,
// my-incidents, incident-detail).
const INCIDENT_TOOL_NAMES = [
  "get_incident_form",
  "report_incident",
  "list_user_incidents",
  "get_incident_detail",
  "add_incident_comment",
  "add_incident_attachment"
] as const;

export type RegisteredToolName =
  | (typeof BASE_TOOL_NAMES)[number]
  | (typeof CART_TOOL_NAMES)[number]
  | (typeof ORDER_ITEM_TOOL_NAMES)[number]
  | (typeof INCIDENT_TOOL_NAMES)[number];

// The effective set of tool names this server exposes. The MCP Apps surface is
// always on, so the base tools, cart/basket tools, order line-item tools, and
// incident tools are all exposed. The minimal manifest and registerTools() both
// derive from this single list so the import-time drift guard stays consistent.
function effectiveToolNames(): string[] {
  return [...BASE_TOOL_NAMES, ...CART_TOOL_NAMES, ...ORDER_ITEM_TOOL_NAMES, ...INCIDENT_TOOL_NAMES];
}

export function getMinimalToolDefinitions() {
  // NOTE: This minimal manifest is hand-maintained and intentionally returned
  // by the MCP tools/list handler instead of the SDK-derived schema. Some MCP
  // clients have historically rejected manifests that include
  // execution metadata or richer JSON Schema keywords (oneOf/anyOf, format,
  // negative numeric bounds, etc.). KEEP IN SYNC with the Zod schemas in each
  // tool file when adding/removing parameters or changing types.
  //
  // Widget-backed tools are decorated with `_meta.ui.resourceUri` (SEP-1865
  // "MCP Apps") so the M365 Copilot host mounts the matching widget.
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
      annotations: { readOnlyHint: true },
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
      annotations: { readOnlyHint: true },
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

  // Cart/basket tools — pushed before the `_meta.ui` decoration loop so they
  // pick up their widget binding too.
  definitions.push(
      {
        name: "add_to_cart",
        description: "Add a ServiceNow catalog item to the user's cart (basket) without ordering yet.",
        annotations: { readOnlyHint: true },
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
        annotations: { readOnlyHint: true },
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
        annotations: { readOnlyHint: true },
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
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: {
            requestedFor: {
              type: "string",
              description: "Optional sys_id or email of the user the order is for (defaults to the authenticated user)"
            }
          }
        }
      },
      {
        name: "update_order_item",
        description: "Update a single requested item (line item) on an existing order. Allowed fields: quantity, comments, short_description, description.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: {
            orderItemSysId: {
              type: "string",
              description: "The sys_id of the requested item (sc_req_item) to update"
            },
            orderSysId: {
              type: "string",
              description: "Optional sys_id of the parent order (sc_request); resolved from the item when omitted"
            },
            updates: {
              type: "object",
              description: "Allowed fields: quantity, comments, short_description, description",
              additionalProperties: false,
              properties: {
                quantity: { type: ["string", "number"] },
                comments: { type: "string" },
                short_description: { type: "string" },
                description: { type: "string" }
              }
            }
          },
          required: ["orderItemSysId", "updates"]
        }
      },
      {
        name: "remove_order_item",
        description: "Remove a single requested item (line item) from an existing order without cancelling the whole request.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: {
            orderItemSysId: {
              type: "string",
              description: "The sys_id of the requested item (sc_req_item) to remove"
            },
            orderSysId: {
              type: "string",
              description: "Optional sys_id of the parent order (sc_request); resolved from the item when omitted"
            }
          },
          required: ["orderItemSysId"]
        }
      }
    );

  // Incident-management tools — end-user report/track flow.
  definitions.push(
    {
      name: "get_incident_form",
      description: "Open the 'report an incident' form so the user can describe a problem with IT.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "report_incident",
      description: "Report (create) a ServiceNow incident for the end user from the report form values.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          shortDescription: {
            type: "string",
            description: "One-line summary of the problem (incident short description)"
          },
          description: {
            type: "string",
            description: "Optional longer description: what happened, when, any error messages"
          },
          category: {
            type: "string",
            description: "Optional category, e.g. inquiry, software, hardware, network, database"
          },
          urgency: {
            type: "string",
            description: "Optional ServiceNow urgency value: 1 High, 2 Medium, 3 Low"
          },
          impact: {
            type: "string",
            description: "Optional ServiceNow impact value: 1 High, 2 Medium, 3 Low"
          }
        },
        required: ["shortDescription"]
      }
    },
    {
      name: "list_user_incidents",
      description: "Retrieve the authenticated user's own open and recently resolved ServiceNow incidents.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            description: "Maximum number of incidents to return (default: 20)"
          }
        }
      }
    },
    {
      name: "get_incident_detail",
      description: "Retrieve a single ServiceNow incident by sys_id, including status and customer-visible comments.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          incidentSysId: {
            type: "string",
            description: "The sys_id of the incident to retrieve"
          }
        },
        required: ["incidentSysId"]
      }
    },
    {
      name: "add_incident_comment",
      description: "Add a customer-visible additional comment to one of the user's ServiceNow incidents.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          incidentSysId: {
            type: "string",
            description: "The sys_id of the incident to comment on"
          },
          comment: {
            type: "string",
            description: "The additional comment text to add"
          }
        },
        required: ["incidentSysId", "comment"]
      }
    },
    {
      name: "add_incident_attachment",
      description: "Attach a file (e.g. a screenshot) to one of the user's ServiceNow incidents. Files are limited to 5 MB.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          incidentSysId: {
            type: "string",
            description: "The sys_id of the incident to attach the file to"
          },
          fileName: {
            type: "string",
            description: "The file name including extension, e.g. 'screenshot.png'"
          },
          contentType: {
            type: "string",
            description: "The file's MIME type, e.g. 'image/png' or 'application/pdf'"
          },
          dataBase64: {
            type: "string",
            description: "The file content, base64-encoded (no data: URI prefix)"
          }
        },
        required: ["incidentSysId", "fileName", "contentType", "dataBase64"]
      }
    }
  );

  // Decorate widget-backed tools with `_meta.ui.resourceUri`. The matching
  // M365 Copilot host keys off this to mount the widget for a tool result.
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

  // Cart/basket + order line-item tools — part of the MCP Apps surface.
  registerAddToCartTool(server, client);
  registerViewCartTool(server, client);
  registerUpdateCartItemTool(server, client);
  registerRemoveCartItemTool(server, client);
  registerSubmitCartTool(server, client);
  registerUpdateOrderItemTool(server, client);
  registerRemoveOrderItemTool(server, client);

  // Incident-management tools — end-user report/track flow.
  registerGetIncidentFormTool(server);
  registerReportIncidentTool(server, client);
  registerListUserIncidentsTool(server, client);
  registerGetIncidentDetailTool(server, client);
  registerAddIncidentCommentTool(server, client);
  registerAddIncidentAttachmentTool(server, client);

  // SEP-1865 widget resources.
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

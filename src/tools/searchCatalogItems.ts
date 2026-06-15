import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceNowClient } from "../services/servicenowClient";
import { buildCatalogItemSelectionAdaptiveCard } from "../utils/adaptiveCards";
import { config } from "../config";

export function registerSearchCatalogItemsTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "search_catalog_items",
    [
      "Search the ServiceNow Service Catalog for items matching the user's intent.",
      "Accepts natural language text derived from the conversation and returns a ranked list of matching catalog items.",
      "When header x-servicenow-access-token is provided, results are returned based on that ServiceNow user's access permissions.",
      "Use this tool first to help the user discover and select available service catalog items.",
      "Results include each item's sys_id (required for subsequent tools), name, short description, category, catalog,",
      "categorySysId, and catalogSysId (use these to restrict follow-up searches to the same category or catalog).",
      "An Adaptive Card (selectionAdaptiveCard) is also returned so the user can select their preferred item directly."
    ].join(" "),
    {
      query: z
        .string()
        .min(1)
        .describe(
          "The search text representing the user's intent or request (e.g. 'new laptop', 'VPN access', 'reset my password')"
        ),
      catalogSysId: z
        .string()
        .optional()
        .describe("Optional sys_id of a specific catalog to restrict the search"),
      categorySysId: z
        .string()
        .optional()
        .describe("Optional sys_id of a specific category to filter results"),
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .default(25)
        .describe("Maximum number of results to return (default: 25, max: 50)")
    },
    async ({ query, catalogSysId, categorySysId, limit }) => {
      const items = await client.searchCatalogItems(query, {
        catalogSysId,
        categorySysId,
        limit
      });

      if (items.length === 0) {
        const emptyResult: {
          content: Array<{ type: "text"; text: string }>;
          structuredContent?: Record<string, unknown>;
        } = {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                found: 0,
                items: [],
                message: "No catalog items found matching the query. Try different keywords."
              }, null, 2)
            }
          ]
        };

        // When MCP Apps is enabled, still emit structuredContent so the
        // catalog-browse widget mounts and renders its own empty state
        // (showing the query) instead of leaving the model to summarise.
        if (config.mcpApps.enabled) {
          emptyResult.structuredContent = { query, found: 0, items: [] };
          emptyResult.content = [
            {
              type: "text" as const,
              text: `No catalog items matched "${query}". Ask the user to refine with a shorter keyword (e.g. "laptop", "monitor", "VPN").`
            }
          ];
        }

        return emptyResult;
      }

      const selectionAdaptiveCard = buildCatalogItemSelectionAdaptiveCard(items);

      const itemList = items.map(item => ({
        sys_id: item.sys_id,
        name: item.name,
        short_description: item.short_description ?? null,
        category: item.category?.title ?? item.category?.name ?? null,
        categorySysId: item.category?.sys_id ?? null,
        catalog: item.sc_catalog?.title ?? item.sc_catalog?.name ?? null,
        catalogSysId: item.sc_catalog?.sys_id ?? null
      }));

      const result: {
        content: Array<{ type: "text"; text: string }>;
        structuredContent?: Record<string, unknown>;
      } = {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              found: items.length,
              items: itemList,
              selectionAdaptiveCard
            }, null, 2)
          }
        ]
      };

      // SEP-1865 MCP App widget payload — kept compact (no adaptiveCard JSON).
      // Only emitted when the feature flag is on so the historical Copilot
      // Studio surface is byte-identical in the default state.
      if (config.mcpApps.enabled) {
        result.structuredContent = {
          query,
          found: items.length,
          items: itemList
        };

        // MCP Apps: `content` must be a concise model-facing summary only.
        // The matching items travel in structuredContent and are rendered by
        // the catalog-browse widget. Returning the full JSON list (plus the
        // Adaptive Card) in `content` makes Microsoft 365 Copilot render a
        // verbose text fallback instead of mounting the widget.
        result.content = [
          {
            type: "text" as const,
            text: `Found ${items.length} catalog item(s) matching "${query}". The results are shown above as selectable cards for the user to choose from.`
          }
        ];
      }

      return result;
    }
  );
}

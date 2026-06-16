import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceNowClient } from "../services/servicenowClient";
import {
  buildOrderFormAdaptiveCard,
  collectVariables,
  getReferenceQualifier,
  getReferenceTable,
  getVariableLabel,
  isMultiSelectType,
  isReferenceVariable,
  normalizeChoices,
  normalizeVariableType
} from "../utils/adaptiveCards";
import { computePrefillValues } from "../utils/prefillCatalogForm";
import { config } from "../config";
import Logger from "../utils/logger";
import type { ServiceNowVariable } from "../types/servicenow";

// Map a ServiceNow normalized variable type onto the small set the widget
// understands. `normalizeVariableType` prefers `friendly_type`, so values here
// are mostly canonicalized friendly names (e.g. "check_box", "container_start",
// "multi_line_text") with the numeric ServiceNow type codes as a fallback.
// Mirrors the Adaptive Card classification in utils/adaptiveCards.ts so both
// renderers agree on field shapes. Anything unclassified becomes plain text.
function toWidgetFieldType(rawType: string): string {
  // Static section headers / labels. ServiceNow container_start (type 0) and
  // Label (type 11) carry no user input - render them as headings, not boxes.
  if (
    [
      "0",
      "11",
      "label",
      "label_only",
      "container_start",
      "checkbox_container",
      "begin_split",
      "split",
      "formatted_text",
      "html",
      "rich_text_label",
      "macro_with_label",
      // ServiceNow's catalog API reports "Macro with Label" variables with the
      // literal friendly_type "macro_with_abel" on the demo instance.
      "macro_with_abel"
    ].includes(rawType)
  ) {
    return "label";
  }
  // Renderer-only types with no Adaptive Card / widget analog. The widget drops
  // these so they don't show up as empty inputs.
  if (
    ["macro", "ui_macro", "custom", "break", "container_end", "end_split", "split_end"].includes(rawType)
  ) {
    return "skip";
  }
  if (["1", "5", "7", "boolean", "checkbox", "check_box", "yesno", "true_false"].includes(rawType)) return "boolean";
  if (["3", "4", "integer", "decimal", "numeric", "number"].includes(rawType)) return "number";
  if (["email"].includes(rawType)) return "email";
  if (["8", "9", "date", "glide_date"].includes(rawType)) return "date";
  if (["6", "10", "datetime", "glide_date_time", "date_time"].includes(rawType)) return "datetime";
  if (["2", "textarea", "multi_line", "multiline", "multi_line_text", "longtext"].includes(rawType)) return "longtext";
  return "string";
}

/**
 * Pure mapping from a ServiceNow catalog item's variables to the compact field
 * schema the order-form widget consumes. Exported so it can be unit-tested
 * directly against real catalog items without registering the MCP tool.
 *
 * `referenceChoices` supplies pre-resolved options for reference variables
 * (looked up from their target table). Choice/select variables carry their own
 * options via `normalizeChoices`. Section headers become `{type:"label"}`
 * entries (no input); renderer-only types (macros, breaks) are dropped.
 */
export function buildOrderFormFields(
  item: { variables?: ServiceNowVariable[] },
  referenceChoices: Record<string, Array<{ title: string; value: string }>> = {}
): Array<Record<string, unknown>> {
  const variables = collectVariables(item.variables).filter(v => v.visible !== false);
  return variables
    .map(variable => {
      const rawType = normalizeVariableType(variable);
      const widgetType = toWidgetFieldType(rawType);
      // Section headers (container_start / label) carry no input - emit a
      // `label` field the widget renders as a heading. Renderer-only types
      // (macros, breaks, container_end) are dropped entirely.
      if (widgetType === "label") {
        const labelText = getVariableLabel(variable);
        if (!labelText) return null;
        return { name: variable.name, label: labelText, type: "label" as const };
      }
      if (widgetType === "skip") return null;

      let choices = referenceChoices[variable.name];
      if (!choices) {
        const local = normalizeChoices(variable);
        if (local.length > 0) choices = local;
      }
      const field: Record<string, unknown> = {
        name: variable.name,
        label: getVariableLabel(variable),
        type: widgetType,
        required: variable.mandatory === true
      };
      if (choices && choices.length > 0) {
        field.choices = choices;
        field.multiSelect = isMultiSelectType(rawType);
      }
      return field;
    })
    .filter((field): field is Record<string, unknown> => field !== null);
}

export function registerGetCatalogItemFormTool(server: McpServer, client: ServiceNowClient): void {
  const sysIdPattern = /^[0-9a-f]{32}$/i;

  server.tool(
    "get_catalog_item_form",
    [
      "Retrieve the order form for a selected ServiceNow catalog item and return it as an Adaptive Card definition.",
      "Use this tool after the user has chosen a specific catalog item from the search results.",
      "The returned Adaptive Card contains all required and optional input fields the user must fill in to place the order.",
      "Pass the sys_id from the search_catalog_items result.",
      "If you only have an item name, pass the exact item name and this tool will attempt to resolve it to a sys_id.",
      "SMART PREFILL: Pass `prefillHints` with any field values you have already extracted from the conversation,",
      "for example { color: 'black', storage: '256GB', carrier: 'Verizon', justification: 'Replacement for damaged device' }.",
      "Hint keys can be either the ServiceNow variable name or a normalized label keyword (color, storage, carrier, model, justification, quantity, date, location).",
      "The tool normalizes hint values against the actual catalog choice list so the rendered Adaptive Card is pre-populated for the user to review.",
      "You can also pass `userContext` (a short free-text summary of the relevant conversation) as a fallback - the tool will extract common patterns from it.",
      "The response includes `prefilledValues` and `prefillDiagnostics` so you can see what was filled and why."
    ].join(" "),
    {
      itemSysId: z
        .string()
        .min(1)
        .describe(
          "The sys_id of the selected catalog item (preferred; obtained from search_catalog_items). Exact item name is also accepted as fallback."
        ),
      userContext: z
        .string()
        .optional()
        .describe(
          "Optional free-text summary of the relevant conversation (e.g. 'User wants a black iPhone with 256GB on Verizon, needed by 2026-06-01'). Used as a fallback for prefilling fields when no structured hint is provided."
        ),
      prefillHints: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe(
          "Optional structured key/value pairs extracted from the conversation. Keys may be the ServiceNow variable name OR a normalized label keyword (e.g. 'color', 'storage', 'carrier', 'model', 'justification', 'quantity'). Values are normalized against the catalog item's actual choice list."
        )
    },
    async ({ itemSysId, userContext, prefillHints }) => {
      let resolvedItemSysId = itemSysId.trim();

      if (!sysIdPattern.test(resolvedItemSysId)) {
        const candidateItems = await client.searchCatalogItems(resolvedItemSysId, { limit: 50 });
        const exactMatch = candidateItems.find(
          candidate => candidate.name.trim().toLowerCase() === resolvedItemSysId.toLowerCase()
        );

        if (!exactMatch) {
          const candidateNames = candidateItems.slice(0, 10).map(candidate => candidate.name);
          throw new Error(
            `Catalog item '${resolvedItemSysId}' could not be resolved to a sys_id. ` +
              `Call search_catalog_items first and pass the returned sys_id. ` +
              `Top matches: ${candidateNames.join(", ") || "none"}.`
          );
        }

        resolvedItemSysId = exactMatch.sys_id;
      }

      const item = await client.getCatalogItem(resolvedItemSysId);

      const { values: prefilledValues, diagnostics: prefillDiagnostics } = computePrefillValues(
        item.variables,
        { userContext, prefillHints }
      );

      // Pre-resolve reference variables (e.g. `requested_for` -> sys_user,
      // `internal_destination` -> cmn_location) so the Adaptive Card can
      // render them as ChoiceSets the user can pick from. Each lookup is
      // bounded and any single failure falls back to a free-text input, so
      // a flaky reference table never breaks the whole form.
      const referenceVariables = collectVariables(item.variables).filter(
        v => isReferenceVariable(v) && v.visible !== false && getReferenceTable(v)
      );
      const referenceChoices: Record<string, Array<{ title: string; value: string }>> = {};
      const referenceDiagnostics: Record<string, { table: string; count: number; refQualifier?: string }> = {};

      if (referenceVariables.length > 0) {
        const lookups = await Promise.all(
          referenceVariables.map(async variable => {
            const table = getReferenceTable(variable);
            const refQualifier = getReferenceQualifier(variable);
            try {
              const records = await client.searchReferenceRecords(table, {
                refQualifier: refQualifier || undefined,
                limit: 25
              });
              return { variable, table, refQualifier, records };
            } catch (error) {
              Logger.warn("Reference variable lookup failed", {
                operation: "catalog.reference_lookup_failed",
                variableName: variable.name,
                table
              }, error);
              return { variable, table, refQualifier, records: [] };
            }
          })
        );

        for (const { variable, table, refQualifier, records } of lookups) {
          if (records.length === 0) continue;
          referenceChoices[variable.name] = records.map(record => ({
            title: record.display,
            value: record.sys_id
          }));
          referenceDiagnostics[variable.name] = {
            table,
            count: records.length,
            ...(refQualifier ? { refQualifier } : {})
          };
        }
      }

      const adaptiveCard = buildOrderFormAdaptiveCard(item, prefilledValues, referenceChoices);

      const result: {
        content: Array<{ type: "text"; text: string }>;
        structuredContent?: Record<string, unknown>;
      } = {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              itemSysId: item.sys_id,
              itemName: item.name,
              variableCount: item.variables?.length ?? 0,
              prefilledValues,
              prefillDiagnostics,
              referenceLookups: referenceDiagnostics,
              adaptiveCard
            }, null, 2)
          }
        ]
      };

      // SEP-1865 MCP App widget payload. Compact field schema (no Adaptive
      // Card JSON, no diagnostics) so it stays well under Cowork's 64 KiB
      // inlined limit. Only emitted when the feature flag is on.
      if (config.mcpApps.enabled) {
        const fields = buildOrderFormFields(item, referenceChoices);
        result.structuredContent = {
          itemSysId: item.sys_id,
          itemName: item.name,
          fields,
          prefilledValues
        };

        // MCP Apps: `content` must be a concise model-facing summary only.
        // The full form (fields/adaptiveCard) travels in structuredContent and
        // is rendered by the order-form widget. Returning the large Adaptive
        // Card JSON in `content` makes Microsoft 365 Copilot render a verbose
        // text fallback instead of mounting the widget (see the MCP Apps
        // troubleshooting guidance on duplicate data in widget and text).
        result.content = [
          {
            type: "text" as const,
            text: `Order form for "${item.name}" (${fields.length} field(s)).`
          }
        ];
      }

      return result;
    }
  );
}

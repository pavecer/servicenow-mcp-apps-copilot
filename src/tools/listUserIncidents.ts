import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceNowClient } from "../services/servicenowClient";
import Logger from "../utils/logger";

/** Compact projection delivered to the my-incidents widget. */
function toWidgetIncident(row: Record<string, unknown>): Record<string, unknown> {
  const read = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
  return {
    sys_id: read(row.sys_id),
    number: read(row.number),
    short_description: read(row.short_description),
    state: read(row.state),
    priority: read(row.priority),
    urgency: read(row.urgency),
    category: read(row.category),
    opened_at: read(row.opened_at),
    updated_on: read(row.sys_updated_on) || read(row.sys_created_on)
  };
}

export function registerListUserIncidentsTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "list_user_incidents",
    [
      "Retrieve the authenticated user's own open and recently resolved ServiceNow incidents, newest activity first.",
      "Use this when the user wants to see, track, or follow up on incidents they have reported.",
      "Renders the my-incidents widget; clicking an incident opens get_incident_detail."
    ].join(" "),
    {
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of incidents to return (default: 20).")
    },
    async ({ limit }) => {
      try {
        const incidents = await client.listUserIncidents(limit);

        if (incidents.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No open incidents." }],
            structuredContent: { count: 0, incidents: [] }
          };
        }

        return {
          content: [{ type: "text" as const, text: `${incidents.length} open incident(s).` }],
          structuredContent: {
            count: incidents.length,
            incidents: incidents.map(toWidgetIncident)
          }
        };
      } catch (error) {
        Logger.warn("list_user_incidents tool failed", { operation: "tool.list_user_incidents" }, error);
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message, operation: "list_user_incidents" }, null, 2)
            }
          ]
        };
      }
    }
  );
}

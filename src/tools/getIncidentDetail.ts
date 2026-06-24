import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceNowClient } from "../services/servicenowClient";
import { config } from "../config";

type IncidentDetailToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
};

/**
 * Read a ServiceNow field that may be a plain string or, when fetched with
 * sysparm_display_value=all, a { display_value, value } object.
 */
function readField(value: unknown, prefer: "value" | "display_value"): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const primary = obj[prefer];
    if (typeof primary === "string" && primary) return primary;
    const fallback = prefer === "value" ? obj.display_value : obj.value;
    if (typeof fallback === "string" && fallback) return fallback;
  }
  return undefined;
}

/**
 * Fetch an incident's full detail and shape it into the standard incident
 * detail tool result (concise text summary + MCP Apps structuredContent bound
 * to the incident-detail widget). Shared by get_incident_detail,
 * report_incident, and add_incident_comment so each re-renders the same widget
 * in place.
 */
export async function buildIncidentDetailResult(
  client: ServiceNowClient,
  incidentSysId: string,
  extra?: Record<string, unknown>
): Promise<IncidentDetailToolResult> {
  const detail = await client.getIncidentDetail(incidentSysId);
  const instanceUrl = config.serviceNow.instanceUrl.replace(/\/$/, "");
  const sysIdValue = readField(detail.incident.sys_id, "value") ?? incidentSysId;
  const number = readField(detail.incident.number, "display_value") ?? incidentSysId;
  const state = readField(detail.incident.state, "display_value") ?? "";

  return {
    content: [
      {
        type: "text" as const,
        text: `Incident ${number}${state ? ` (${state})` : ""}: ${detail.comments.length} comment(s).`
      }
    ],
    structuredContent: {
      incident: detail.incident,
      comments: detail.comments,
      link: `${instanceUrl}/incident.do?sys_id=${sysIdValue}`,
      ...(extra ?? {})
    }
  };
}

export function registerGetIncidentDetailTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "get_incident_detail",
    [
      "Retrieve a single ServiceNow incident by sys_id, including its status and the customer-visible comment activity.",
      "Use this when the user wants to drill into a specific incident returned by list_user_incidents.",
      "Renders the incident-detail widget so the user can read updates and add a comment."
    ].join(" "),
    {
      incidentSysId: z
        .string()
        .min(1)
        .describe("The sys_id of the incident. Typically obtained from list_user_incidents or a report confirmation.")
    },
    async ({ incidentSysId }) => {
      try {
        return await buildIncidentDetailResult(client, incidentSysId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message, operation: "get_incident_detail" }, null, 2)
            }
          ]
        };
      }
    }
  );
}

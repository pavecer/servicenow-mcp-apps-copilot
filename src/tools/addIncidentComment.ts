import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceNowClient } from "../services/servicenowClient";
import { buildIncidentDetailResult } from "./getIncidentDetail";
import Logger from "../utils/logger";

export function registerAddIncidentCommentTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "add_incident_comment",
    [
      "Add a customer-visible additional comment to one of the user's ServiceNow incidents.",
      "Use this when the user wants to add information, respond to the agent, or follow up on an incident.",
      "The comment is appended to the incident activity. Re-renders the incident-detail widget with the new comment."
    ].join(" "),
    {
      incidentSysId: z
        .string()
        .min(1)
        .describe("The sys_id of the incident to comment on (from list_user_incidents or get_incident_detail)."),
      comment: z
        .string()
        .min(1)
        .describe("The additional comment text to add (visible to the user and the assigned agent).")
    },
    async ({ incidentSysId, comment }) => {
      try {
        await client.addIncidentComment(incidentSysId, comment);
        return await buildIncidentDetailResult(client, incidentSysId);
      } catch (error) {
        Logger.warn("add_incident_comment tool failed", {
          operation: "tool.add_incident_comment",
          incidentSysId
        }, error);
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message, operation: "add_incident_comment" }, null, 2)
            }
          ]
        };
      }
    }
  );
}

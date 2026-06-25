import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceNowClient } from "../services/servicenowClient";
import { buildIncidentDetailResult } from "./getIncidentDetail";
import Logger from "../utils/logger";

export function registerRemoveIncidentAttachmentTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "remove_incident_attachment",
    [
      "Remove a file the user previously attached to one of their ServiceNow incidents.",
      "Use this when the user wants to delete an attachment shown on an incident.",
      "Re-renders the incident-detail widget without the removed attachment."
    ].join(" "),
    {
      incidentSysId: z
        .string()
        .min(1)
        .describe("The sys_id of the incident the attachment belongs to."),
      attachmentSysId: z
        .string()
        .min(1)
        .describe("The sys_id of the attachment to remove (from the incident-detail attachment list).")
    },
    async ({ incidentSysId, attachmentSysId }) => {
      try {
        await client.removeIncidentAttachment(incidentSysId, attachmentSysId);
        return await buildIncidentDetailResult(client, incidentSysId);
      } catch (error) {
        Logger.warn("remove_incident_attachment tool failed", {
          operation: "tool.remove_incident_attachment",
          incidentSysId,
          attachmentSysId
        }, error);
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message, operation: "remove_incident_attachment" }, null, 2)
            }
          ]
        };
      }
    }
  );
}

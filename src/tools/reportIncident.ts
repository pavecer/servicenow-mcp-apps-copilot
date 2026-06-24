import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceNowClient } from "../services/servicenowClient";
import { buildIncidentDetailResult } from "./getIncidentDetail";
import Logger from "../utils/logger";

export function registerReportIncidentTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "report_incident",
    [
      "Report (create) a ServiceNow incident for the end user using the values collected from the report form.",
      "Use this after the user has described the problem in the get_incident_form widget.",
      "The incident is attributed to the authenticated user (caller_id). Renders the incident-detail widget as the confirmation."
    ].join(" "),
    {
      shortDescription: z
        .string()
        .min(1)
        .describe("One-line summary of the problem (incident short description)."),
      description: z
        .string()
        .optional()
        .describe("Optional longer description: what happened, when, any error messages."),
      category: z
        .string()
        .optional()
        .describe("Optional category, e.g. inquiry, software, hardware, network, database."),
      urgency: z
        .string()
        .optional()
        .describe("Optional ServiceNow urgency value: 1 High, 2 Medium, 3 Low."),
      impact: z
        .string()
        .optional()
        .describe("Optional ServiceNow impact value: 1 High, 2 Medium, 3 Low.")
    },
    async ({ shortDescription, description, category, urgency, impact }) => {
      try {
        const result = await client.createIncident({
          shortDescription,
          description,
          category,
          urgency,
          impact
        });

        // Render the created incident as the incident-detail widget (the same
        // confirmation get_incident_detail uses), flagged submitted. If the
        // detail lookup fails we still confirm with a minimal payload so the
        // report is never a dead end.
        try {
          return await buildIncidentDetailResult(client, result.sys_id, {
            submitted: true,
            number: result.number
          });
        } catch (detailError) {
          Logger.warn("Incident created but detail lookup failed; returning minimal confirmation", {
            operation: "incident.report_detail_lookup_failed",
            incidentSysId: result.sys_id
          }, detailError);
          return {
            content: [
              {
                type: "text" as const,
                text: `Incident ${result.number} reported.`
              }
            ],
            structuredContent: {
              submitted: true,
              number: result.number,
              incident: { number: result.number, sys_id: result.sys_id, state: "New", short_description: shortDescription },
              comments: [],
              attachments: []
            }
          };
        }
      } catch (error) {
        Logger.warn("report_incident tool failed", { operation: "tool.report_incident" }, error);
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message, operation: "report_incident" }, null, 2)
            }
          ]
        };
      }
    }
  );
}

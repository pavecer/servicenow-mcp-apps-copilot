import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceNowClient } from "../services/servicenowClient";
import { buildIncidentDetailResult } from "./getIncidentDetail";
import Logger from "../utils/logger";

// Hard cap on a single attachment's raw size. The file travels as base64 inside
// the JSON-RPC tools/call body (the only authenticated channel a sandboxed
// widget has). base64 inflates ~33%, so 5 MB raw stays within the 8 MB Express
// body limit (see createMcpExpressApp). The widget enforces the same cap up
// front for instant feedback; this is the authoritative server-side guard.
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export function registerAddIncidentAttachmentTool(server: McpServer, client: ServiceNowClient): void {
  server.tool(
    "add_incident_attachment",
    [
      "Attach a file (e.g. a screenshot) to one of the user's ServiceNow incidents.",
      "Use this when the user wants to add a screenshot or document to an incident.",
      "The file content is provided base64-encoded. Re-renders the incident-detail widget with the new attachment.",
      "Files are limited to 5 MB."
    ].join(" "),
    {
      incidentSysId: z
        .string()
        .min(1)
        .describe("The sys_id of the incident to attach the file to."),
      fileName: z
        .string()
        .min(1)
        .describe("The file name including extension, e.g. 'screenshot.png'."),
      contentType: z
        .string()
        .min(1)
        .describe("The file's MIME type, e.g. 'image/png' or 'application/pdf'."),
      dataBase64: z
        .string()
        .min(1)
        .describe("The file content, base64-encoded (no data: URI prefix).")
    },
    async ({ incidentSysId, fileName, contentType, dataBase64 }) => {
      try {
        // Strip an optional data: URI prefix the widget might include.
        const base64 = dataBase64.replace(/^data:[^;]+;base64,/, "");
        const data = Buffer.from(base64, "base64");
        if (data.length === 0) {
          throw new Error("The attachment is empty or not valid base64.");
        }
        if (data.length > MAX_ATTACHMENT_BYTES) {
          throw new Error(
            `Attachment is too large (${Math.round(data.length / (1024 * 1024))} MB). The limit is 5 MB.`
          );
        }

        await client.addIncidentAttachment(incidentSysId, { fileName, contentType, data });
        return await buildIncidentDetailResult(client, incidentSysId);
      } catch (error) {
        Logger.warn("add_incident_attachment tool failed", {
          operation: "tool.add_incident_attachment",
          incidentSysId
        }, error);
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message, operation: "add_incident_attachment" }, null, 2)
            }
          ]
        };
      }
    }
  );
}

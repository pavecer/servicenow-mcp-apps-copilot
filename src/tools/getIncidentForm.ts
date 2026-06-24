import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Static incident report form. Unlike a catalog item, an incident form has no
// per-record fetch — the field set is fixed, so this tool returns a compact
// field schema (the same shape the order-form widget consumes) and mounts the
// incident-form widget. The widget collects values and calls report_incident.
const INCIDENT_FORM_FIELDS: Array<Record<string, unknown>> = [
  {
    name: "shortDescription",
    label: "What's the problem?",
    type: "string",
    required: true
  },
  {
    name: "description",
    label: "Details (what happened, when, any error messages)",
    type: "longtext",
    required: false
  },
  {
    name: "category",
    label: "Category",
    type: "string",
    required: false,
    choices: [
      { title: "Inquiry / Help", value: "inquiry" },
      { title: "Software", value: "software" },
      { title: "Hardware", value: "hardware" },
      { title: "Network", value: "network" },
      { title: "Database", value: "database" }
    ]
  },
  {
    name: "urgency",
    label: "How urgent is this for you?",
    type: "string",
    required: false,
    choices: [
      { title: "High", value: "1" },
      { title: "Medium", value: "2" },
      { title: "Low", value: "3" }
    ]
  },
  {
    name: "impact",
    label: "Who is affected?",
    type: "string",
    required: false,
    choices: [
      { title: "Just me", value: "3" },
      { title: "My team", value: "2" },
      { title: "Many people / whole site", value: "1" }
    ]
  }
];

export function registerGetIncidentFormTool(server: McpServer): void {
  server.tool(
    "get_incident_form",
    [
      "Open the 'report an incident' form so the user can describe a problem with IT.",
      "Use this when the user wants to report an issue, log a ticket, or get help with something broken.",
      "Renders the incident-form widget. The user fills it in and submits, which calls report_incident."
    ].join(" "),
    {},
    async () => ({
      content: [
        {
          type: "text" as const,
          text: "Incident report form ready."
        }
      ],
      structuredContent: {
        fields: INCIDENT_FORM_FIELDS,
        defaults: { urgency: "2", impact: "3" }
      }
    })
  );
}

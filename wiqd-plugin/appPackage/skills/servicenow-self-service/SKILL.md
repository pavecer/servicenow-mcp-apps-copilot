---
name: servicenow-self-service
description: Use ServiceNow Knowledge, catalog, requests, approvals, and incidents when the user asks for IT self-service, ServiceNow records, or help with workplace technology.
---

# ServiceNow self-service

Use the tools exposed by the **ServiceNow MCP** connector for ServiceNow
requests. Prefer the narrowest tool that satisfies the user's intent:

- Search Knowledge before suggesting a known fix.
- Search the catalog before ordering an item or access request.
- Show the user's own requests, approvals, or incidents when they ask for status.
- Ask for confirmation immediately before creating, changing, approving, or
  cancelling a record.
- For incident reporting, collect the impact, urgency, and a concise
  description before submitting.

Respect the MCP server's response and authorization decisions. Do not invent
sys_ids, approval states, catalog variables, or incident numbers. If the
connector returns an error or an empty result, explain what happened and give
the user a concrete next step instead of claiming success.

When a widget or structured result is returned, let Microsoft 365 Copilot
render it and summarize only the key outcome. Do not repeat the full tool
payload or expose access tokens, client secrets, or internal configuration.

# Runbook 08: classic API Management v2 comparison (A5) - not executed

Recommended next test, because Track A showed identity loss on the AI Gateway tier.

1. Create a Basic v2 / Standard v2 APIM instance (check the current price
   first; not covered by the USD 20 lab budget).
2. MCP servers > Expose an existing MCP server > Function `/mcp`.
3. Policy: `validate-jwt` for audience `api://<snowmcp-gwlab-server appId>`;
   leave `Authorization` untouched so it is forwarded.
4. Run the harness with a user bearer and no key; check `present_bearer=true`
   and `opened_by` on the created incident.

Expected per docs: per-user OBO survives; Agent 365 governance is limited to
inventory and server block. Discovery should be covered by the consent role,
which targets `Microsoft.ApiManagement/service`.

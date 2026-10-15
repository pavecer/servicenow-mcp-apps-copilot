# Runbook 04: M365 declarative agent via the gateway (E1, D2) - not executed

Why not: Track A showed the gateway cannot carry the user's token (400 for
api-key + Authorization, header stripped for Entra callers) and Track B showed
widgets cannot load (`resources/*` 400, `_meta.ui` stripped). A lab agent
pointed at the gateway would get only `isError` 401 results for OBO tools.

If retried after a gateway change:

1. Copy `m365-agent/` to a lab folder with a **new app ID**; never overwrite the dev package.
2. Point the MCP plugin runtime at `LAB_GATEWAY_MCP_URL`; auth = API key (plugin vault) or OAuth.
3. Sideload, run "find a laptop" and "report an incident"; record whether widgets mount and who `opened_by` is.
4. D2: with a tool blocked on the gateway, the existing dev agent (direct URL) still succeeds; see D1 evidence.

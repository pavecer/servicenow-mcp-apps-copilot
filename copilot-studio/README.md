# Copilot Studio reference agents

This directory contains **reference Microsoft Copilot Studio agent exports** that
demonstrate how the [ServiceNow MCP server](../README.md) in this repo is
intended to plug into the Microsoft Employee Self-Service (ESS) agent
architecture. They are the architectural baseline for any new MCP tool, topic,
or action you add to the server.

> **Read these before adding new MCP tools.** The naming, action wiring, and
> handoff patterns shown here are what makes the MCP server compose cleanly
> with Microsoft's pre-built ESS agents. Tools that diverge from these patterns
> still work, but won't be discoverable or invocable from the standard ESS
> orchestrators.

## Layout

```
copilot-studio/
├── topics/                                    # Standalone topic samples (legacy single-topic flow)
│   └── [CTOP] - SnowMCP OrderCat.yaml         # Deterministic search → form → order topic
│
├── mcs-agents/                                # Full agent exports — the architectural reference
│   ├── employee-self-service-it/              # Microsoft's first-party ESS IT agent (Contoso demo build)
│   │   └── Employee Self-Service IT/          #   Topics, knowledge, workflows, ITSM orchestrator
│   ├── ess-servicenow-catalog-extension/      # Standalone child agent that BACKS THIS MCP SERVER
│   │   └── ESS ServiceNow Catalog/
│   │       ├── actions/ESSServiceNowMCPServer.mcs.yml   # MCP action → this repo's /mcp endpoint
│   │       └── topics/ServiceNowCatalog*.mcs.yml        # Catalog ordering conversation flow
│   └── %5bCA%5d SNOW Test/                    # Minimal test agent that wires only the MCP action
│
└── pulled/                                    # Managed-solution snapshots (read-only baselines)
    └── ess-it-managed/
```

## How this MCP server fits the ESS architecture

The intended composition is:

1. **Employee Self-Service IT** (parent agent) — handles the full IT helpdesk
   conversation, classification, and escalation. When the user expresses intent
   to order a catalog item, it hands off to:
2. **ESS ServiceNow Catalog** (connected child agent) — focused on the
   catalog-ordering flow: search → form → confirm → submit. Its `actions/`
   point at:
3. **ESSServiceNowMCPServer.mcs.yml** — a Copilot Studio MCP action whose
   endpoint is the deployed Azure Function from this repo
   (`https://<func>.azurewebsites.net/mcp`). It exposes the six MCP tools
   (`search_catalog_items`, `get_catalog_item_form`, `place_order`,
   `list_user_orders`, `update_order`, `validate_servicenow_config`).
4. **Topics under `ESS ServiceNow Catalog/topics/`** drive the deterministic
   conversation around the MCP tool calls and render the Adaptive Cards
   returned by `place_order` / `get_catalog_item_form`.

When you add a new MCP tool to `src/tools/`, the corresponding Copilot Studio
piece usually lives in `ess-servicenow-catalog-extension/` — either as a new
topic that calls the action, or as a new operation parameter on the existing
`ESSServiceNowMCPServer` action.

## Concepts to preserve when extending

- **Tool names use `snake_case`** — Copilot Studio surfaces them verbatim in
  authoring; matches the exports in `actions/`.
- **Adaptive Cards belong to the MCP response, not the topic.** Topics render
  whatever card the tool returns rather than building cards in Power Fx — this
  is what the existing tools do (`buildOrderFormAdaptiveCard`,
  `buildOrderConfirmationAdaptiveCard`).
- **Pre-fill from `System.User.PrincipalName` / conversation context** before
  prompting. The catalog topic does this for `requested_for`; new tools should
  accept the equivalent of `--upn` so the topic doesn't have to ask.
- **Errors return JSON, not exceptions.** All current tools return a `success:
  false` payload with `error` / `message` so `ServiceNowCatalogOnError`-style
  topics can branch on it cleanly.
- **Auth.** The ESS extension agent expects the MCP action to authenticate via
  Entra OAuth 2.0 dynamic discovery — the deployed function exposes
  `/.well-known/openid-configuration` and `/oauth/register` to make this
  zero-config in Copilot Studio.

## What is and isn't committed

These exports are **not** managed solutions and **do not** contain credentials.
They contain references to tenant identifiers (TenantId, EnvironmentId, agent
GUIDs) that were redacted before the repo was made public — see the YAML files
for the placeholder shapes.

`.mcs/conn.json` is **gitignored** because it's a per-developer connection
binding regenerated whenever you `pac copilot init` against the agent.

## Pulling updates from Copilot Studio

If you change one of these agents in the portal and want to refresh the
reference here:

```powershell
pac auth create --tenant <YOUR_TENANT_ID>
pac copilot list
pac copilot pull --copilot-id <agent-id> --output ./copilot-studio/mcs-agents/<agent-folder>
```

Then commit the diff. Inspect the diff for tenant-specific identifiers if you
intend to make this repo public.

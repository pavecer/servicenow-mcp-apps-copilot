# M365 Agents Toolkit project for the ServiceNow MCP declarative agent

This folder packages the [`mcp-server-servicenow`](../README.md) project as a
**Microsoft 365 Copilot declarative agent** with **SEP-1865 MCP App widgets**.
It is consumed by the [Microsoft 365 Agents Toolkit](https://marketplace.visualstudio.com/items?itemName=TeamsDevApp.ms-teams-vscode-extension)
VS Code extension (v6.6.1 or later).

## Layout

```
m365-agent/
├── appPackage/
│   ├── declarativeAgent.json   # The agent — name, instructions, conversation starters
│   ├── ai-plugin.json          # MCP server action wiring the agent to /mcp
│   └── manifest.json           # Teams app manifest (validDomains, icons, copilotAgents)
├── env/.env.dev                # Environment defaults (copy to .env.dev.user, fill in)
├── m365agents.yml              # Agents Toolkit lifecycle (provision / publish)
└── .vscode/mcp.json            # MCP Inspector / Agents Toolkit "Fetch action from MCP" config
```

> The `appPackage/build/`, `appPackage/color.png`, and `appPackage/outline.png`
> files are produced/owned by the Agents Toolkit. On first provision the
> Toolkit will scaffold the icons for you (or you can drop your own 192×192 PNGs).

## Prerequisites

- **MCP server is already deployed** (see [`scripts/deploy-azure.ps1`](../scripts/deploy-azure.ps1)).
- **MCP Apps feature flag enabled** on the deployed function app:
  set the `MCP_APPS_ENABLED=true` app setting. Without it the server still works
  for Copilot Studio but does not expose the widget resources or `_meta.ui`
  metadata required by SEP-1865.
- **Entra redirect URIs** added to your `ENTRA_CLIENT_ID` app registration:
  - `https://teams.microsoft.com/api/platform/v1.0/oAuthConsentRedirect`
    (M365 Copilot SSO)
  - `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect`
    (M365 Copilot OAuth 2.1)
  - `https://vscode.dev/redirect` (Agents Toolkit "Fetch action from MCP")

## Quick start

1. `cp env/.env.dev env/.env.dev.user` and fill in `MCP_SERVER_URL` /
   `MCP_SERVER_DOMAIN`.
2. Open the repo in VS Code and select **Microsoft 365 Agents Toolkit** in the
   Activity Bar.
3. Click **Provision** in the Lifecycle pane — the Toolkit creates the Teams
   app, OAuth registration (or reuses your existing `ENTRA_CLIENT_ID`), and
   uploads `appPackage/`.
4. Open <https://m365.cloud.microsoft/chat>, find **ServiceNow Catalog** in
   the left agent picker, and try one of the conversation starters.

## Widgets

Four MCP App widgets are exposed when `MCP_APPS_ENABLED=true`:

| Tool                     | Widget URI                                         | What it renders                                |
| ------------------------ | -------------------------------------------------- | ---------------------------------------------- |
| `search_catalog_items`   | `ui://servicenow-mcp/catalog-browse.html`          | Grid of catalog item cards                     |
| `get_catalog_item_form`  | `ui://servicenow-mcp/order-form.html`              | Inline order form with submit → `place_order`  |
| `list_user_orders`       | `ui://servicenow-mcp/my-orders.html`               | Table of open orders with refresh + drill-in   |
| `get_order_detail`       | `ui://servicenow-mcp/order-detail.html`            | Single order with items, approvals, comment    |

All widgets gracefully degrade to text when the host doesn't support
[SEP-1865](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
widget rendering — the same `content[0].text` Adaptive Card payload used by
the Copilot Studio agents in [`copilot-studio/`](../copilot-studio/) is
returned alongside the widget `structuredContent`.

## Coexistence with the Copilot Studio agents

The existing Copilot Studio agents under [`copilot-studio/mcs-agents/`](../copilot-studio/)
keep working unchanged. They only read the `adaptiveCard` field from
`content[0].text`, which is preserved byte-for-byte regardless of the
`MCP_APPS_ENABLED` value.

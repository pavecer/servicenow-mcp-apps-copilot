# ServiceNow MCP Server

**Order from ServiceNow directly inside Microsoft 365 Copilot** — a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that brings ServiceNow Service Catalog to life in Microsoft 365 Copilot and Cowork via interactive MCP Apps widgets. Search, fill forms, place orders, track status, and manage your cart — all with natural language.

```
┌─────────────────────┐        ┌──────────────────────┐        ┌──────────────┐
│ Microsoft 365       │        │ ServiceNow MCP       │        │ ServiceNow   │
│ Copilot / Cowork    │────────│ Server (Azure Fn)    │────────│ Catalog      │
│                     │        │                      │        │              │
│ "Order a laptop"    │ OAuth  │ + 14 MCP Tools       │ OAuth  │ + Cart       │
│ + 5 Widgets         │        │ + 5 SEP-1865 Widgets │        │ + Orders     │
└─────────────────────┘        └──────────────────────┘        └──────────────┘
```

**What you get:**
- 14 MCP tools: search catalog, fetch forms, place/edit orders, manage cart, validate config
- 5 interactive widgets (SEP-1865): catalog browse, order form, cart, my orders, order detail
- Per-user authentication: orders stamped with the real user (not a service account)
- Stateless, scalable: Flex Consumption Azure Functions + Node.js 20
- Production-ready: 215 unit tests, secret management, audit logging, security guidelines

**Quick facts:**
| | |
|------|-----|
| **Runtime** | Azure Functions v4, Flex Consumption, Node.js 20+ |
| **Auth** | Microsoft Entra ID OAuth 2.0 |
| **Transport** | Streamable HTTP (MCP standard) |
| **Infrastructure** | Bicep IaC + azd, optional Docker/Container Apps |
| **Cost** | ~$2–5/mo for dev, <$50/mo for small pilot ([cost guide](docs/COST_ESTIMATION.md)) |

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Azure subscription** | Permissions to create resource groups, Function Apps, App registrations, Key Vault |
| **Azure CLI & azd** | [Installation guide](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd) |
| **Node.js 20+** | To build locally |
| **ServiceNow instance** | Admin access to set up OAuth apps and integration user |
| **Microsoft Entra ID** | Permissions to register an app |
| **Microsoft 365 Copilot** | License required to run the declarative agent |

---

## Quick Start

**1. Prepare ServiceNow:**
```powershell
pwsh -File scripts/setup-servicenow.ps1 -InstanceUrl https://<instance>.service-now.com -AdminUser <user> -AdminPassword <pass>
```
→ Save the **Client ID**, **Client Secret**, and **integration user** credentials.

**2. Prepare Entra ID:**
- Go to [Azure Portal](https://portal.azure.com) > **Entra ID > App registrations > New registration**
- Name: `ServiceNow MCP Server` → **Register**
- Save **Application (client) ID** and **Directory (tenant) ID**
- Add a **client secret** > save it
- Go to **Expose an API** > set default URI, add scope `access_as_user`
- Add **Web redirect URIs**: `https://oauth.botframework.com/callback`, `https://global.consent.azure-apim.net/redirect`

**3. Deploy to Azure:**
```bash
npm run deploy:azure
```
→ Prompted for values; Function App + Key Vault + App Insights provisioned.

**4. Enable Widgets (optional):**
- Set `MCP_APPS_ENABLED=true` on the Function App.
- Sideload the agent under [`m365-agent/`](m365-agent/README.md).

**For detailed steps, see:**
- [ServiceNow Setup](docs/SERVICENOW_SETUP.md)
- [Entra ID Configuration](docs/) (within Deployment guide)
- [M365 Copilot Integration](docs/M365_COPILOT_MCP_APPS.md)
- [Container Deployment (Optional)](docs/DEPLOY_CONTAINER_AZURE.md)
- [Agent 365 Registration (Optional)](docs/AGENT_365_BYO_MCP.md)

---

## Architecture

```
                    Entra OAuth
                         ↓
┌────────────────────────────────────────────────────────────┐
│  Microsoft 365 Copilot (Cowork)                           │
│  • User sends natural-language intent                      │
│  • Agent routes to MCP tools or widgets                    │
└────────────────────────────────────────────────────────────┘
                         ↓
              MCP Streamable HTTP
                    + Bearer token
                         ↓
┌────────────────────────────────────────────────────────────┐
│  ServiceNow MCP Server (Azure Functions, Node.js 20)      │
│  • Validates Entra token + extracts caller identity       │
│  • Calls ServiceNow APIs (catalog, orders)                │
│  • Attributes orders to real users (not service account)  │
│  • Returns MCP tools + SEP-1865 widgets (optional)        │
└────────────────────────────────────────────────────────────┘
                         ↓
                ServiceNow OAuth
                         ↓
┌────────────────────────────────────────────────────────────┐
│  ServiceNow Instance                                       │
│  • Catalog tables (sc_cat_item, sc_category)              │
│  • Requests (sc_request, sc_req_item)                     │
│  • Users (sys_user) — for per-user attribution            │
└────────────────────────────────────────────────────────────┘
```

**Key features:**
- **Delegated identity**: Orders stamped with real user, not the integration account
- **MCP Apps widgets (optional)**: When `MCP_APPS_ENABLED=true`, renders 5 interactive widgets (catalog-browse, order-form, cart, my-orders, order-detail)
- **Secure defaults**: All secrets in Key Vault, no plaintext credentials, Entra-gated endpoints
- **Stateless**: No session storage; every request validates OAuth token

**Learn more:** [Architecture & Auth Flows](docs/), [Config Reference](docs/), [Per-User ACL / OBO](docs/AUTH_ENTRA_OBO_OKTA.md)

---

## Develop Locally

```bash
npm install
cp local.settings.sample.json local.settings.json
# Edit local.settings.json with your ServiceNow + Entra credentials
npm run build    # regenerates widgets, then tsc
npm test         # vitest — must pass before PR
npm run start:dev # runs on http://localhost:7071/mcp
```

**Test the deployment:**
```bash
npm run smoke:test   # validates connectivity + sample flows
```

**See also:** [Local Development Guide](docs/LOCAL_DEVELOPMENT.md)

---

## Documentation Index

| Topic | Link |
|-------|------|
| **Getting Started** | [ServiceNow Setup](docs/SERVICENOW_SETUP.md) • [Deployment](docs/) |
| **Architecture** | [Auth Flows](docs/AUTH_ENTRA_OBO_OKTA.md) • [Scenario Flows](docs/SERVICENOW_SCENARIO_FLOWS.md) • [MCP Apps Integration](docs/M365_COPILOT_MCP_APPS.md) |
| **Operations** | [Environment Variables](docs/CONFIG_REFERENCE.md) • [Troubleshooting](docs/TROUBLESHOOTING.md) • [Cost Model](docs/COST_ESTIMATION.md) |
| **Advanced** | [Per-User ACLs / OBO](docs/AUTH_ENTRA_OBO_OKTA.md) • [Agent 365 Registration](docs/AGENT_365_BYO_MCP.md) • [Container Deployment](docs/DEPLOY_CONTAINER_AZURE.md) |
| **Development** | [Contributing](CONTRIBUTING.md) • [Engineering Guardrails](docs/ENGINEERING_GUARDRAILS.md) • [Build/Test Commands](AGENTS.md) |
| **Security** | [Security Guidelines](SECURITY.md) • [Code of Conduct](CODE_OF_CONDUCT.md) |

---

## Roadmap

This is a community project; the items below are directional, not committed
dates. Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

**Now (in `main`)**
- Catalog search, item form, single-item order, and order tracking tools.
- ServiceNow cart flow (`add_to_cart` → `submit_cart`) behind `MCP_APPS_ENABLED`.
- Per-item order edits (`update_order_item` / `remove_order_item`).
- Five MCP Apps (SEP-1865) widgets for Microsoft 365 Copilot / Cowork.
- Delegated identity attribution (`requested_for` / `opened_by` re-stamping).
- Entra On-Behalf-Of (OBO) token exchange for per-user ServiceNow ACLs (opt-in).

**Next**
- Promote OBO from opt-in to a documented, first-class deployment profile.
- Approval actions (approve / reject) surfaced in the order-detail widget.
- Attachment upload on catalog requests.
- Richer catalog faceting (category browse, variable validation hints).
- Expanded automated test coverage for the ServiceNow client error paths.

**Later / exploring**
- Additional MCP hosts beyond Microsoft 365 Copilot (IDE clients, CLI agents).
- Optional Okta / non-Entra identity brokering (see [docs/AUTH_ENTRA_OBO_OKTA.md](docs/AUTH_ENTRA_OBO_OKTA.md)).
- Multi-instance / multi-tenant ServiceNow routing.

Have an idea? Open an issue using the
[feature request template](.github/ISSUE_TEMPLATE/feature_request.md).

---

## Contributing

Pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for the
build/test workflow, the repo invariants (see [AGENTS.md](AGENTS.md)), and the
[Code of Conduct](CODE_OF_CONDUCT.md). In short:

```bash
npm install
npm run build   # regenerates widgets, then tsc
npm test        # vitest — must be green before a PR
```

Release notes are tracked in [CHANGELOG.md](CHANGELOG.md).

---

## License

Released under the [MIT License](LICENSE) — © 2026 Pavel Vecer. You are free to
use, fork, modify, and deploy this project; see the license text for the full
terms and the "no warranty" clause.


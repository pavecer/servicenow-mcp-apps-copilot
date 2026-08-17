# ServiceNow MCP Server

**Find answers and use ServiceNow directly inside Microsoft 365 Copilot** — a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that brings ServiceNow Knowledge, Service Catalog, and incident self-service to Microsoft 365 Copilot and Cowork via interactive MCP Apps widgets.

**Technical project site:** [pavecer.github.io/servicenow-mcp-apps-copilot](https://pavecer.github.io/servicenow-mcp-apps-copilot/)

```
┌─────────────────────┐        ┌──────────────────────┐        ┌──────────────┐
│ Microsoft 365       │        │ ServiceNow MCP       │        │ ServiceNow   │
│ Copilot / Cowork    │────────│ Server (Azure Fn)    │────────│ Catalog      │
│                     │        │                      │        │              │
│ "How do I use VPN?"│ OAuth  │ + 27 MCP Tools       │ OAuth  │ + Knowledge  │
│ + 9 Widgets         │        │ + 9 SEP-1865 Widgets │        │ + Catalog    │
└─────────────────────┘        └──────────────────────┘        └──────────────┘
```

**What you get:**
- 27 MCP tools: ranked Knowledge search/detail, native feedback, consent-based KB escalation, catalog ordering, cart/order management, approvals, and incident management
- 9 interactive widgets (SEP-1865), including a shared ranked Knowledge results/article/escalation experience
- Per-user authentication: orders and incidents stamped with the real user (not a service account)
- Stateless, scalable: Flex Consumption Azure Functions + Node.js 20
- Production-ready: 300+ unit tests, secret management, audit logging, security guidelines

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
| **PowerShell 7** | Required by deployment and ServiceNow setup scripts on every OS |
| **Azure Functions Core Tools 4** | Required for `npm start` and local Functions debugging |
| **M365 Agents Toolkit** | The release workflow runs the CLI through `npx`; install the recommended VS Code extension for interactive agent work |
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
```powershell
npm run deploy:azure
```
→ Prompted for values; Function App + Key Vault + App Insights provisioned.

**4. Sideload the agent:**
- Sideload the agent under [`m365-agent/`](m365-agent/README.md) to render the
  interactive widgets in Microsoft 365 Copilot.

**For detailed steps, see:**
- [ServiceNow Setup](docs/SERVICENOW_SETUP.md)
- [Entra ID Configuration](docs/AUTH_ENTRA_OBO.md)
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
│  • Returns MCP tools + SEP-1865 widgets                   │
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
- **MCP Apps widgets**: Renders 8 interactive widgets (catalog-browse, order-form, cart, my-orders, order-detail, incident-form, my-incidents, incident-detail) with compact `structuredContent` per tool result
- **Secure defaults**: All secrets in Key Vault, no plaintext credentials, Entra-gated endpoints
- **Stateless**: No session storage; every request validates OAuth token

**Learn more:** [Architecture & Auth Flows](docs/SERVICENOW_SCENARIO_FLOWS.md), [Config Reference](docs/CONFIG_REFERENCE.md), [Per-User ACL / OBO](docs/AUTH_ENTRA_OBO.md)

---

## Develop Locally

```powershell
# Configure your organization-approved registry before installing packages.
npm config set registry https://<approved-registry>/ --location=user
npm ci
Copy-Item local.settings.sample.json local.settings.json
# Edit local.settings.json with your ServiceNow + Entra credentials
npm run build    # regenerates widgets, then tsc
npm test         # vitest — must pass before PR
npm run start:dev # runs on http://localhost:7071/mcp
```

**Test the deployment:**
```powershell
npm run smoke:test   # validates connectivity + sample flows
```

**Automated release up to M365 Copilot prompt testing:**

```powershell
npm run release:auto -- --environment snowmcpwidg-dev
```

This runs build + tests, provisions Azure configuration, deploys the Function,
validates required live MCP tools, validates and updates the existing M365 agent
package, and stops at "ready for human prompt test in M365 Copilot". In tenants
where policy disables deployment-storage public access, it creates a narrow,
two-hour exemption for that one policy rule and storage account, then removes
the exemption and restores disabled access immediately after deployment.

When a release needs a new package version, use `npm run release:prepare` so
Copilot receives a new cached package and npm/M365 versions remain synchronized.
Use `npm run release:check` and follow the
[release plan](docs/RELEASE_PLAN.md) rather than editing one version source
independently.

To submit the validated package to the tenant organizational catalog instead
of only provisioning the developer copy, run:

```bash
npm run release:publish -- --environment snowmcpwidg-dev
```

This still requires approval in Teams Admin Center. Use a separate `prod`
Agents Toolkit environment and app ID for production; the committed `dev`
environment intentionally produces the `ServiceNow Assistantdev` test name.
For a separately configured production package, add `--agent-environment prod`.

**Phase 1 readiness preflight (IT + HR + KB planning):**

```bash
npm run preflight:readiness
```

This verifies local ServiceNow/API readiness for catalog, incident, knowledge,
and HR table surfaces before new scenario implementation. See
[docs/PHASE1_HR_KB_VALIDATION.md](docs/PHASE1_HR_KB_VALIDATION.md).

**Create repeatable approval demo data:**

```bash
npm run demo:seed
npm run demo:verify
# After the demo:
npm run demo:cleanup
```

This creates marked, reusable requests and pending approvals for Alex Baker and
admin in the configured ServiceNow development instance. See
[docs/DEMO_APPROVAL_FLOW.md](docs/DEMO_APPROVAL_FLOW.md).

**See also:** [Local Development Guide](docs/LOCAL_DEVELOPMENT.md) and
[GitHub Codespaces Development](docs/CODESPACES.md)

---

## Documentation Index

| Topic | Link |
|-------|------|
| **Getting Started** | [ServiceNow Setup](docs/SERVICENOW_SETUP.md) • [Deployment](#quick-start) |
| **Demo** | [Approval Demo Data and Prompts](docs/DEMO_APPROVAL_FLOW.md) |
| **Architecture** | [Auth Flows](docs/AUTH_ENTRA_OBO.md) • [Scenario Flows](docs/SERVICENOW_SCENARIO_FLOWS.md) • [MCP Apps Integration](docs/M365_COPILOT_MCP_APPS.md) |
| **Operations** | [Environment Variables](docs/CONFIG_REFERENCE.md) • [Troubleshooting](docs/TROUBLESHOOTING.md) • [Cost Model](docs/COST_ESTIMATION.md) |
| **Advanced** | [Agent 365 Publishing & Governance](docs/AGENT_365_PUBLISHING.md) • [Per-User ACLs / OBO](docs/AUTH_ENTRA_OBO.md) • [Agent 365 MCP Registration](docs/AGENT_365_BYO_MCP.md) • [Container Deployment](docs/DEPLOY_CONTAINER_AZURE.md) |
| **Development** | [Codespaces](docs/CODESPACES.md) • [Contributing](CONTRIBUTING.md) • [Engineering Guardrails](docs/ENGINEERING_GUARDRAILS.md) • [Build/Test Commands](AGENTS.md) |
| **Security** | [Security Guidelines](SECURITY.md) • [Code of Conduct](CODE_OF_CONDUCT.md) |

---

## Roadmap

This is a community project; the items below are directional, not committed
dates. Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

**Now (in `main`)**
- Catalog search, item form, single-item order, and order tracking tools.
- ServiceNow cart flow (`add_to_cart` → `submit_cart`).
- Per-item order edits (`update_order_item` / `remove_order_item`).
- Manager approval actions from order detail (`approve_order_approval` / `reject_order_approval`).
- Incident management for end users: report a problem, track your incidents,
  read the comment activity, add a comment, and attach or remove a file/screenshot
  (`report_incident`, `list_user_incidents`, `get_incident_detail`,
  `add_incident_comment`, `add_incident_attachment`, `remove_incident_attachment`).
- Eight MCP Apps (SEP-1865) widgets for Microsoft 365 Copilot / Cowork.
- Delegated identity attribution (`requested_for` / `opened_by` / `caller_id`).
- Entra On-Behalf-Of (OBO) token exchange so ServiceNow writes run **as the real
  end user** (per-user ACLs; comments/attachments authored by the user, not the
  integration account). Config-only via `ENTRA_OBO_ENABLED` +
  `ENTRA_OBO_DOWNSTREAM_SCOPE` — see [docs/AUTH_ENTRA_OBO.md](docs/AUTH_ENTRA_OBO.md).

**Next**
- Attachment upload on catalog requests.
- Richer catalog faceting (category browse, variable validation hints).
- Expanded automated test coverage for the ServiceNow client error paths.
- Phase 1 foundation for IT + HR + KB expansion: readiness preflight, admin
  setup validation, and deployment runbook hardening.

**Later / exploring**
- Optional Okta / non-Entra identity brokering (see [docs/AUTH_ENTRA_OBO.md](docs/AUTH_ENTRA_OBO.md)).
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


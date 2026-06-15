# ServiceNow MCP Server

A stateless [Model Context Protocol](https://modelcontextprotocol.io) server for ServiceNow Service Catalog, hosted on Azure Functions. It delivers ServiceNow catalog ordering — search items, fill order forms, place and track orders — directly inside **Microsoft 365 Copilot and Cowork** via **MCP Apps** (SEP-1865) interactive widgets.

**MCP tools provided:**

| Tool | Description |
|------|-------------|
| `search_catalog_items` | Full-text catalog search with Adaptive Card item picker |
| `get_catalog_item_form` | Returns an Adaptive Card form for the selected item |
| `place_order` | Submits the order and returns a confirmation Adaptive Card |
| `list_user_orders` | Lists the caller's open (non-closed) catalog orders, enriched with their request items |
| `get_order_detail` | Retrieves a single `sc_request` with its items and approvals (used by the M365 Copilot "MCP Apps" detail widget) |
| `update_order` | Updates a small allowlist of requestor-mutable fields on the caller's order (`short_description`, `description`, `comments`, `urgency`, `priority`) |
| `validate_servicenow_config` | Validates OAuth and catalog API access end-to-end |

> **This repo is dedicated to the MCP Apps capability** — delivering ServiceNow catalog ordering to Microsoft 365 Copilot / Cowork. The full build-and-debug story, the deployment map, and the per-user-identity (OBO) research are in [`DEVELOPMENT_JOURNAL.md`](DEVELOPMENT_JOURNAL.md).

**Microsoft 365 Copilot "MCP Apps" widget rendering** (SEP-1865): set the app setting `MCP_APPS_ENABLED=true` and four `ui://servicenow-mcp/*.html` widgets become available (catalog browse, order form, my orders, order detail). When the flag is **off**, tool results fall back to a legacy Adaptive Card surface in `content[0].text` (still consumable by an MCP client such as a Copilot Studio agent). Declarative-agent package: [`m365-agent/`](m365-agent/README.md). See [`docs/M365_COPILOT_MCP_APPS.md`](docs/M365_COPILOT_MCP_APPS.md) for the end-to-end story.

**Related documentation:**

- [Microsoft 365 Copilot MCP Apps integration](docs/M365_COPILOT_MCP_APPS.md) -- enable SEP-1865 widget rendering and sideload the declarative-agent package under [`m365-agent/`](m365-agent/README.md)
- [Agent 365 BYO MCP](docs/AGENT_365_BYO_MCP.md) -- register this server in the Microsoft 365 admin center for tenant-wide governance
- [Authentication patterns (Entra OBO / Okta)](docs/AUTH_ENTRA_OBO_OKTA.md) -- per-user ServiceNow identity via On-Behalf-Of token exchange
- [ServiceNow Setup](docs/SERVICENOW_SETUP.md) -- OAuth app, integration user, and permissions
- [Cost Estimation](docs/COST_ESTIMATION.md) -- Azure infrastructure cost model, per-operation pricing, and worked examples for pilot / SMB / enterprise scenarios
- [Optional Container Deployment](docs/DEPLOY_CONTAINER_AZURE.md) -- run as one Docker container in Azure Container Apps
- [Security Guidelines](SECURITY.md) -- what to never commit

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Azure subscription | Permission to create resource groups and Entra app registrations |
| Azure CLI (az) | [Install guide](https://learn.microsoft.com/cli/azure/install-azure-cli) |
| Azure Developer CLI (azd) | [Install guide](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd) |
| Node.js 20+ | To build the project locally |
| ServiceNow instance | Admin access to create OAuth apps and users |
| Microsoft Entra ID | Permission to register an app |
| Microsoft 365 Copilot | A Microsoft 365 Copilot license to sideload and run the declarative agent; MCP Apps widgets render inline in Copilot / Cowork |

---

## Quick Start

### Step 1 -- Set up ServiceNow

See [docs/SERVICENOW_SETUP.md](docs/SERVICENOW_SETUP.md) for the complete guide, or run the automation script:

```powershell
pwsh -File scripts/setup-servicenow.ps1 \
  -InstanceUrl https://<instance>.service-now.com \
  -AdminUser <admin-username> \
  -AdminPassword <admin-password>
```

What you need from ServiceNow:
- **Client ID** and **Client Secret** from the OAuth App Registry entry
- **Integration user** username and password (with `catalog` role)

---

### Step 2 -- Register an Entra ID Application

This enables per-user OAuth 2.0 authentication in Copilot Studio.

1. [Azure Portal](https://portal.azure.com) > **Entra ID > App registrations > New registration**
   - Name: `ServiceNow MCP Server`
   - Supported account types: `Accounts in this organizational directory only`
   - Click **Register**
   - Note **Application (client) ID** = `ENTRA_CLIENT_ID`
   - Note **Directory (tenant) ID** = `ENTRA_TENANT_ID`

2. **Certificates & secrets > New client secret** -- copy the value immediately = `ENTRA_CLIENT_SECRET`

3. **Expose an API > Set** Application ID URI -- accept default `api://<ENTRA_CLIENT_ID>`
   - **Add a scope**: name `access_as_user`, consent: Admins and users

4. **Authentication > Add a platform > Web** -- add redirect URIs:
   ```
   https://oauth.botframework.com/callback
   https://global.consent.azure-apim.net/redirect
   https://copilotstudio.preview.microsoft.com/connection/oauth/redirect
   ```
   Enable **Access tokens** and **ID tokens** > **Save**

5. *(Recommended)* **API permissions > Add > My APIs > ServiceNow MCP Server** > `access_as_user` > **Grant admin consent**
   This lets all tenant users use the agent without individual consent prompts.

---

### Step 3 -- Deploy to Azure

**Interactive (recommended for first deployment):**

```powershell
npm run deploy:azure
```

The script prompts for all values, provisions Azure resources (Function App, Key Vault, Application Insights), deploys the function, and prints Copilot Studio setup instructions.

**Non-interactive (CI/CD):**

```powershell
pwsh -File scripts/deploy-azure.ps1 \
  -EnvironmentName prod \
  -Location westeurope \
  -SubscriptionId <subscription-id> \
  -ServiceNowInstanceUrl https://<instance>.service-now.com \
  -ServiceNowClientId <sn-client-id> \
  -ServiceNowClientSecret <sn-client-secret> \
  -ServiceNowUsername <integration-user> \
  -ServiceNowPassword <integration-user-password> \
  -EntraTenantId <entra-tenant-id> \
  -EntraClientId <entra-client-id> \
  -EntraClientSecret <entra-client-secret>
```

**Manual azd:**

```bash
az login && azd auth login
azd env new <env-name>
azd env set SERVICENOW_INSTANCE_URL  "https://<instance>.service-now.com"
azd env set SERVICENOW_CLIENT_ID     "<sn-client-id>"
azd env set SERVICENOW_CLIENT_SECRET "<sn-client-secret>"
azd env set SERVICENOW_USERNAME      "<integration-user>"
azd env set SERVICENOW_PASSWORD      "<integration-user-password>"
azd env set ENTRA_TENANT_ID          "<entra-tenant-id>"
azd env set ENTRA_CLIENT_ID          "<entra-client-id>"
azd env set ENTRA_CLIENT_SECRET      "<entra-client-secret>"
azd up
```

Get the deployed MCP endpoint URL:

```bash
azd env get-values | findstr MCP_ENDPOINT_URL
```

### Optional: Deploy as One Container (Azure Container Apps)

If you prefer a single container deployment instead of Azure Functions, use the Docker + Container Apps path documented in [docs/DEPLOY_CONTAINER_AZURE.md](docs/DEPLOY_CONTAINER_AZURE.md).

This path builds this repo as a single Node.js container and exposes the same MCP endpoint shape at `/mcp`.

---

### Step 4 -- Add to Microsoft 365 Copilot (MCP Apps)

1. Set `MCP_APPS_ENABLED=true` on the deployed Function App.
2. Sideload the declarative-agent package under [`m365-agent/`](m365-agent/README.md) (the Microsoft 365 Agents Toolkit points at this server's MCP discovery URL and generates the manifests).
3. Open the agent in Microsoft 365 Copilot and try a prompt such as `Order a new laptop` — the catalog-browse, order-form, my-orders, and order-detail widgets mount inline in Copilot / Cowork.

See [docs/M365_COPILOT_MCP_APPS.md](docs/M365_COPILOT_MCP_APPS.md) for the full end-to-end story (SEP-1865 widget rendering and the four `ui://servicenow-mcp/*.html` widgets).

---

### Step 5 -- (Optional) Register with Microsoft Agent 365 (BYO MCP)

To make this MCP server tenant-governed (visible in **Microsoft 365 admin center > Agents > Tools > Registry**, monitored in Defender XDR, and discoverable from Copilot Studio, VS Code, Claude Code, and GitHub Copilot CLI), register it as a Bring-Your-Own MCP server with [Microsoft Agent 365](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/manage-tools-for-agent?view=o365-worldwide#bring-your-own-byo-mcp-server).

The server already speaks `EntraOAuth` end-to-end, so no code changes are required. Use the helper script:

```powershell
pwsh -File scripts/register-agent365-mcp.ps1 `
  -ServerName     "ext_ServiceNowMCP" `
  -PublisherName  "<your-org>" `
  -McpEndpointUrl "https://<funcapp>.azurewebsites.net/mcp" `
  -EntraClientId  "<ENTRA_CLIENT_ID>" `
  -TenantId       "<ENTRA_TENANT_ID>"
```

> The CLI requires the server name to start with `ext_` and be ≤ 20 characters.

A tenant admin (Global admin or AI admin) then approves the request in the Microsoft 365 admin center. Full step-by-step guide, troubleshooting, and Defender hunting query: [docs/AGENT_365_BYO_MCP.md](docs/AGENT_365_BYO_MCP.md).

---

## Architecture

- **Runtime**: Azure Functions v4, Node.js 20, Flex Consumption (FC1)
- **Transport**: Streamable HTTP, stateless MCP
- **MCP auth**: OAuth 2.0 via Microsoft Entra ID (per-user sign-in)
- **ServiceNow auth**: OAuth 2.0 password grant with a shared integration user
- **Secrets**: All secrets in Azure Key Vault; Function App reads via managed identity
- **Monitoring**: Application Insights

### HTTP surfaces and authentication

The deployed Function App exposes the routes below. Auth requirements are
fixed in code; no extra Function-level keys, network ACLs, or RBAC are
applied beyond what's documented here.

| Method · Route | Purpose | Auth |
|---|---|---|
| `POST /mcp` | MCP Streamable HTTP — `tools/list`, `tools/call` | **Entra Bearer required** (validated by [src/utils/entraAuthMiddleware.ts](src/utils/entraAuthMiddleware.ts)) |
| `GET /mcp` | SSE readiness probe (Streamable HTTP transport) | Anonymous |
| `DELETE /mcp` | Session cleanup (stateless mode no-op) | Anonymous |
| `OPTIONS /mcp` | CORS preflight | Anonymous |
| `POST /api/catalog/search` · `GET /api/catalog/form/:sysId` · `POST /api/catalog/order` | Deterministic REST surface for Copilot Studio topics | **Entra Bearer required** |
| `OPTIONS /api/catalog/*` | CORS preflight | Anonymous |
| `GET /health` | Liveness/readiness probe — returns `{"status":"ok","server":"servicenow-mcp"}` | Anonymous |
| `GET /.well-known/openid-configuration` · `oauth-authorization-server` · `oauth-protected-resource` | OIDC discovery and RFC 8414/9728 metadata | Anonymous |
| `POST /oauth/register` | RFC 7591 Dynamic Client Registration | Gated — see below |
| `GET /oauth/register` | Lightweight capability doc for clients that probe before POST | Anonymous |

`POST /oauth/register` is **closed by default**: when no `ENTRA_DCR_REGISTRATION_TOKEN` is set and `ENTRA_DCR_ALLOW_UNAUTHENTICATED` is not `"true"`, the endpoint returns **403**. With a registration token configured the request must include `Authorization: Bearer <token>` (constant-time comparison); set `ENTRA_DCR_ALLOW_UNAUTHENTICATED=true` to opt in to anonymous DCR.

When `ENTRA_AUTH_DISABLED=true` (intended for local dev only), Bearer validation is bypassed on `POST /mcp` and `/api/catalog/*`. The startup log emits a `WARN` line stating the effective tenant policy at every cold start so this is visible in App Insights.

### Delegated Identity Flow

Each order is correctly attributed to the Copilot Studio user who placed it:

1. Copilot Studio sends the user's Entra Bearer token to the MCP server.
2. The MCP server validates the token and extracts the caller's UPN/email.
3. The server obtains a ServiceNow token for the integration user (password grant).
4. The caller's email is looked up in `sys_user` to find their ServiceNow `sys_id`.
5. The order is placed, then immediately PATCHed to set `requested_for` to the resolved user.

> **Integration user permissions needed**: read on `sys_user`, read+write on `sc_request`, plus `catalog` and/or `itil` roles.

---

## Local Development

```bash
npm install
cp local.settings.sample.json local.settings.json
# Edit local.settings.json -- ENTRA_AUTH_DISABLED is true by default for local use
npm run start:dev
```

MCP endpoint: `http://localhost:7071/mcp`

```bash
# Smoke test against local
set MCP_ENDPOINT_URL=http://localhost:7071/mcp
npm run smoke:test
```

---

## Environment Variables Reference

### Required

| Variable | Description |
|----------|-------------|
| `SERVICENOW_INSTANCE_URL` | ServiceNow base URL (`https://instance.service-now.com`) |
| `SERVICENOW_CLIENT_ID` | OAuth App Registry client ID |
| `SERVICENOW_CLIENT_SECRET` | OAuth App Registry client secret |
| `SERVICENOW_USERNAME` | Integration user login |
| `SERVICENOW_PASSWORD` | Integration user password |

### Entra ID (required for Copilot Studio OAuth)

| Variable | Description |
|----------|-------------|
| `ENTRA_TENANT_ID` | Entra directory (tenant) ID |
| `ENTRA_CLIENT_ID` | App registration client ID |
| `ENTRA_CLIENT_SECRET` | App registration client secret (for Dynamic Client Registration) |
| `ENTRA_AUDIENCE` | Expected `aud` in tokens; defaults to `api://<ENTRA_CLIENT_ID>` |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `ENTRA_AUTH_DISABLED` | `false` | Skip Bearer validation -- local dev only, never in production |
| `ENTRA_OAUTH_SCOPES` | `api://<ENTRA_CLIENT_ID>/access_as_user openid profile offline_access` | Scopes advertised in OIDC discovery |
| `ENTRA_TRUSTED_TENANT_IDS` | _(empty)_ | Accepted remote tenant IDs (multi-tenant scenarios) |
| `ENTRA_ALLOW_ANY_TENANT` | `false` | Accept any Microsoft tenant token |
| `ENTRA_DCR_REGISTRATION_TOKEN` | _(unset)_ | Bearer token required on `POST /oauth/register` |
| `ENTRA_DCR_ALLOW_UNAUTHENTICATED` | `false` | Allow open Dynamic Client Registration when no token is configured |
| `ENTRA_ALLOWED_AUDIENCES` | _(empty)_ | Comma-separated extra `aud` values to accept (custom App ID URIs) |
| `CORS_ALLOWED_ORIGINS` | _(empty)_ | Comma-separated browser origins for CORS-enabled endpoints |
| `SERVICENOW_OAUTH_TOKEN_PATH` | `/oauth_token.do` | ServiceNow token endpoint path |
| `SERVICENOW_OAUTH_GRANT_TYPE` | `auto` | Override grant type: `password` or `client_credentials` |
| `SERVICENOW_OAUTH_CLIENT_AUTH_STYLE` | `auto` | OAuth client auth style: `request_body` or `basic` |
| `SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN` | `false` | When `true`, refuse calls without `x-servicenow-access-token` (per-user ACL enforcement) |
| `SERVICENOW_REQUESTED_FOR_LOOKUP_FIELDS` | `email,user_name` | `sys_user` fields for identity resolution |
| `SERVICENOW_REQUESTED_FOR_CALLER_FIELDS` | `callerUpn` | Entra token claims to use as identity source |
| `SERVICENOW_REQUESTED_FOR_FALLBACK_TO_CALLER_VALUE` | `true` | Fall back to UPN if no `sys_user` match |
| `SERVICENOW_REQUESTED_FOR_DIAGNOSTICS` | `false` | Include requested_for diagnostics in tool/API responses |
| `SERVICENOW_REQUESTED_FOR_DIAGNOSTICS_INCLUDE_PII` | `false` | Include raw caller identifiers in diagnostics (for short-lived troubleshooting only) |
| `LOG_LEVEL` | `info` | Minimum log level emitted to stdout: `debug`, `info`, `warn`, or `error` |
| `LOG_INCLUDE_CALLER_IDENTITY` | `false` | Attach caller `oid`/`upn` to every log entry. Off by default to keep PII out of App Insights |
| `LOG_INCLUDE_ERROR_STACK` | `false` | Include error stack traces in error log entries |

---

## Local Testing Against ServiceNow

Two ways to verify ServiceNow responses without going through Copilot Studio:

### Option A — Run the full MCP server locally and call it via JSON-RPC

```powershell
# 1. Copy the sample settings file and fill in your ServiceNow credentials.
Copy-Item local.settings.sample.json local.settings.json
#    Set SERVICENOW_INSTANCE_URL / SERVICENOW_CLIENT_ID / SERVICENOW_CLIENT_SECRET
#    (and SERVICENOW_USERNAME / SERVICENOW_PASSWORD for the password grant).
#    ENTRA_AUTH_DISABLED=true is the default in the sample so no Bearer token is needed.

# 2. Start the function locally on http://localhost:7071/mcp
npm run start:dev

# 3. In a second terminal, run the MCP smoke test against localhost.
$env:MCP_ENDPOINT_URL = "http://localhost:7071/mcp"
$env:SEARCH_QUERY = "laptop"
npm run smoke:test
```

This exercises the full request pipeline (Express, MCP SDK, Streamable HTTP transport, `ServiceNowClient`).

### Option B — Direct ServiceNow probe (no MCP, no Functions runtime)

For faster iteration when you only care about ServiceNow responses, the
`scripts/dev/test-servicenow-local.mjs` runner loads `local.settings.json`
and calls the `ServiceNowClient` methods directly:

```powershell
npm run sn:local -- validate
npm run sn:local -- search "vpn access" 5
npm run sn:local -- form 04b7e94b4f7b4200086eeed18110c7fd
npm run sn:local -- orders --upn=alice@contoso.com
npm run sn:local -- order <itemSysId> '{"justification":"test"}' --confirm --upn=alice@contoso.com
```

Useful flags:
- `--upn=<user@domain>` simulates the caller identity that the Express middleware would inject from a real Entra token. Required for `orders` and for testing `requested_for` resolution on `order`.
- `--confirm` is mandatory on `order` because it creates a real ServiceNow request.
- Existing `process.env` values win over `local.settings.json`, so you can override individual settings on the command line.

Output is raw JSON — pipe through `ConvertFrom-Json` or `jq` to inspect specific fields.

---

## Smoke Testing Deployed Endpoint

Quick liveness check (no token required):

```bash
curl https://<function-app>.azurewebsites.net/health
# → {"status":"ok","server":"servicenow-mcp"}
```

Full MCP smoke test (Entra Bearer required):

```bash
set MCP_ENDPOINT_URL=https://<function-app>.azurewebsites.net/mcp
set ENTRA_BEARER_TOKEN=<access-token>
npm run smoke:test
```

Get a token:

```bash
az account get-access-token --resource api://<ENTRA_CLIENT_ID> --query accessToken -o tsv
```

---

## Troubleshooting

**401 on MCP endpoint** -- Entra auth is active and no valid Bearer token was sent. Check the Copilot Studio connection (user must have signed in). For local testing, set `ENTRA_AUTH_DISABLED=true`.

**Orders created but `requested_for` is wrong** -- The post-order PATCH failed. Verify:
- Integration user has **write** on `sc_request` in ServiceNow.
- Caller's Entra email matches `sys_user.email` or `sys_user.user_name`.
- Application Insights traces for `[ServiceNowClient.placeOrder.requestedForPatchFailed]`.

**Dynamic discovery fails in Copilot Studio** -- Verify `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID` are set. Confirm the OIDC endpoint returns 200. If you changed OAuth settings after the MCP tool was added, **delete and re-add the connection** -- Power Platform caches OIDC metadata on first connect.

**validate_servicenow_config errors** -- Run with `probeOrderNow: false` first to isolate auth vs. catalog access issues.

---

## Security

All secrets are stored in Azure Key Vault. The Function App reads them via managed identity. No credentials appear in app settings in plaintext.

- `local.settings.json` is excluded by `.gitignore` -- never commit it.
- Never deploy with `ENTRA_AUTH_DISABLED=true`.
- Keep `/oauth/register` protected with `ENTRA_DCR_REGISTRATION_TOKEN` (recommended).
- Keep `ENTRA_DCR_ALLOW_UNAUTHENTICATED=false` in enterprise environments.
- Keep `SERVICENOW_REQUESTED_FOR_DIAGNOSTICS_INCLUDE_PII=false` unless you are actively debugging and have an approved retention path.
- Prefer `SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN=true` when enterprise policy requires per-user ServiceNow ACL enforcement.

See [SECURITY.md](SECURITY.md) for full guidelines.

---

## Engineering Guardrails

Apply these rules for every new feature, bug fix, refactor, or deployment-related change in this repository.

### Local Development Files

- Treat `local.settings.json` as developer-local configuration.
- Do not sanitize, template, overwrite, or reformat `local.settings.json` unless the user explicitly asks for that file to be changed.
- Apply security improvements in committed source files, scripts, infrastructure, and docs instead of rewriting local developer secrets files.

### Logging And Diagnostics

- Route new operational logs through the structured logger in `src/utils/logger.ts`.
- Never log secrets, bearer tokens, passwords, client secrets, function keys, cookies, or raw authorization headers.
- Do not log caller PII by default. Any diagnostics that may expose user identity must be opt-in and disabled by default.
- Keep error output sanitized. Avoid returning or logging full upstream payloads when they may contain tokens, identifiers, or request content.

### Identity And Access

- Prefer least privilege for both ServiceNow and Entra configuration.
- Avoid broad ServiceNow roles when narrower ACLs or scoped access can satisfy the requirement.
- Prefer delegated/per-user enforcement when enterprise requirements demand user-level authorization boundaries.
- Do not add Microsoft Graph or unrelated Entra permissions unless they are strictly required by the implemented feature.

### API And OAuth Surface

- Use explicit CORS allowlists for browser-facing endpoints. Avoid wildcard origins for enterprise-exposed APIs.
- Keep Dynamic Client Registration secure by default. Require a registration token unless open registration is an intentional, reviewed choice.
- Preserve MCP protocol compatibility when changing transport, discovery, or tool metadata behavior.

### Documentation Expectations

- Update repo documentation whenever behavior, configuration, permissions, or security posture changes.
- Add concise function-level comments when behavior is non-obvious, especially in auth, logging, transport, or security-sensitive code paths.
- Document new environment variables, defaults, and security implications in the repo.

### Review Standard

Before considering a change complete, verify:

- No secrets or PII were added to logs, responses, docs, or tracked files.
- `local.settings.json` was left untouched unless explicitly requested.
- New permissions are justified and minimized.
- User-facing and operator-facing documentation matches the implementation.

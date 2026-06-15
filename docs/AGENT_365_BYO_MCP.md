# Agent 365 BYO MCP Server Setup

This guide describes how to register the **ServiceNow MCP Server** (this repo) with
**Microsoft Agent 365** as a Bring-Your-Own (BYO) MCP server, so that it appears
in the **Microsoft 365 admin center > Agents > Tools** registry and can be
governed centrally for Copilot Studio, VS Code, Claude Code, and GitHub Copilot CLI.

> Microsoft reference:
> [Manage tools for agents — Bring your own (BYO) MCP server](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/manage-tools-for-agent?view=o365-worldwide#bring-your-own-byo-mcp-server)
>
> **Preview limitation (per Microsoft):** Republishing new versions of an
> already-registered remote MCP server isn't currently supported. Pick a stable
> tool list before submitting.

---

## Why BYO MCP for this server

This MCP server is designed to be a remote, tenant-governed integration:

- It exposes a single Streamable-HTTP MCP endpoint at `https://<host>/mcp`.
- It already requires a **Microsoft Entra ID** Bearer token on every `POST /mcp`
  call (see [`src/utils/entraAuthMiddleware.ts`](../src/utils/entraAuthMiddleware.ts)
  and [`src/services/entraTokenValidator.ts`](../src/services/entraTokenValidator.ts)).
- It accepts `aud=<ENTRA_CLIENT_ID>` and `aud=api://<ENTRA_CLIENT_ID>` (and any
  values in `ENTRA_ALLOWED_AUDIENCES`) so the standard `.default` scope works
  out of the box.

That maps cleanly to the `EntraOAuth` BYO MCP authentication type — no code
changes are required.

---

## Architecture

```
+--------------------------+        +-----------------------------+        +-----------------+
| Copilot Studio / VS Code |        | Agent 365 Tooling Gateway   |        | This MCP Server |
| Claude Code / GH CLI     | ─────▶ | (governance + telemetry)    | ─────▶ | /mcp on Azure   |
| (caller signed in)       |  user  | acquires Entra token        |  Bearer| Functions       |
|                          | token  | for api://<MCP_APP>/.default| token  | + ServiceNow    |
+--------------------------+        +-----------------------------+        +-----------------+
                                              │
                                              ▼
                                  Microsoft 365 admin center
                                  (Agents > Tools > Registry)
                                  approves / blocks / monitors
```

The Agent 365 Tooling Gateway sits between every supported client and this MCP
server. Tenant admins approve or block the server in one place; Defender XDR
captures every tool invocation.

---

## Prerequisites

### Tenant (one-time)

| Requirement | How to verify |
|---|---|
| Agent 365 service principal provisioned (`appId = ea9ffc3e-8a23-4a7d-836d-234d7c7565c1`) | `az ad sp show --id ea9ffc3e-8a23-4a7d-836d-234d7c7565c1` should return a service principal. If not, see [Set up service principal](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/tooling#set-up-service-principal). |
| Tenant admin (Global admin or AI admin) available to approve the request | Required to grant Entra consent in step 5 below. |

### Developer machine

| Requirement | Notes |
|---|---|
| **.NET SDK 8.0+** | Prereq for the Agent 365 CLI. Verify with `dotnet --list-sdks`. |
| **Agent 365 CLI `>= 1.1.165-preview`** | Install as a .NET global tool: `dotnet tool install --global Microsoft.Agents.A365.DevTools.Cli` (upgrade later with `dotnet tool update --global Microsoft.Agents.A365.DevTools.Cli`). Verify with `a365 --version`. Reference: [Agent 365 CLI](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/agent-365-cli#install-the-agent-365-cli). |
| Azure CLI signed into the tenant where Agent 365 runs | `az login` |
| PowerShell 7+ (only for the helper script) | `pwsh --version` |

### MCP server (this repo)

The server must already be **deployed and reachable from the public internet**
(see the main [`README.md`](../README.md) for `azd up` / container deployment).
You will need:

| Value | Where to find it |
|---|---|
| `MCP_ENDPOINT_URL` | Output of `azd env get-values` (e.g. `https://<funcapp>.azurewebsites.net/mcp`) |
| `ENTRA_CLIENT_ID` | App registration used by the server (same value the server reads at runtime) |
| `ENTRA_TENANT_ID` | Directory the app registration lives in |

> Verify the endpoint from outside Azure:
> `curl -i https://<funcapp>.azurewebsites.net/health` should return `200 OK`.

---

## Step 1 — Confirm the server is configured for `EntraOAuth`

The Agent 365 Tooling Gateway authenticates to this server using a delegated
Entra token issued for **`api://<ENTRA_CLIENT_ID>/.default`**. Tokens with that
scope have `aud = api://<ENTRA_CLIENT_ID>`.

The server already accepts that audience because
[`buildAcceptedAudiences`](../src/services/entraTokenValidator.ts) auto-includes
both `<ENTRA_CLIENT_ID>` and `api://<ENTRA_CLIENT_ID>`. Nothing else to change
in code.

If your deployment uses a custom App ID URI (e.g. `api://snow-mcp.contoso.com`),
add it to `ENTRA_ALLOWED_AUDIENCES` so the matching `aud` claim is accepted.

### Cross-tenant note

Agent 365 tokens reaching the server carry the **end user's** tenant in the
`tid` claim — that is the tenant where the user signed in to Copilot Studio or
VS Code, not necessarily where the server is hosted.

- **Single tenant** (server and users in the same tenant): no extra config.
- **Multi-tenant** (users from other tenants): set
  `ENTRA_TRUSTED_TENANT_IDS=<comma-separated-tenant-guids>` or, for any
  Microsoft tenant, `ENTRA_ALLOW_ANY_TENANT=true`. Make the Entra app
  multi-tenant (`signInAudience: AzureADMultipleOrgs`).

---

## Step 2 — Disable open Dynamic Client Registration (recommended)

DCR is only useful for the existing Copilot Studio "Dynamic discovery" flow.
Once Agent 365 is the broker, you should harden `POST /oauth/register`:

```powershell
azd env set ENTRA_DCR_ALLOW_UNAUTHENTICATED false
azd env set ENTRA_DCR_REGISTRATION_TOKEN ""   # or a long random string
azd up
```

This forces clients to go through the Agent 365 Tooling Gateway rather than
requesting their own client credentials.

---

## Step 3 — Prepare the registration payload

A starter payload is included at
[`scripts/agent365-mcp-registration.template.json`](../scripts/agent365-mcp-registration.template.json).
It declares the six tools this server exposes and uses `EntraOAuth` with the
`api://<ENTRA_CLIENT_ID>/.default` scope.

> ❗ **Server name constraints** (Agent 365 CLI rules):
>
> - MUST start with the `ext_` prefix (identifies it as an externally hosted
>   MCP server in agent manifests)
> - MUST be at most **20 characters** total
> - Default in the template is `ext_ServiceNowMCP` (17 chars) — keep or change
>   it, but stay within the constraints.
>
> ❗ **Description constraint:** the `description` field MUST be at most
> **80 characters**. Longer values are rejected with `Short description
> exceeds the maximum length of 80 characters`. The helper script enforces
> this client-side; the template ships with a 78-char value.
>
> ❗ **Tool name constraint:** each `tools[].name` MUST be at most
> **30 characters**. Longer names are rejected with `Tool name '...' exceeds
> the maximum length of 30 characters`. The helper script validates this
> client-side. Tool names also MUST exactly match the names exposed by the
> MCP server itself (see `src/tools/index.ts`).

Copy the template and fill in your values:

```powershell
Copy-Item scripts/agent365-mcp-registration.template.json scripts/agent365-mcp-registration.json
notepad scripts/agent365-mcp-registration.json
```

Replace:

- `serverUrl` → your real endpoint (e.g. `https://func-xyz.azurewebsites.net/mcp`).
- `remoteScopes` → `api://<your-entra-client-id>/.default`.
- `publisherName` → your organization's display name.
- `tenantId` → your Entra tenant ID (or delete the line to use the current
  `az login` tenant).

The JSON keys mirror the CLI option names in **camelCase**:
`serverName`, `serverUrl`, `authType`, `description`, `publisherName`,
`remoteScopes`, `tenantId`, `tools[]` (each `{name, description}`).

> ⚠️ **Do not commit** `scripts/agent365-mcp-registration.json` — only the
> `*.template.json` should live in source control (the gitignore already
> excludes the resolved file).

---

## Step 4 — Register with the Agent 365 CLI

> 💡 **Tip:** Add `--dry-run` to any of the CLI invocations below to validate
> the payload without creating Entra app registrations or calling the
> Agent 365 backend.

### Option A — Use the helper script (recommended)

```powershell
pwsh -File scripts/register-agent365-mcp.ps1 `
  -ServerName "ext_ServiceNowMCP" `
  -PublisherName "Contoso IT" `
  -McpEndpointUrl "https://<funcapp>.azurewebsites.net/mcp" `
  -EntraClientId "<ENTRA_CLIENT_ID>" `
  -TenantId "<ENTRA_TENANT_ID>"
```

The script:

1. Verifies the Agent 365 CLI version (>= 1.1.165-preview).
2. Validates `-ServerName` (must start with `ext_`, max 20 chars).
3. Confirms the Agent 365 service principal exists in your tenant.
4. Renders `scripts/agent365-mcp-registration.json` from the template with your
   values (drops `tenantId` if you omit `-TenantId` so the CLI falls back to
   the current `az login` tenant).
5. Calls `a365 develop-mcp register-external-mcp-server -f <file>`.

### Option B — Run the CLI directly with flags

```powershell
a365 develop-mcp register-external-mcp-server `
  --server-name "ext_ServiceNowMCP" `
  --server-url "https://<funcapp>.azurewebsites.net/mcp" `
  --publisher "Contoso IT" `
  --description "ServiceNow Service Catalog: search items, fill forms, place and manage orders." `
  --auth-type EntraOAuth `
  --remote-scopes "api://<ENTRA_CLIENT_ID>/.default" `
  --tools "search_catalog_items,get_catalog_item_form,place_order,list_user_orders,update_order,validate_servicenow_config" `
  --tenant-id "<ENTRA_TENANT_ID>"
```

> ℹ️ When using `--tools` (a comma-separated list of names) the CLI will
> **prompt you interactively** for each tool's description. Use Option C
> to avoid the prompts.

### Option C — Pass the JSON file (recommended for automation)

```powershell
a365 develop-mcp register-external-mcp-server -f scripts/agent365-mcp-registration.json
```

This is the only fully non-interactive path: per-tool descriptions come from
the `tools[].description` entries in the JSON file.

A successful registration prints a request ID and queues the server for admin
review.

---

## Step 5 — Admin review and consent

A tenant admin (Global admin or AI admin) must:

1. Sign in to the [Microsoft 365 admin center](https://admin.cloud.microsoft/).
2. Open **Agents > Tools > Requests**.
3. Locate the **ext_ServiceNowMCP** entry, review the declared tools, and
   click **Approve**.
4. Grant tenant-wide Microsoft Entra consent for the permissions Agent 365
   requests on behalf of the server (this lets the Tooling Gateway acquire
   tokens with `api://<ENTRA_CLIENT_ID>/.default`).
5. Wait up to 30 minutes for the server to propagate to Copilot Studio and
   other surfaces.

The status in **Agents > Tools > Registry** flips to **Available** when the
server is ready to invoke.

---

## Step 6 — Use the approved server

### Copilot Studio

1. Open your environment in [Copilot Studio](https://copilotstudio.microsoft.com/).
2. Open or create a custom agent.
3. **Tools > Add a tool > MCP Server > Pick from registry**, choose
   **ServiceNow MCP Server**.
4. Test with a prompt such as `Order a new laptop` — the MCP server should
   respond with an Adaptive Card item picker.

The legacy "Add MCP from URL" flow described in
[`COPILOT_STUDIO_SETUP.md`](../COPILOT_STUDIO_SETUP.md) is still supported but
no longer required once BYO MCP is in place.

### VS Code, Claude Code, GitHub Copilot CLI

Follow [Set up Work IQ MCP Servers for coding agents](https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview#extend-your-agents-with-available-or-custom-mcp-servers).
Each surface picks the approved server from the same tenant registry.

---

## Step 7 — Monitor in Microsoft Defender XDR

Every tool invocation routed through the Tooling Gateway is logged. Use the
following KQL in **Microsoft Defender > Advanced hunting**:

```kusto
CloudAppEvents
| where ActionType == "ExecuteToolByGateway"
| where RawEventData contains "ServiceNow MCP Server"
| project Timestamp, AccountUpn, ApplicationId, RawEventData
| order by Timestamp desc
```

Filter further on tool names (`search_catalog_items`, `place_order`, …) for
per-tool dashboards.

---

## Tools exposed (must match registration)

These are the canonical names from
[`src/tools/index.ts`](../src/tools/index.ts) — keep them in sync with whatever
you submit to Agent 365.

| Tool | Description (used in registration) |
|---|---|
| `search_catalog_items` | Search ServiceNow catalog items using a natural-language query. |
| `get_catalog_item_form` | Get the order form for a selected ServiceNow catalog item. |
| `place_order` | Place a ServiceNow catalog order with the collected form values. |
| `list_user_orders` | Retrieve all current (non-closed) orders for the authenticated user. |
| `update_order` | Update a small allowlist of fields on the caller's catalog order. |
| `validate_servicenow_config` | Validate ServiceNow authentication and catalog access end-to-end. |

If you add or remove a tool in code, you must re-register the server. Per the
preview limitation, Microsoft does not yet support republishing — coordinate
with your tenant admin to delete and re-create the registry entry.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `a365 develop-mcp register-external-mcp-server` fails with `service principal not found` | Agent 365 SP missing in tenant | Run [Set up service principal](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/tooling#set-up-service-principal). |
| Admin sees the request but approval fails | Caller lacks AI admin / Global admin role | Assign the role or hand off the approval. |
| Server is **Available** but Copilot Studio can't see it | < 30 min since approval | Wait, then refresh the agent's tool picker. |
| First invocation returns `401 invalid_token` | Audience mismatch | Confirm the Entra app's App ID URI is `api://<ENTRA_CLIENT_ID>` (default) or add the custom URI to `ENTRA_ALLOWED_AUDIENCES`. |
| `401 invalid_token` only from users in another tenant | Cross-tenant not allowed | Set `ENTRA_TRUSTED_TENANT_IDS` (preferred) or `ENTRA_ALLOW_ANY_TENANT=true`. |
| Tools list works but every call returns ServiceNow `401` | ServiceNow integration user missing `catalog`/`itil` roles | See [`docs/SERVICENOW_SETUP.md`](SERVICENOW_SETUP.md). |
| Defender XDR shows no events | Server not invoked through the Tooling Gateway (still hitting the legacy direct path) | Re-test from a Copilot Studio agent that picked the tool from the registry, not from a manual MCP URL. |

---

## Related docs

- [`README.md`](../README.md) — base deployment, Entra app, env vars
- [`COPILOT_STUDIO_SETUP.md`](../COPILOT_STUDIO_SETUP.md) — legacy direct-MCP path (still works)
- [`docs/SERVICENOW_SETUP.md`](SERVICENOW_SETUP.md) — ServiceNow OAuth + integration user
- [`docs/MCS_ACTION_CONTRACTS.md`](MCS_ACTION_CONTRACTS.md) — tool input/output schemas
- [`SECURITY.md`](../SECURITY.md) — secrets and what never to commit

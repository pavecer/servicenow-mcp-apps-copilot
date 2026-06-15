---
description: Deploy the ServiceNow MCP Server to Azure. Handles login, environment setup, infrastructure provisioning, function deployment, and smoke test validation.
tools: ["changes", "edit", "extensions", "fetch", "runCommands", "runTasks", "search", "problems", "azure-mcp/deploy", "azure-mcp/monitor", "azure-mcp/quota", "azure-mcp/get_bestpractices", "azure-mcp/documentation", "ms-azuretools.vscode-azure-github-copilot/azure_query_azure_resource_graph", "ms-azuretools.vscode-azure-github-copilot/azure_get_auth_context", "ms-azuretools.vscode-azure-github-copilot/azure_set_auth_context"]
model: Claude Sonnet 4
---

# ServiceNow MCP Server — Deploy to Azure

This agent deploys the ServiceNow MCP Server to Azure Functions using `azd`. It handles login, environment configuration, provisioning, deployment, and validation.

## Prerequisites Check

Before starting, verify these are installed:
- `az` (Azure CLI)
- `azd` (Azure Developer CLI)
- `node` v20+
- `pwsh` (PowerShell 7+)

Run: `az --version && azd version && node --version`

---

## Workflow

### Phase 1 — Authenticate

```bash
az login
azd auth login
```

Verify the correct subscription is active:
```bash
az account show --query "{name:name, id:id, tenant:tenantId}"
```

If needed, switch subscription:
```bash
az account set --subscription <subscription-id>
```

---

### Phase 2 — Configure Environment

Create a new azd environment or select existing:

```bash
# New environment
azd env new <environment-name>

# Or select existing
azd env select <environment-name>
```

Set all required environment variables. Ask the user for these values if not already known:

**ServiceNow settings** (from `scripts/setup-servicenow.ps1` output or manual setup):
```bash
azd env set SERVICENOW_INSTANCE_URL  "https://<instance>.service-now.com"
azd env set SERVICENOW_CLIENT_ID     "<servicenow-client-id>"
azd env set SERVICENOW_CLIENT_SECRET "<servicenow-client-secret>"
azd env set SERVICENOW_USERNAME      "<integration-user>"
azd env set SERVICENOW_PASSWORD      "<integration-user-password>"
```

**Entra ID settings** (from Azure Portal app registration):
```bash
azd env set ENTRA_TENANT_ID          "<entra-tenant-id>"
azd env set ENTRA_CLIENT_ID          "<entra-client-id>"
azd env set ENTRA_CLIENT_SECRET      "<entra-client-secret>"
```

Confirm values:
```bash
azd env get-values
```

---

### Phase 3 — Build

```bash
npm install
npm run build
```

Verify the build succeeded — `dist/` directory must exist.

---

### Phase 4 — Provision and Deploy

```bash
azd up
```

This command:
1. Provisions Azure resources (Function App, Key Vault, Application Insights, Storage)
2. Stores secrets in Key Vault
3. Deploys the built function code
4. Outputs the MCP endpoint URL

If infrastructure already exists and you only want to redeploy code:
```bash
azd deploy
```

---

### Phase 5 — Get Endpoint and Validate

Get the MCP endpoint URL:
```bash
azd env get-values | findstr MCP_ENDPOINT_URL
```

Validate OIDC discovery (must return 200):
```bash
$host = (azd env get-value FUNCTION_APP_HOSTNAME)
Invoke-RestMethod "https://$host/.well-known/openid-configuration" | ConvertTo-Json
```

Run the smoke test:
```bash
$mcpUrl = azd env get-value MCP_ENDPOINT_URL
$token = az account get-access-token --resource "api://$(azd env get-value ENTRA_CLIENT_ID)" --query accessToken -o tsv

$env:MCP_ENDPOINT_URL = $mcpUrl
$env:ENTRA_BEARER_TOKEN = $token
npm run smoke:test
```

---

### Phase 6 — Output Copilot Studio Setup

After successful deployment, print the Copilot Studio configuration:

```
Server name:     ServiceNow MCP
Server URL:      https://<function-app>.azurewebsites.net/mcp
Authentication:  OAuth 2.0
Type:            Dynamic discovery
```

Direct the user to [COPILOT_STUDIO_SETUP.md](../COPILOT_STUDIO_SETUP.md) for the complete Copilot Studio setup guide.

---

## Troubleshooting Deployment Issues

**`azd up` fails on provisioning**
- Check Azure quota: `az vm list-usage --location <location>`
- Verify subscription permissions: `az role assignment list --assignee $(az account show --query user.name -o tsv)`

**Function fails to start after deploy**
- Check Application Insights: `az monitor app-insights events show --app <app-insights-name> --resource-group <rg>`
- Verify Key Vault access: `az keyvault secret list --vault-name <kv-name>`
- Confirm environment variables: `az functionapp config appsettings list --name <func-name> --resource-group <rg>`

**`azd deploy` fails**
- Ensure build succeeded: check `dist/` exists
- Try `npm run build` explicitly then re-run `azd deploy`

**Smoke test 401 errors**
- Confirm `ENTRA_AUTH_DISABLED` is NOT set to `true` in production
- Verify the Entra Bearer token was obtained for the correct resource (`api://<ENTRA_CLIENT_ID>`)

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `SERVICENOW_INSTANCE_URL` | ✅ | ServiceNow base URL |
| `SERVICENOW_CLIENT_ID` | ✅ | OAuth App Registry client ID |
| `SERVICENOW_CLIENT_SECRET` | ✅ | OAuth App Registry client secret |
| `SERVICENOW_USERNAME` | ✅ | Integration user login |
| `SERVICENOW_PASSWORD` | ✅ | Integration user password |
| `ENTRA_TENANT_ID` | ✅ | Entra directory tenant ID |
| `ENTRA_CLIENT_ID` | ✅ | Entra app registration client ID |
| `ENTRA_CLIENT_SECRET` | ✅ | Entra client secret (for DCR) |
| `ENTRA_AUDIENCE` | ⚪ | Token audience; defaults to `api://<ENTRA_CLIENT_ID>` |
| `ENTRA_TRUSTED_TENANT_IDS` | ⚪ | Comma-separated trusted tenant IDs for multi-tenant |

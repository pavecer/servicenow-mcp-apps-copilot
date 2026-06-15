# Optional Deployment: Single Container on Azure Container Apps

This document describes an optional deployment path that runs the MCP server in one container.

This does not replace the existing Azure Functions deployment from `README.md`; it is an additional option.

## Overview

- Build image from the repository `Dockerfile`
- Push image to Azure Container Registry (ACR)
- Run image in Azure Container Apps with external ingress
- Expose MCP endpoint at `https://<container-app-fqdn>/mcp`

## Prerequisites

- Azure subscription with rights to create resource groups and managed identities
- Azure CLI installed and logged in (`az login`)
- Docker installed locally
- ServiceNow + Entra values ready (same values as Functions deployment)

## Required Runtime Variables

Set these in Container Apps:

- `SERVICENOW_INSTANCE_URL`
- `SERVICENOW_CLIENT_ID`
- `SERVICENOW_CLIENT_SECRET`
- `SERVICENOW_USERNAME`
- `SERVICENOW_PASSWORD`
- `ENTRA_TENANT_ID`
- `ENTRA_CLIENT_ID`
- `ENTRA_CLIENT_SECRET`

Optional variables are the same as in `README.md` (for example `ENTRA_AUDIENCE`, `ENTRA_TRUSTED_TENANT_IDS`, `ENTRA_ALLOW_ANY_TENANT`).

### Enabling MCP Apps (Microsoft 365 Copilot widgets)

The container image is built the same way as the Functions package: `npm run
build` runs the `build:widgets` prebuild step, so the SEP-1865
`ui://servicenow-mcp/*.html` widgets are baked into the image and served from the
same `/mcp` endpoint. **MCP Apps works in the container exactly as it does on
Azure Functions** — it is off until you opt in. To enable it, set:

- `MCP_APPS_ENABLED=true` — registers the widget resources and decorates the
  widget-backed tools with `_meta.ui.resourceUri`.
- `CORS_ALLOWED_ORIGINS` — comma-separated widget-host origins so the sandboxed
  iframe can reach the server (use <https://aka.ms/mcpwidgeturlgenerator> to
  generate the M365 Copilot / Cowork origins for your tenant).
- `MCP_APPS_PUBLIC_ORIGIN` *(optional)* — the public origin where the Container
  App is reachable (documentation only; not consumed at runtime).

When `MCP_APPS_ENABLED` is unset/`false` the container serves the legacy
Adaptive Card surface, byte-identical to the Functions deployment.

## 1) Create Azure Resources

PowerShell example:

```powershell
$LOCATION = "westeurope"
$SUFFIX = "snmcp01"
$RG = "rg-mcp-$SUFFIX"
$ACR = "acrmcp$SUFFIX"
$ENV = "cae-mcp-$SUFFIX"
$APP = "ca-mcp-$SUFFIX"

az group create --name $RG --location $LOCATION

az acr create `
  --resource-group $RG `
  --name $ACR `
  --sku Basic `
  --admin-enabled false

az containerapp env create `
  --name $ENV `
  --resource-group $RG `
  --location $LOCATION
```

## 2) Build and Push the Image

```powershell
$IMAGE = "$ACR.azurecr.io/mcp-server-servicenow:1.0.0"

az acr login --name $ACR
docker build -t $IMAGE .
docker push $IMAGE
```

## 3) Create the Container App

Use secrets for credentials and pass non-secret settings as env vars.

```powershell
az containerapp create `
  --name $APP `
  --resource-group $RG `
  --environment $ENV `
  --image $IMAGE `
  --target-port 8080 `
  --ingress external `
  --min-replicas 1 `
  --max-replicas 5 `
  --registry-server "$ACR.azurecr.io" `
  --system-assigned `
  --secrets `
    servicenow-client-secret="<SERVICENOW_CLIENT_SECRET>" `
    servicenow-password="<SERVICENOW_PASSWORD>" `
    entra-client-secret="<ENTRA_CLIENT_SECRET>" `
  --env-vars `
    SERVICENOW_INSTANCE_URL="<SERVICENOW_INSTANCE_URL>" `
    SERVICENOW_CLIENT_ID="<SERVICENOW_CLIENT_ID>" `
    SERVICENOW_CLIENT_SECRET=secretref:servicenow-client-secret `
    SERVICENOW_USERNAME="<SERVICENOW_USERNAME>" `
    SERVICENOW_PASSWORD=secretref:servicenow-password `
    ENTRA_TENANT_ID="<ENTRA_TENANT_ID>" `
    ENTRA_CLIENT_ID="<ENTRA_CLIENT_ID>" `
    ENTRA_CLIENT_SECRET=secretref:entra-client-secret
```

Grant the Container App identity pull rights on ACR:

```powershell
$PRINCIPAL_ID = az containerapp show -g $RG -n $APP --query identity.principalId -o tsv
$ACR_ID = az acr show -g $RG -n $ACR --query id -o tsv

az role assignment create `
  --assignee-object-id $PRINCIPAL_ID `
  --assignee-principal-type ServicePrincipal `
  --role AcrPull `
  --scope $ACR_ID
```

After assigning `AcrPull`, restart the app once:

```powershell
az containerapp revision restart --name $APP --resource-group $RG
```

## 4) Validate Endpoints

Get FQDN:

```powershell
$FQDN = az containerapp show -g $RG -n $APP --query properties.configuration.ingress.fqdn -o tsv
"https://$FQDN/health"
"https://$FQDN/mcp"
```

Test health:

```powershell
curl "https://$FQDN/health"
```

Expected response includes:

```json
{"status":"ok","server":"servicenow-mcp"}
```

## 5) Point a Copilot client to the Container URL

Use:

- MCP URL: `https://<container-app-fqdn>/mcp`
- Authentication: OAuth 2.0 (same Entra app flow as the Functions deployment)

For Microsoft 365 Copilot, sideload the declarative-agent package under
[`m365-agent/`](../m365-agent/README.md) pointed at this MCP URL, and set
`MCP_APPS_ENABLED=true` (see *Enabling MCP Apps* above) to render the widgets
inline.

## Updating the Deployment

For a new version:

1. Build and push a new tag
2. Update Container App image

```powershell
$NEW_IMAGE = "$ACR.azurecr.io/mcp-server-servicenow:1.0.1"

docker build -t $NEW_IMAGE .
docker push $NEW_IMAGE

az containerapp update `
  --name $APP `
  --resource-group $RG `
  --image $NEW_IMAGE
```

## Notes

- Container Apps reads `PORT`; the server listens on `8080` by default.
- Keep `ENTRA_AUTH_DISABLED` unset or `false` in production.
- Use Key Vault or CI/CD secret stores for production-grade secret management.

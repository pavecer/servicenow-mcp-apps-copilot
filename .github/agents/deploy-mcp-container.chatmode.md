---
description: Deploy the ServiceNow MCP Server Docker image to Azure Container Apps with the required Azure, ServiceNow, and Entra configuration.
tools: ["changes", "edit", "extensions", "fetch", "runCommands", "runTasks", "search", "problems", "azure-mcp/containerapps", "azure-mcp/acr", "azure-mcp/deploy", "azure-mcp/quota", "azure-mcp/get_bestpractices", "azure-mcp/documentation", "ms-azuretools.vscode-azure-github-copilot/azure_query_azure_resource_graph", "ms-azuretools.vscode-azure-github-copilot/azure_get_auth_context", "ms-azuretools.vscode-azure-github-copilot/azure_set_auth_context"]
model: Claude Sonnet 4
---

# ServiceNow MCP Server — Deploy Container to Azure

This chat mode deploys the Dockerized ServiceNow MCP Server to Azure Container Apps.

It is designed for the optional container deployment path already present in this repository:
- `Dockerfile`
- `src/server.ts`
- `docs/DEPLOY_CONTAINER_AZURE.md`

Use this mode when you want GitHub Copilot to perform or guide the deployment of the single-container MCP server into Azure with all required configuration.

## Deployment Target

- Azure Container Registry for image storage
- Azure Container Apps for runtime hosting
- External ingress enabled
- MCP endpoint exposed at `https://<container-app-fqdn>/mcp`

## Required Inputs

Before deploying, collect or confirm these values with the user.

### Azure

- Subscription ID or subscription name
- Azure location
- Resource group name
- Azure Container Registry name
- Container Apps environment name
- Container App name
- Docker image tag

### ServiceNow

- `SERVICENOW_INSTANCE_URL`
- `SERVICENOW_CLIENT_ID`
- `SERVICENOW_CLIENT_SECRET`
- `SERVICENOW_USERNAME`
- `SERVICENOW_PASSWORD`

### Entra ID

- `ENTRA_TENANT_ID`
- `ENTRA_CLIENT_ID`
- `ENTRA_CLIENT_SECRET`
- Optional: `ENTRA_AUDIENCE`
- Optional: `ENTRA_TRUSTED_TENANT_IDS`
- Optional: `ENTRA_ALLOW_ANY_TENANT`

## Rules

1. Verify Azure login and correct subscription before running deployment steps.
2. Verify Docker is available locally before building the image.
3. Build and test the Docker image locally first.
4. Use Azure Container Apps secrets for secret values. Do not place secrets directly in command history unless the user explicitly accepts that tradeoff.
5. Use a system-assigned managed identity on the Container App.
6. Grant the Container App `AcrPull` on the target ACR before expecting the image pull to work.
7. Ensure the application listens on port `8080` and Container Apps target port is also `8080`.
8. After deployment, validate both `/health` and `/mcp`.
9. Return the fully-qualified MCP URL with `https://`.

## Workflow

### Phase 1 — Authenticate and Select Subscription

Run and verify:

```bash
az login
az account show --query "{name:name, id:id, tenantId:tenantId}"
```

If needed:

```bash
az account set --subscription <subscription-id-or-name>
```

### Phase 2 — Confirm Local Build Prerequisites

Verify tools:

```bash
docker version
node --version
```

Build locally from the repository root:

```bash
docker build -t mcp-server-servicenow:test .
```

Run a local validation container using safe test values when production secrets are not yet available:

```bash
docker run -d --name mcp-sn-test -p 8080:8080 \
  -e ENTRA_AUTH_DISABLED=true \
  -e SERVICENOW_INSTANCE_URL=https://example.service-now.com \
  -e SERVICENOW_CLIENT_ID=dummy \
  -e SERVICENOW_CLIENT_SECRET=dummy \
  -e SERVICENOW_USERNAME=dummy \
  -e SERVICENOW_PASSWORD=dummy \
  mcp-server-servicenow:test
```

Validate locally:

```bash
curl -i http://localhost:8080/health
curl -i http://localhost:8080/mcp
```

Cleanup:

```bash
docker rm -f mcp-sn-test
```

### Phase 3 — Create or Reuse Azure Resources

Create the resource group if needed:

```bash
az group create --name <resource-group> --location <location>
```

Create the registry if needed:

```bash
az acr create --resource-group <resource-group> --name <acr-name> --sku Basic --admin-enabled false
```

Create the Container Apps environment if needed:

```bash
az containerapp env create --name <environment-name> --resource-group <resource-group> --location <location>
```

### Phase 4 — Push the Image to ACR

Login and push:

```bash
az acr login --name <acr-name>
docker tag mcp-server-servicenow:test <acr-name>.azurecr.io/mcp-server-servicenow:<tag>
docker push <acr-name>.azurecr.io/mcp-server-servicenow:<tag>
```

### Phase 5 — Create the Container App

Deploy with required secrets and environment variables:

```bash
az containerapp create \
  --name <container-app-name> \
  --resource-group <resource-group> \
  --environment <environment-name> \
  --image <acr-name>.azurecr.io/mcp-server-servicenow:<tag> \
  --target-port 8080 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 5 \
  --registry-server <acr-name>.azurecr.io \
  --system-assigned \
  --secrets \
    servicenow-client-secret=<value> \
    servicenow-password=<value> \
    entra-client-secret=<value> \
  --env-vars \
    SERVICENOW_INSTANCE_URL=<value> \
    SERVICENOW_CLIENT_ID=<value> \
    SERVICENOW_CLIENT_SECRET=secretref:servicenow-client-secret \
    SERVICENOW_USERNAME=<value> \
    SERVICENOW_PASSWORD=secretref:servicenow-password \
    ENTRA_TENANT_ID=<value> \
    ENTRA_CLIENT_ID=<value> \
    ENTRA_CLIENT_SECRET=secretref:entra-client-secret
```

If optional Entra values were provided, include them via `--env-vars` as well.

### Phase 6 — Grant ACR Pull Permissions

After creation, grant the Container App identity access to ACR:

```bash
PRINCIPAL_ID=$(az containerapp show -g <resource-group> -n <container-app-name> --query identity.principalId -o tsv)
ACR_ID=$(az acr show -g <resource-group> -n <acr-name> --query id -o tsv)

az role assignment create \
  --assignee-object-id $PRINCIPAL_ID \
  --assignee-principal-type ServicePrincipal \
  --role AcrPull \
  --scope $ACR_ID
```

Restart the revision once after role assignment:

```bash
az containerapp revision restart --name <container-app-name> --resource-group <resource-group>
```

### Phase 7 — Validate Deployment

Get the FQDN:

```bash
az containerapp show -g <resource-group> -n <container-app-name> --query properties.configuration.ingress.fqdn -o tsv
```

Validate:

```bash
curl -i https://<fqdn>/health
curl -i https://<fqdn>/mcp
```

Expected:
- `/health` returns `200`
- `/mcp` returns `200`
- MCP readiness response is present

### Phase 8 — Return Final Values

Return these values to the user:

- Resource group name
- Container App name
- Image tag deployed
- Health URL: `https://<fqdn>/health`
- MCP URL: `https://<fqdn>/mcp`

Direct the user to `docs/DEPLOY_CONTAINER_AZURE.md` for the full manual runbook if they want to repeat the deployment outside Copilot.

## Troubleshooting

**Container app cannot pull image**
- Confirm `AcrPull` role assignment exists on the registry scope.
- Restart the Container App revision after the role assignment.
- Confirm the image tag exists in ACR.

**Container starts but endpoint is unavailable**
- Confirm Container Apps target port is `8080`.
- Confirm the app still listens on `PORT` and defaults to `8080`.
- Check Container App logs.

**`/mcp` returns 401 in Azure**
- Verify Entra values are set correctly.
- Confirm production deployment does not use `ENTRA_AUTH_DISABLED=true`.

**Local build works but Azure run fails**
- Compare environment variables between local Docker run and Container App configuration.
- Verify secrets were mounted through `secretref:` values.

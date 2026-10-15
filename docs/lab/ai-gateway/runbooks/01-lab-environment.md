# Runbook 01: lab environment (Entra, ServiceNow trust, azd)

Executed 2026-10-15. Isolated azd environment `snowmcp-gwlab`, resource group
`rg-snowmcp-gwlab`, Sweden Central. Never reuse the developer environment.

## 1. Tenant guard

```powershell
az account show --query "{tenant:tenantId, sub:id, user:user.name}"
# must be <tenant-id> / <subscription-id>
```

## 2. Entra apps

```powershell
azd env new snowmcp-gwlab --location swedencentral --subscription <subscription-id>
pwsh scripts/lab/ai-gateway/create-lab-entra-apps.ps1 -TenantId <tenant-id>
```

Creates `snowmcp-gwlab-snow-api` (downstream `ServiceNow.Use`),
`snowmcp-gwlab-server` (`access_as_user`, OBO client secret written straight
into the azd env, Azure CLI pre-authorized for the harness) and
`snowmcp-gwlab-harness` (public client). No secret is printed.

## 3. ServiceNow OIDC trust (manual, <servicenow-instance>)

Follow `docs/SERVICENOW_SETUP.md`: OAuth OIDC provider + entity for the
`snowmcp-gwlab-snow-api` client ID, user claim `preferred_username` -> `email`.
Evidence: screenshot (local: `screenshots/11-servicenow-oidc-entity-gwlab.png`).

## 4. Deploy with lab flags

```powershell
azd env set LAB_REQUEST_DIAGNOSTICS true -e snowmcp-gwlab
azd env set REQUIRE_GATEWAY_HEADER false -e snowmcp-gwlab
azd up -e snowmcp-gwlab
```

If OBO fails with a stale client secret, run
`azd provision -e snowmcp-gwlab --no-state` so Key Vault picks up the current value.

## 5. Baseline

```powershell
node scripts/lab/ai-gateway/run-experiments.mjs --scenario list --target direct --label baseline
node scripts/lab/ai-gateway/run-experiments.mjs --scenario call --target direct --tool report_incident `
  --args '{"shortDescription":"[gwlab] direct baseline incident"}' --label baseline-incident
```

Expected: 27 tools; incident with `opened_by` = signed-in user.

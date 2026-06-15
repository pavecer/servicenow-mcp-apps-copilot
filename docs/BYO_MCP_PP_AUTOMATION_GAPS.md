# BYO MCP – Power Platform Connector Automation & OBO Gaps

**Status:** Verified hands-on  
**Environment tested:** Sandbox Power Platform environment (env id redacted)  
**Connector tested:** A custom MCP connector with `identityProvider: aad`  
**Tool versions:** pac CLI v2.7.4, az CLI 2.x  
**Date:** 2026-05-27  
**Author:** CE field

---

## Executive Summary

Copilot Studio's **BYO MCP wizard** generates a Power Platform custom connector that uses a **generic OAuth 2.0 identity provider** (`identityProvider: oauth2`). This type is incompatible with the AAD-native connector type (`identityProvider: aad`) that is required for **On-Behalf-Of (OBO)** token flow. As a result:

1. **All OBO-related fields are silently stripped** on every export/update cycle when the connector stays in `oauth2` mode.
2. **Client secret is never exportable** by design (security boundary) and cannot be set via any CLI or API.
3. **Switching the identity provider to `aad` via pac CLI is technically possible**, but requires awareness of the correct template format and **breaks all existing connections** (users must reconnect).
4. **Three Entra-side steps** (redirect URI, delegated grant, pre-authorized clients) must be performed manually or via Graph API — the wizard provides no guidance or automation.
5. **DLP policy blocks produce no actionable error** in Copilot Studio — the agent simply fails silently.

The net result is that a complete BYO MCP + OBO deployment currently requires ~12 manual steps spread across Entra, Power Platform, and Azure — with no end-to-end automation path.

---

## Capability Matrix: What Is/Isn't Automatable

| Action | Tool | Works? | Notes |
|--------|------|--------|-------|
| Create connector (definition + properties) | `pac connector create` | ✅ Yes | Full automation possible if starting from `aad` template |
| Update connector OpenAPI definition | `pac connector update --api-definition-file` | ✅ Yes | Survives round-trip |
| Set `identityProvider: aad` (OBO-compatible mode) | `pac connector update --api-properties-file` | ✅ Yes | Must use OAuthAAD template shape (see below) |
| Set `IsOnbehalfofLoginSupported: true` | `pac connector update --api-properties-file` | ✅ Yes | Survives round-trip when `identityProvider: aad` |
| Set `AzureActiveDirectoryResourceId` | `pac connector update --api-properties-file` | ✅ Yes | Survives round-trip |
| Set `enableOnbehalfOfLogin: true` | `pac connector update --api-properties-file` | ✅ Yes | Survives round-trip |
| Set `resourceUri` (customParameters) | `pac connector update --api-properties-file` | ✅ Yes | Survives round-trip |
| Set tenant-scoped `tenantId` | `pac connector update --api-properties-file` | ✅ Yes | Survives round-trip |
| Set OAuth scopes (as array) | `pac connector update --api-properties-file` | ✅ Yes | Must be array, not single space-separated string |
| Set redirect URI on connector | `pac connector update --api-properties-file` | ✅ Yes | Survives round-trip |
| **Set client secret** | `pac connector update` | ❌ No | Not supported anywhere in CLI/API |
| **Set client secret** | Power Platform BAPI | ❌ No | No documented endpoint |
| **Set client secret** | Power Automate connector REST API | ❌ No | Write-protected; security by design |
| Download client secret | `pac connector download` | ❌ No | Always omitted |
| List connections (BAPI) | REST `api.powerapps.com/…/connections` | ❌ No | Returns 404 for sandbox envs; user-scoped |
| Create OAuth connection non-interactively | `pac connection create` | ❌ No | Requires interactive browser auth |
| Register redirect URI in Entra | `az ad app update` | ✅ Yes | Graph API `web.redirectUris` |
| Create delegated OAuth grant in Entra | `az ad app permission grant` / Graph API | ✅ Yes | Must target resource SP, not app registration |
| Pre-authorize clients on resource app | `az rest` / Graph API `preAuthorizedApplications` | ✅ Yes | Scriptable but complex |
| Inspect DLP policy blocks | pac CLI / BAPI | ⚠️ Partial | Can list policies; cannot check if connector is blocked from agent side |
| Export connector to solution | pac CLI / Solutions | ✅ Yes | Standard solution management |

---

## Root Cause: Wizard vs AAD-Native Identity Provider

### What the MCP Wizard Creates (`identityProvider: oauth2`)

When a developer uses the Copilot Studio **MCP Add Existing Server** wizard to create a new connector with OAuth, the generated `apiProperties.json` contains:

```json
{
  "properties": {
    "connectionParameters": {
      "token": {
        "type": "oauthSetting",
        "oAuthSettings": {
          "identityProvider": "oauth2",
          "clientId": "<app-id>",
          "scopes": "api://<app-id>/access_as_user api://<app-id>/ServiceNow.Use",
          "customParameters": {
            "authorizationUrl": { "value": "https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize" },
            "tokenUrl": { "value": "https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token" },
            "refreshUrl": { "value": "https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token" }
          },
          "properties": {
            "IsOnbehalfofLoginSupported": false
          }
        }
      }
    }
  }
}
```

Key problems:
- `identityProvider: oauth2` — generic OAuth type; OBO fields are not part of the schema
- `IsOnbehalfofLoginSupported: false` — hardcoded false; platform ignores writes when `oauth2`
- `scopes` is a **single space-separated string** — not an array (array required for `aad` mode)
- No `AzureActiveDirectoryResourceId`, no `enableOnbehalfOfLogin`, no `resourceUri`, no `tenantId` field
- Tenant-specific auth URLs are in `customParameters` rather than the AAD-native `loginUri` + `tenantId` pattern

### What the OAuthAAD Template Produces (`identityProvider: aad`)

Using `pac connector init --connection-template OAuthAAD` generates the correct shape:

```json
{
  "properties": {
    "connectionParameters": {
      "token": {
        "type": "oauthSetting",
        "oAuthSettings": {
          "identityProvider": "aad",
          "clientId": "<app-id>",
          "scopes": ["api://<app-id>/access_as_user", "api://<app-id>/ServiceNow.Use"],
          "redirectMode": "GlobalPerConnector",
          "redirectUrl": "https://global.consent.azure-apim.net/redirect/<connector-suffix>",
          "properties": {
            "IsFirstParty": "False",
            "AzureActiveDirectoryResourceId": "api://<app-id>",
            "IsOnbehalfofLoginSupported": true
          },
          "customParameters": {
            "loginUri": { "value": "https://login.windows.net" },
            "tenantId": { "value": "<tenant-id>" },
            "resourceUri": { "value": "api://<app-id>" },
            "enableOnbehalfOfLogin": { "value": "true" }
          }
        }
      },
      "token:TenantId": {
        "type": "string",
        "metadata": { "sourceType": "AzureActiveDirectoryTenant" },
        "uiDefinition": { "constraints": { "required": "false", "hidden": "true" } }
      }
    }
  }
}
```

**All OBO-relevant fields round-trip correctly** when this shape is uploaded via `pac connector update`.

### The Upgrade Problem

Switching a wizard-created connector from `oauth2` to `aad` by pushing the correct `apiProperties.json` works — but **all existing connections created against the connector are deleted**. Users who had already connected must reconnect. There is no in-place migration path.

---

## Remaining Blockers After Automation

Even with `identityProvider: aad` properly set, the following cannot be automated:

### 1. Client Secret (Critical)

The OAuth client secret **cannot be set, read, or updated** via any of the following:
- `pac connector update` — parameter not accepted
- `pac connector create` — parameter not accepted  
- Power Platform BAPI (`api.powerapps.com`) — no documented write endpoint for connector secrets
- Power Automate connector REST API — write-protected
- Microsoft Graph API — Power Platform connectors not in Graph scope

**Impact:** A human must open the Power Platform connector in the UI (Edit → Security tab → enter/paste client secret → Update connector) on every deployment. This is a **blocking manual step** that prevents CI/CD automation for any OAuth-protected BYO MCP connector.

**Workaround options:**
- Store the secret in a Key Vault and surface it in the deployment runbook as a manual paste step
- Have a designated PP admin perform this step after each new environment deployment

### 2. Connection Creation (Significant)

Creating an OAuth connection for an agent requires interactive browser-based consent:
- `pac connection create` — not available for custom OAuth connectors
- Power Platform BAPI `/connections` — returns 404 for sandbox environments; user-scoped in production
- No service principal / non-interactive path exists

**Impact:** After each connector update, users must manually reconnect. For automated testing pipelines or new-environment provisioning, this is a manual step.

---

## Entra Configuration Gaps

The BYO MCP wizard creates a new **Entra app registration** (the "connector proxy app") per connector. This app needs:

### Gap 1: Redirect URI Registration

The wizard-generated connector callback URL (`https://global.consent.azure-apim.net/redirect/<connector-suffix>`) must be added to the **resource app's** Entra redirect URIs (not just the connector proxy app's). If missing, OAuth consent fails with a redirect_uri mismatch error.

- **Automatable:** Yes, via `az ad app update --set web.redirectUris` or Graph API PATCH `/applications/{id}`
- **Discovery:** The connector suffix is only known after the wizard runs

### Gap 2: Delegated OAuth Grant (Critical)

The wizard creates the connector proxy app but does **not** create the delegated OAuth grant between the connector proxy app and the resource app. Without this grant, the OBO token exchange fails at runtime.

- The grant must be made on the **resource app's service principal**, targeting the **connector proxy app's client SP** (not the Entra app registration object)
- The connector proxy app's appId changes per connector (new connector = new proxy app)
- **Automatable:** Yes, via `az ad app permission grant` or Graph API POST `/oauth2PermissionGrants`
- **Discovery friction:** The proxy app's appId is not surfaced in the wizard UI; must be found via Graph API or portal

### Gap 3: Pre-Authorized Clients

For the OBO flow to work without triggering per-user consent prompts, the connector proxy app must be pre-authorized on the resource app's `preAuthorizedApplications` list.

- **Automatable:** Yes, via Graph API PATCH `/applications/{resourceAppId}` with `preAuthorizedApplications` array
- **Impact if missing:** Each user sees an admin-consent or user-consent prompt on first connection; in enterprise scenarios this typically requires tenant admin involvement

---

## DLP Policy Visibility Gap

Power Platform DLP policies can silently block an MCP connector from being used in an agent:

- When a connector is classified in a "Blocked" data group, agent invocations silently fail
- The Copilot Studio agent surface shows no actionable error message to the user or developer
- `pac connector list` shows the connector exists; no blocked status is surfaced
- There is no API to check "would DLP block this connector for this agent?"

**Impact:** Developers spend hours debugging connectivity issues that are caused by DLP policy classification, with no tooling to surface the root cause.

**Recommendation:** PG should surface DLP policy violations as explicit errors in Copilot Studio's MCP action test pane, similar to the connection error handling that exists for standard connector failures.

---

## Comparison: A365 Native MCP vs BYO MCP (Custom Connector)

| Capability | A365 Native MCP (`shared_a365mcpservers`) | BYO MCP (Custom Connector) |
|------------|-------------------------------------------|----------------------------|
| OBO support | ✅ Built-in, no config | ⚠️ Requires `identityProvider: aad` + manual secret |
| User identity propagation | ✅ Automatic | ⚠️ Manual OBO flow setup |
| Connector creation | ✅ Wizard-guided, minimal config | ⚠️ Wizard + 4+ post-wizard manual steps |
| Client secret rotation | ✅ N/A (first-party, no secret) | ❌ Manual UI-only step |
| CI/CD automatable | ✅ Full (infra only) | ⚠️ Partial (90% automatable; secret blocks 100%) |
| Entra app registration required | ✅ Not needed (first-party) | ❌ Required + delegated grants |
| DLP visibility | ✅ Native PP connector categories | ⚠️ Custom connector; requires correct DLP group |
| Multi-tenant support | ✅ Yes | ⚠️ Connector is single-tenant; cannot share across tenants |
| Connection sharing | ✅ Per-user or shared | ⚠️ Per-user only for OAuth |
| Redirect URI management | ✅ Managed by platform | ❌ Manual per connector |

---

## Field-Verified Automation Script Capability Summary

The following was verified against a custom MCP connector in a sandbox env:

```powershell
# WORKS - Full OBO setup via pac CLI (verified)
pac connector update \
  --environment $envId \
  --connector-id $connectorId \
  --api-definition-file apiDefinition.json \
  --api-properties-file apiProperties.json   # must use identityProvider: aad shape

# Result (verified via re-download):
# identityProvider: aad                        ✅
# IsOnbehalfofLoginSupported: true             ✅
# AzureActiveDirectoryResourceId: api://...    ✅
# enableOnbehalfOfLogin: true                  ✅
# resourceUri: api://...                       ✅
# tenantId: <tenant-id>                        ✅
# scopes: [array of scope URIs]                ✅

# DOES NOT WORK - No CLI command exists for:
# - Setting client secret
# - Creating OAuth connection non-interactively
# - Reading/rotating client secret
```

---

## Prioritized Recommendations for Product Group

### P0 – Blocking for Enterprise Automation

**[P0-1] Add `pac connector set-secret` command (or equivalent)**  
Allow an admin to set the OAuth client secret for a connector without opening the UI. Alternatively, support Key Vault references so the secret is resolved at runtime from a pre-configured Key Vault reference. This is the single biggest blocker for full CI/CD automation of BYO MCP connectors.

**[P0-2] MCP wizard: generate `identityProvider: aad` connectors by default**  
The wizard should produce an `aad`-type connector when the user selects "Azure Active Directory OAuth" or any AAD-sourced identity. The current `oauth2` type silently disables OBO and misleads developers. The wizard should also pre-populate the `AzureActiveDirectoryResourceId`, `resourceUri`, and `enableOnbehalfOfLogin` fields.

### P1 – Significant UX/DX Impact

**[P1-1] Wizard: create delegated OAuth grant in Entra automatically**  
When the wizard creates the connector proxy app, it should automatically create the `oauth2PermissionGrant` in Entra for the selected resource app. This requires the user to have consent over the resource app, but the wizard can prompt for this or guide the user to an admin approval flow.

**[P1-2] Wizard: add per-connector redirect URI to resource app automatically**  
The wizard knows the connector suffix (it generates the redirect URL). It should offer to add the redirect URI to the resource app's registration, or clearly surface the URL the customer needs to add.

**[P1-3] Wizard: surface the connector proxy app's client ID**  
The newly created connector proxy app's appId is needed for pre-authorization and grant setup, but is not shown in the wizard or the connector UI. Surface it in the connector Security tab or in a post-wizard summary.

**[P1-4] DLP policy: surface block reason in Copilot Studio agent test pane**  
When an agent fails to invoke an MCP action due to DLP policy, surface the failure reason explicitly (e.g. "This connector is blocked by DLP policy [policy-name]"). Currently the agent fails silently with no actionable error.

### P2 – Automation & DevOps

**[P2-1] `pac connection create` support for custom OAuth connectors (service-account or headless)**  
Enable non-interactive OAuth connection creation for automation pipelines. Options: browser-redirect with service account, device code flow, or pre-issued refresh token. Even supporting a "bring your own token" path for CI/CD environments would unblock many DevOps scenarios.

**[P2-2] Document the `identityProvider: aad` connector template path for MCP**  
Currently the official docs recommend the MCP wizard and show screenshots of the `oauth2` UI. There is no documented path for creating an `aad`-type MCP connector via CLI or for migrating a wizard-created connector to `aad`. Add explicit docs + a sample `apiProperties.json` for BYO MCP + OBO scenarios.

**[P2-3] Connector migration: `oauth2` → `aad` without breaking connections**  
Provide an in-place migration path or a `pac connector migrate-identity-provider` command that switches the identity provider type without deleting existing connections. Even a "re-authorize existing connections" bulk flow would reduce the reconnection burden on end users.

**[P2-4] Graph API or BAPI endpoint for connector secret management (with RBAC)**  
Expose a write endpoint for connector secrets behind a dedicated permission (e.g. `ConnectorManagement.ReadWrite.All`) so that RBAC-controlled automation pipelines can set/rotate secrets without full Power Platform admin privileges.

---

## Current Workaround: Full Deployment Checklist

For teams deploying BYO MCP + OBO today, the complete manual/automated steps are:

### Entra (automatable via az CLI / Graph API)
- [ ] Create Entra app registration for MCP server (resource app) — **automatable**
- [ ] Define scopes (`access_as_user`, `ServiceNow.Use`) — **automatable**
- [ ] Pre-authorize Copilot Studio, M365 Copilot, Teams client appIds — **automatable**
- [ ] Add redirect URI for the new connector (known after step 5) — **automatable** (but sequence matters)
- [ ] Create client secret on the app — **automatable**
- [ ] Create delegated grant from connector proxy SP to resource SP — **automatable** (after step 5)

### Power Platform / pac CLI (automatable)
- [ ] Build `apiProperties.json` from `pac connector init --connection-template OAuthAAD` template — **automatable**
- [ ] Fill in `clientId`, `tenantId`, `resourceUri`, `AzureActiveDirectoryResourceId`, `scopes`, `redirectUrl` — **automatable**
- [ ] Create or update connector: `pac connector create/update` — **automatable**

### Power Platform UI (manual — blocked)
- [ ] Open connector Security tab
- [ ] Paste client secret
- [ ] Click "Update connector"

### Post-Deployment
- [ ] Create OAuth connection in Copilot Studio (interactive, per-user) — **manual**
- [ ] Assign connection to agent action — **manual (first time)**
- [ ] Verify DLP policy allows the connector — **manual**

**Total:** ~12 steps | **Automatable:** ~9 | **Manual (UI only):** ~3 (secret, connection creation, DLP check)

---

## Technical Reference

| Item | Value |
|------|-------|
| Connector identityProvider for OBO | `aad` (NOT `oauth2`) |
| Scopes format required | JSON array (NOT space-separated string) |
| Redirect URL pattern | `https://global.consent.azure-apim.net/redirect/<connector-name-encoded>` |
| pac CLI OAuthAAD template | `pac connector init --connection-template OAuthAAD` |
| Key OBO properties in apiProperties | `IsOnbehalfofLoginSupported`, `AzureActiveDirectoryResourceId`, `enableOnbehalfOfLogin`, `resourceUri` |
| Delegated grant target | Resource app's **service principal** (not app registration) |
| Power Platform BAPI base | `https://{region}.api.powerapps.com/providers/Microsoft.PowerApps/...` |
| Connector proxy SP discovery | Graph `GET /servicePrincipals?$filter=appId eq '{connectorClientId}'` |

---

## Related Documents

- [AUTH_ENTRA_OBO_OKTA.md](AUTH_ENTRA_OBO_OKTA.md) — OBO implementation and token flow details
- [BYO_MCP_PM_FEEDBACK.md](BYO_MCP_PM_FEEDBACK.md) — Earlier PM feedback from A365 BYO MCP investigation
- [MCS_ACTION_CONTRACTS.md](MCS_ACTION_CONTRACTS.md) — Copilot Studio MCP action contract reference
- [DEPLOY_CONTAINER_AZURE.md](DEPLOY_CONTAINER_AZURE.md) — Azure deployment guide for MCP server

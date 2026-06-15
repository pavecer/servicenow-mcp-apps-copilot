# Why you should NOT use the Copilot Studio MCP wizard (and what to do instead)

A field-tested guide to getting **silent SSO with on-behalf-of (OBO)** when exposing an MCP server to Microsoft Copilot Studio agents — including Teams and Microsoft 365 Copilot hosts. Validated against a production-shaped ServiceNow MCP server on Azure Functions.

> **Looking for the step-by-step recipe?** See [CUSTOM_MCP_CONNECTOR_OBO.md](./CUSTOM_MCP_CONNECTOR_OBO.md). This document explains **why** that recipe exists, the failure modes of the easy path, and what each piece is doing.

---

## TL;DR

- The Copilot Studio **MCP wizard** ("Tools → Add a tool → Model Context Protocol") is the easy path, but it provisions a connector that **cannot do silent SSO**. Every user sees an "Open connection manager" prompt on first use.
- The **only working path today** for silent SSO/OBO is to **hand-author a custom MCP connector** in Power Platform with `identityProvider: aad`, `IsOnbehalfofLoginSupported: true`, and **two separate Entra apps** (one for the API/resource, one for the connector client).
- Same-app client+resource fails with `AADSTS90009: Application is requesting a token for itself`. The two-app split is structural, not a workaround.
- The hand-authored connector is still an **MCP connector** (`x-ms-agentic-protocol: mcp-streamable-1.0`) — you keep dynamic tool discovery, you do NOT have to re-author each tool as a REST action.
- Validated on the Copilot Studio test pane and Teams. M365 Copilot host needs an additional manifest declaration (covered below).

---

## The problem the wizard creates

When you go to **Copilot Studio → your agent → Tools → Add a tool → Model Context Protocol** and fill in a server URL, Copilot Studio creates a custom connector in your Power Platform environment **for you**. That auto-provisioned connector has these properties:

```jsonc
{
  "connectionParameters": {
    "token": {
      "type": "oauthSetting",
      "oAuthSettings": {
        "identityProvider": "oauth2pkcewithprm",   // <-- the problem
        ...
      }
    }
  }
}
```

`oauth2pkcewithprm` (OAuth 2.0 PKCE + Protected Resource Metadata) is a **public-client** flow designed for the MCP spec's OAuth 2.1 DCR (Dynamic Client Registration). It does two things you don't want when integrating with Microsoft Copilot Studio:

1. **It registers `isSsoConnection: false`** on the resulting Power Platform connection. Every host channel that consumes the connection (Teams, M365 Copilot, web test pane, embedded webchat) reads that flag and shows the per-user **"Open connection manager"** Adaptive Card on first use.
2. **It cannot perform on-behalf-of (OBO)** to a downstream API. There is no client secret, no app identity to act as, no token-exchange capability — by design.

The user experience that results is:

> Let's get you connected first, and then I can find that info for you.
> [Open connection manager] to verify your credentials.
> Once the connection is ready, retry your request.

For demos this is tolerable. For a production rollout to thousands of users it is not — every employee has to click through it before the agent works, and refresh-token expiry (~90 days idle) reintroduces the prompt periodically.

**There is no setting, no toggle, no preview flag in the Copilot Studio MCP wizard that changes this.** As of mid-2026 the wizard is hard-coded to `oauth2pkcewithprm` and Microsoft has SSO support for MCP connectors on the roadmap with no GA date.

---

## What "the right way" actually means

You want a connector whose Power Platform connection has `isSsoConnection: true` AND that can do OBO to your downstream API on behalf of the signed-in Microsoft 365 user. That requires three things the wizard does not configure:

| What | Why |
|---|---|
| `identityProvider: aad` (NOT `oauth2pkcewithprm`) | This is the only identity provider in the Power Platform custom-connector catalog that supports both SSO and OBO. |
| `IsOnbehalfofLoginSupported: true` + `enableOnbehalfOfLogin: "true"` | Two redundant flags in different places of the connector schema. Power Platform needs both. |
| **A separate Entra "client" app** distinct from the API resource app | Entra ID **rejects** an OAuth code flow where the `client_id` and the requested resource (`api://<app>`) are the same app. The rejection surfaces as `AADSTS90009` — see below. |

You can achieve this by **hand-authoring** a Power Platform custom connector — either through the maker portal's "New custom connector → Create from blank" flow or, more reliably, through the Power Platform REST API. The connector you author is **still an MCP connector** in every meaningful sense (it advertises `x-ms-agentic-protocol: mcp-streamable-1.0` on its single POST operation), so Copilot Studio still discovers tools dynamically from your MCP server. You do not lose dynamic discovery.

---

## The AADSTS90009 trap

If you naively define a custom connector with `identityProvider: aad` and re-use your existing API Entra app as the connector's OAuth client (because that's the only Entra app you have, and it has all the right scopes), the very first sign-in fails with:

```
AADSTS90009: Application '<API-APP-ID>' is requesting a token for itself.
This scenario is supported only if resource is specified using the GUID
based App Identifier.
```

This is **structural**, not a config bug. Entra ID's OAuth 2.0 code flow requires that the **client** requesting a token and the **resource** the token is for are distinct Entra apps. The only exception is internal first-party scenarios where the resource is referenced by raw GUID rather than `api://<app>` URI — not something a Power Platform connector can do.

The fix is to introduce a **second Entra app** as the connector's OAuth client:

```
┌───────────────────────────┐         ┌──────────────────────────────┐
│  Client Entra App         │         │  API/Resource Entra App      │
│  (the connector)          │         │  (your MCP server)           │
│                           │         │                              │
│  appId: <CLIENT_APP_ID>   │         │  appId: <API_APP_ID>         │
│  + client secret          │         │  identifierUris:             │
│  + redirectUri =          │         │    api://<API_APP_ID>        │
│      connector redirect   │         │  + exposed scope             │
│                           │         │      access_as_user          │
│  requiredResourceAccess:  │         │                              │
│    <API_APP_ID> /         │ ──────► │  preAuthorizedApplications:  │
│    access_as_user         │         │    <CLIENT_APP_ID> /         │
│                           │         │    access_as_user            │
└───────────────────────────┘         └──────────────────────────────┘
```

The custom connector's `oAuthSettings.clientId` points at the **client** app; `customParameters.resourceUri` and `scopes` point at the **API** app. Now the token request has `client_id ≠ aud` and Entra is happy.

**Pre-authorizing** the client app on the API app's "Expose an API → Authorized client applications" list is what makes the first-use experience genuinely silent — no Entra consent screen appears at all. Without pre-authorization the user gets a one-time consent screen ("This app would like to access ServiceNow MCP on your behalf") that, while harmless, looks like a security prompt and adds friction.

---

## End-to-end flow with the right setup

```
User → Copilot Studio agent → MCP tool call
   ↓
Power Platform Custom MCP Connector (identityProvider=aad, OBO=on)
   ↓
   Mints token for api://<API_APP_ID>/access_as_user
   using <CLIENT_APP_ID> as the OAuth client, on behalf of the user
   ↓
POST https://<your-mcp-server>/mcp   Authorization: Bearer <user-token>
   ↓
Your MCP server validates JWT:
   - audience = <API_APP_ID>
   - issuer = your tenant
   - user identity preserved in claims
   ↓
[If your downstream API needs the user identity:]
   MCP server performs OBO exchange:
   POST https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token
        grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
        client_id=<API_APP_ID>
        client_secret=<from KV>
        assertion=<user-token>
        scope=api://<API_APP_ID>/ServiceNow.Use
   ↓
Downstream call (e.g., ServiceNow REST) executed as the user
   → audit trail in the downstream system attributes the action correctly
```

What the user actually experiences in the Copilot Studio test pane / Teams:

- **First tool invocation per environment**: a single small "Allow" approval card pops up — one click. No browser popup, no Entra sign-in screen (thanks to pre-authorization), no "Open connection manager" prompt.
- **Every subsequent invocation**: silent. Cached refresh token mints new access tokens automatically.
- **After ~90 days of inactivity OR after the connector's client secret is rotated without pushing the new value into the connector**: re-consent.

In M365 Copilot host: same UX **after** you publish the agent with the right manifest declarations (see the section below). Without the manifest, M365 Copilot falls back to per-host consent.

---

## How this solution was created (the actual journey)

This is honest history, not marketing. If you're going to walk this path you should know where the time goes.

### Day 1: tried the wizard, hit the prompt

Added the MCP tool via Copilot Studio's wizard, accepted the defaults, signed in once → tools discovered fine. Got the per-user "Open connection manager" card on every test. Read the Microsoft docs ([Configure user authentication for an agent](https://learn.microsoft.com/microsoft-copilot-studio/configuration-end-user-authentication)) and concluded incorrectly that the prompt was a one-time inconvenience.

### Day 2: realized this was the limit of the wizard, not a config issue

Inspected the auto-provisioned connector via the Power Platform REST API:

```bash
TOKEN=$(az account get-access-token --resource https://service.powerapps.com/ --query accessToken -o tsv)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.powerapps.com/providers/Microsoft.PowerApps/apis/<connector-internal-name>?api-version=2017-06-01&\$filter=environment eq '<env-id>'" \
  | jq '.properties.connectionParameters.token.oAuthSettings.identityProvider'
# "oauth2pkcewithprm"
```

Confirmed via the Power Platform connectivity API that connections of this type return `isSsoConnection: false`. No knob in the wizard changes this. **The wizard cannot do SSO.**

### Day 3: first attempt at a hand-authored connector — AADSTS90009

Created a second connector via the maker portal "New custom connector → Create from blank" with `identityProvider: aad`. Re-used the existing API Entra app as both the OAuth client AND the resource. Sign-in failed with `AADSTS90009`.

Spent a while assuming this was a permissions or grant issue. It is not. The error message is literal: Entra refuses to issue a token where `client_id == aud`.

### Day 4: introduced a separate client app, then realized we already had one

Scanned the tenant for Entra apps that already had `access_as_user` delegated permission on the API app. Found an app created weeks earlier for an unrelated experiment but configured **exactly** as the connector client needed. Reused it.

Lesson: before creating new Entra apps, scan the tenant. Custom connectors leave behind stub client apps that other connectors can reuse.

### Day 5: connector PATCH validator surprises

Updating the connector through the REST API ran into four validator rejections in sequence:

| Symptom | What was wrong | Fix |
|---|---|---|
| `CannotUpdateApiDisplayName` | PATCH body included `displayName` | Drop it from the PATCH body |
| `Swagger contains base path:/apim/... but backend Url doesn't end on same path:/` | Echoed back the proxied APIM host instead of the real backend | Set swagger `host` to the Function App hostname, `basePath: "/"` |
| `Paths with x-ms-agentic-protocol should only have a POST operation` | The path had a sibling GET | Drop non-POST methods from agentic paths |
| `Non-unique array item at index 2. Path '...post.tags[2]'` | Power Platform appends its own tags then strict-validates uniqueness | Strip `tags` from operations entirely; Power Platform adds what it needs |

None of these are documented in any public Microsoft article we could find. They are the kind of thing you only learn by doing the rollout.

### Day 6: pre-authorized the client app, validated silent SSO

Added the client app's appId to the API app's `preAuthorizedApplications` list with both relevant scope ids. Deleted the old broken connection. On the next tool call: single "Allow" approval card → click → silent thereafter. End-to-end OBO confirmed by checking ServiceNow's request audit log — `requested_for` correctly showed the signed-in test user, not the integration service account.

The total elapsed effort was roughly two days of focused work for someone who already understood OAuth, OBO, and the Power Platform custom-connector schema. Expect more for someone learning these concepts.

---

## What you need to configure (checklist)

### One-time, per tenant
- [ ] Identify or create the **API/resource Entra app** for your MCP server.
  - `identifierUris: ["api://<API_APP_ID>"]`
  - Exposed scope `access_as_user` (delegated)
  - Exposed scope for the downstream OBO target if any (e.g. `ServiceNow.Use`)
  - Client secret stored in Key Vault (consumed by your MCP server for OBO)
- [ ] Identify or create the **client Entra app** for the connector.
  - Delegated permission to API app `access_as_user`
  - Admin-consent granted
  - Client secret stored in Key Vault (consumed by the connector)
  - Redirect URIs include `https://global.consent.azure-apim.net/redirect/<connector-internal-name>`
- [ ] **Pre-authorize** the client app on the API app's "Expose an API → Authorized client applications" list, ticking the `access_as_user` scope.

### One-time, per Power Platform environment
- [ ] Hand-author the custom MCP connector with:
  - Swagger: single `POST /mcp` operation, `x-ms-agentic-protocol: mcp-streamable-1.0`, no GET sibling, no `tags`
  - `connectionParameters.token.oAuthSettings.identityProvider: "aad"`
  - `clientId` = client app id (NOT the API app id)
  - `clientSecret` = value from Key Vault
  - `scopes: ["api://<API_APP_ID>/access_as_user"]`
  - `properties.AzureActiveDirectoryResourceId: "api://<API_APP_ID>"`
  - `properties.IsOnbehalfofLoginSupported: true`
  - `customParameters.resourceUri.value: "api://<API_APP_ID>"`
  - `customParameters.tenantId.value: "<TENANT_ID>"`
  - `customParameters.enableOnbehalfOfLogin.value: "true"`
  - `backendService.serviceUrl: "https://<your-mcp-server>/"` (trailing slash)
- [ ] Add the connector's redirect URI to the client Entra app's `web.redirectUris`.

### Per Copilot Studio agent
- [ ] Add the **hand-authored** connector as a tool (NOT via the MCP wizard). In the agent: **Tools → Add a tool → Connector**, then pick your custom connector by name. Copilot Studio will perform the MCP handshake on first use and dynamically discover your server's tools.
- [ ] Verify the agent's orchestrator model is GPT-5 or newer, or Claude Sonnet (GPT-4.1 cannot reliably render MCP Adaptive Cards — see `COPILOT_STUDIO_SETUP.md`).
- [ ] Delete any old connection that was created against the broken `oauth2pkcewithprm` connector — they cannot be repaired.

### For Microsoft Teams host
- [ ] Publish the agent to Teams via the standard Copilot Studio → Channels → Microsoft Teams flow.
- [ ] **For best UX**: include a Teams app manifest with `webApplicationInfo`:
  ```json
  {
    "webApplicationInfo": {
      "id": "<API_APP_ID>",
      "resource": "api://<API_APP_ID>"
    }
  }
  ```
  This lets Teams desktop / Teams web exchange the user's Teams SSO token for an `aud=<API_APP_ID>` token without any prompt. Without this declaration the first-use "Allow" card still appears but works correctly.

### For Microsoft 365 Copilot host
- [ ] Equivalent declaration in the agent's M365 Copilot app manifest (`copilotExtensions.declarativeAgents[].authorization` or the agent's app package descriptor depending on how you publish).
- [ ] Microsoft Defender for Cloud Apps / Conditional Access: confirm the client app id is allowed in any "Cloud apps or actions" filters that gate Microsoft Graph / M365 Copilot. New Entra apps not seen before may be blocked by policy.

### For embedded webchat / Direct Line / custom hosts
- [ ] No additional manifest needed. The first-use "Allow" approval card is presented inline in the chat; the user clicks it once.

---

## Operational notes

### Secret rotation

The connector's client secret needs to be rotated periodically (annually or when an Entra app secret expires). Sequence matters:

1. Mint new secret on the client Entra app via Graph (`addPassword`).
2. Store in Key Vault as a new secret version.
3. PATCH the custom connector with the new `clientSecret` value via the Power Platform REST API.
4. Verify a fresh sign-in works.
5. **Then** remove the old password from the client Entra app via Graph (`removePassword`).

If you remove the old password before step 4, all existing user connections instantly invalidate and every user has to re-consent.

### Monitoring

- App Insights on the MCP server: watch for `401 Unauthorized` and `Invalid audience` spikes — they often mean a connector misconfiguration (wrong `aud` in the issued token).
- Power Platform admin center → **Analytics → Connectors**: track connection count and authentication failure rate for the custom connector.
- ServiceNow (or whatever your downstream system is) audit log: confirm `requested_for` / `caller` is the signed-in user, not the integration account. This is the proof-of-life that OBO is actually flowing through.

### Why this is more work than the wizard, and when it's worth it

| Scenario | Recommendation |
|---|---|
| Internal demo, < 20 users, one-time prompt is acceptable | Use the wizard. Done in 5 minutes. |
| Production deployment, > 50 users, audit trail matters | Hand-authored custom connector. Two days to set up, lifetime of cleaner UX and proper attribution. |
| Multi-tenant ISV scenario | Hand-authored, multi-tenant Entra apps, and accept that admin consent in each customer tenant is required. |

The hand-authored path is genuinely more work, but **it is the only path that produces a Copilot Studio MCP integration whose first-use UX matches what users expect from a "real" Microsoft 365 integration**. Once it's done it's done — the operational overhead afterwards is one secret rotation per year.

---

## Related docs in this repo

- [CUSTOM_MCP_CONNECTOR_OBO.md](./CUSTOM_MCP_CONNECTOR_OBO.md) — step-by-step recipe with exact CLI commands, full PATCH body, validator-quirk fixes, reference values
- [../COPILOT_STUDIO_SETUP.md](../COPILOT_STUDIO_SETUP.md) — Copilot Studio tool setup, orchestrator-model requirements, troubleshooting
- [MCS_ACTION_CONTRACTS.md](./MCS_ACTION_CONTRACTS.md) — exact request/response schemas of each MCP tool (useful when authoring topics that bind to the tool outputs)
- [../README.md](../README.md) — overall project structure

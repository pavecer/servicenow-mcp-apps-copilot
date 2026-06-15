# Authentication patterns for the ServiceNow MCP server in Copilot Studio

This document describes two end-to-end authentication architectures for hosting this MCP server behind a Microsoft Copilot Studio agent, and how each one impacts the per-user **"Open connection manager"** prompt that Copilot Studio raises by default for `oauth2pkcewithprm` connectors.

It complements:

- [COPILOT_STUDIO_SETUP.md](../COPILOT_STUDIO_SETUP.md) — the current `Dynamic discovery` setup (`oauth2pkcewithprm`) and why the per-user prompt is unavoidable with that identity provider.
- [SERVICENOW_SETUP.md](SERVICENOW_SETUP.md) — ServiceNow OAuth app, integration user, roles.
- [AGENT_365_BYO_MCP.md](AGENT_365_BYO_MCP.md) — tenant-governed registration in Microsoft 365 admin.

> **TL;DR**
>
> | Pattern | ServiceNow IdP | Per-user prompt | Per-user SN identity | Changes to repo | Changes to ServiceNow |
> |---|---|---|---|---|---|
> | **Current** (this repo today) | ServiceNow OAuth (password grant, integration user) | Yes (one-time / channel) | Attribution via `requested_for` only | None — already wired | None |
> | **Pattern A — Entra OBO direct** | Entra ID (added as OIDC IdP in ServiceNow) | **None** (silent SSO) | Yes — per user, native | Add OBO token exchange in `tokenManager.ts`; flip connector | Add Entra as OIDC provider |
> | **Pattern B — Entra OBO via Okta** | Okta (existing) | **None** (silent SSO) | Yes — per user, native | Add JWT-Bearer exchange call to Okta; flip connector | None (Okta config only) |

---

## Why this matters

Today, when you publish the agent to Teams or Microsoft 365 Copilot, every new user is hit with a one-time **"Let's get you connected first… Open connection manager"** card before any tool fires. This is documented behavior of the `oauth2pkcewithprm` identity provider used by Copilot Studio's MCP Dynamic discovery wizard. See the *Channel notes* section of [COPILOT_STUDIO_SETUP.md](../COPILOT_STUDIO_SETUP.md#channel-notes---teams-and-microsoft-365-copilot-per-user-open-connection-manager-prompt-no-sso) for the full reasoning.

Both patterns below replace `oauth2pkcewithprm` with an **SSO-capable** Entra ID OAuth connector configured with **Enable on-behalf-of login**. Combined with pre-authorizing the host (Teams / M365 Copilot) on the MCP server's Entra app, this eliminates the connection-manager prompt entirely.

---

## What this repo already provides

The MCP server is **already a fully compliant Entra-protected OAuth resource**. The OBO patterns only add a downstream token exchange; nothing about the MCP edge changes.

| Capability | Where it lives | Status |
|---|---|---|
| Bearer token validation on `POST /mcp` and `/api/catalog/*` | [src/utils/entraAuthMiddleware.ts](../src/utils/entraAuthMiddleware.ts), [src/services/entraTokenValidator.ts](../src/services/entraTokenValidator.ts) | ✅ |
| RFC 8414 / 9728 metadata at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` | [src/functions/oidc.ts](../src/functions/oidc.ts) | ✅ |
| RFC 7591 Dynamic Client Registration at `POST /oauth/register` | [src/functions/oidc.ts](../src/functions/oidc.ts) | ✅ |
| Multi-tenant token acceptance (`ENTRA_TRUSTED_TENANT_IDS`, `ENTRA_ALLOW_ANY_TENANT`) | [src/config.ts](../src/config.ts) | ✅ |
| Custom App ID URIs (`ENTRA_ALLOWED_AUDIENCES`) | [src/config.ts](../src/config.ts) | ✅ |
| `requested_for` attribution from Entra `upn` / `oid` | [src/services/servicenowClient.ts](../src/services/servicenowClient.ts) | ✅ |
| Optional "no fallback to integration user" enforcement (`SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN`) | [src/config.ts](../src/config.ts), [infra/main.bicep](../infra/main.bicep) | ✅ wired, awaiting downstream OBO implementation |
| Per-user ServiceNow token via `x-servicenow-access-token` header | [src/config.ts](../src/config.ts) | ✅ contract reserved; **implementation hook missing in [tokenManager.ts](../src/services/tokenManager.ts)** |

The only code that needs to change to enable either Pattern A or Pattern B is in [src/services/tokenManager.ts](../src/services/tokenManager.ts): replace (or augment) the ServiceNow password-grant call with an OBO-driven exchange. Everything else — middleware, config, identity extraction, `requested_for`, Bicep parameters, Copilot Studio topic YAML — stays as is.

---

## Common foundation for both patterns

Both patterns share the same Entra app layout, connector configuration, and host pre-authorizations. The downstream exchange to ServiceNow is the only divergence.

### Entra ID app registrations (in your home tenant)

You already have one Entra app registration for this server. For SSO-grade OBO, the recommended layout is **two** registrations to follow Microsoft's separation-of-concerns guidance (see [Configure OBO authentication for custom connectors](https://learn.microsoft.com/microsoft-copilot-studio/advanced-custom-connector-on-behalf-of)):

| Registration | Role | Settings |
|---|---|---|
| **Server App** (`ServiceNow MCP Server`) | OAuth 2.0 resource (your Function). This is the audience of incoming user tokens. | Application ID URI: `api://<server-app-id>`. Expose scope: `access_as_user` (delegated, admins+users). Federated credential bound to the Function's User-Assigned Managed Identity (recommended) **or** a client secret. |
| **Client App** (`ServiceNow MCP Connector`) | OAuth client used by the Copilot Studio custom connector. | Web platform with the Power Platform redirect URIs (already in [README.md](../README.md) step 2). Delegated API permission on `api://<server-app-id>/access_as_user`. **Pre-authorized client IDs**: see next section. |

> If you currently have a single combined app, you can keep using it — set its API permissions to pre-authorize *itself* on its own scope. Splitting into two apps is cleaner long-term but not required.

#### Pre-authorize Copilot Studio and Microsoft 365 hosts

On the **Server App**, *Expose an API → Add a client application* and add the first-party app IDs that should be allowed to silently obtain tokens for `access_as_user` without a consent screen:

| First-party host | App ID to pre-authorize |
|---|---|
| Power Platform / Copilot Studio runtime | `7df0a125-d3be-4c96-aa54-591f83ff541c` (Power Apps / Copilot Studio) |
| Microsoft Teams desktop / web | `1fec8e78-bce4-4aaf-ab1b-5451cc387264` (Teams mobile/desktop) and `5e3ce6c0-2b1f-4285-8d4b-75ee78787346` (Teams web) |
| Microsoft 365 Copilot (web / Office) | `ab9b8c07-8f02-4f72-87fa-80105867a763` (M365 Copilot) |

Plus pre-authorize the **Client App** on the same scope. Grant tenant-wide admin consent for the scope on the Server App so no user-level consent screen appears.

> Exact first-party client IDs evolve; the canonical list lives in Microsoft documentation and the Teams/M365 Copilot manifest reference. Treat the table above as a starting point and verify against your tenant's sign-in logs.

### Copilot Studio custom connector — security tab

Open the existing **ServiceNow MCP** custom connector in Power Apps and update **2. Security**:

| Field | Value |
|---|---|
| Authentication type | OAuth 2.0 |
| Identity provider | **Azure Active Directory** (not "Generic OAuth 2.0 PRM") |
| Client ID | *Client App* application (client) ID |
| Client secret | *Client App* secret  — **or** select *Use Managed Identity* and use a federated credential |
| Authorization URL | `https://login.microsoftonline.com` |
| Tenant ID | your tenant GUID |
| Resource URL | *Server App* application (client) ID (not the App ID URI; the bare GUID) |
| Scope | `api://<server-app-id>/.default` |
| **Enable on-behalf-of login** | **true** ← this is the toggle that activates SSO |

This is the exact recipe from [Deploy Azure MCP Server with on-behalf-of authentication](https://learn.microsoft.com/azure/developer/azure-mcp-server/how-to/deploy-remote-mcp-server-on-behalf-of) applied to a custom (non-Microsoft) MCP server.

> ⚠️ Once you save this, **delete any existing user connections** for this connector. Existing `oauth2pkcewithprm`-bound connections cannot be migrated; users must let the agent create a fresh, silent connection on next invocation.

### Teams / M365 Copilot manifest (only required for true silent SSO)

For Teams: add a `webApplicationInfo` block to the Teams app manifest with `id = <server-app-id>` and `resource = api://<server-app-id>`. Publish the Teams app to your tenant catalog. This is what the existing [COPILOT_STUDIO_SETUP.md](../COPILOT_STUDIO_SETUP.md#why-sso-does-not-kick-in-automatically-any-channel) calls out as a prerequisite for SSO.

For Microsoft 365 Copilot: declare the equivalent in the agent's M365 Copilot manifest. If you registered the server via [AGENT_365_BYO_MCP.md](AGENT_365_BYO_MCP.md), the BYO MCP record already carries the Entra resource binding — verify it matches the **Server App** ID.

### Inside the Function — extract the inbound user token

The middleware already validates the token. To use it for OBO, expose the raw bearer string to downstream calls. Minimum change in [src/utils/entraAuthMiddleware.ts](../src/utils/entraAuthMiddleware.ts) on success:

```typescript
res.locals.callerEntraObjectId = payload.oid;
res.locals.callerUpn = payload.preferred_username || payload.upn;
res.locals.callerAccessToken = token; // <-- add this line
```

Then read `res.locals.callerAccessToken` from the [requestContext.ts](../src/requestContext.ts) shim and make it available to `TokenManager.getAccessToken()`. That's the integration point for both patterns.

---

## Pattern A — Entra OBO direct (ServiceNow trusts Entra ID)

**When to choose this**: your tenant owns the ServiceNow instance, ServiceNow administration is in-house, and you can register Entra ID as an OIDC identity provider on the ServiceNow side.

### Identity flow

```mermaid
sequenceDiagram
  participant U as User (Teams / M365 Copilot)
  participant C as Copilot Studio Agent
  participant K as Custom Connector<br/>(Entra OAuth + OBO)
  participant F as Azure Function<br/>MCP Server
  participant E as Entra ID
  participant S as ServiceNow

  U->>C: Invoke agent (already SSO'd)
  C->>K: Request tool call
  K->>E: Acquire token (OBO)<br/>aud = Server App
  E-->>K: User access token
  K->>F: POST /mcp + Bearer (user token)
  F->>F: entraAuthMiddleware validates
  F->>E: AcquireTokenOnBehalfOf<br/>scope = ServiceNow OIDC scope
  E-->>F: Access token, aud = ServiceNow
  F->>S: Bearer = Entra token
  S->>S: Validates against Entra OIDC provider config
  S-->>F: Catalog / order data
  F-->>K-->>C-->>U: Adaptive card response
```

### ServiceNow configuration (one-time)

In your ServiceNow instance:

1. **System OAuth → Application Registry → New → Connect to a third party OAuth Provider** (or *OIDC Provider Configuration* on newer releases).
2. Provider name: `Microsoft Entra ID`
3. OAuth Provider URL / Discovery URL: `https://login.microsoftonline.com/<tenant-id>/v2.0/.well-known/openid-configuration`
4. Client ID: the **Server App** application ID
5. Default Grant type: *JWT Bearer* (or *Authorization Code* — depends on your ServiceNow release)
6. User identifier claim: `preferred_username` or `email`
7. Map to ServiceNow `sys_user` by `email` (or `user_name` if your tenant aligns UPN and SN login)

Register a second Entra App ID URI **on the Server App** that represents the ServiceNow scope, e.g. `api://<server-app-id>/ServiceNow.Use`. Add it as a delegated API permission so OBO can request it.

### Code change in this repo

In [src/services/tokenManager.ts](../src/services/tokenManager.ts), add a second method that runs only when a caller token is available:

```typescript
import { ConfidentialClientApplication } from "@azure/msal-node";

async getAccessTokenForCaller(callerAccessToken: string): Promise<string> {
  const msal = new ConfidentialClientApplication({
    auth: {
      clientId: config.entraAuth.clientId!,
      authority: `https://login.microsoftonline.com/${config.entraAuth.tenantId}`,
      clientSecret: config.entraAuth.clientSecret!, // or federated credential
    },
  });
  const result = await msal.acquireTokenOnBehalfOf({
    oboAssertion: callerAccessToken,
    scopes: [`api://${config.entraAuth.clientId}/ServiceNow.Use`],
  });
  if (!result?.accessToken) throw new Error("OBO exchange failed");
  return result.accessToken;
}
```

Wire `ServiceNowClient` to prefer this path when `res.locals.callerAccessToken` is set and `SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN=true`, falling back to the existing integration-user grant otherwise. No changes to the REST calls themselves — they already pass `Authorization: Bearer <token>`.

### Trade-offs

| Pros | Cons |
|---|---|
| True per-user ACL enforcement in ServiceNow (no shared service account). | Requires ServiceNow admin to register Entra as an OIDC provider — political/governance hurdle in some orgs. |
| Conditional Access policies apply to the OBO exchange (granular per-resource policies). | User identities in Entra and SN must match deterministically (UPN/email). |
| No integration-user password to rotate. | ServiceNow scoped applications and ACLs must be authored to work with delegated tokens (not just `admin` / `itil` shortcuts). |

---

## Pattern B — Entra OBO with Okta in front of ServiceNow

**When to choose this**: your enterprise standard is **Okta** as the IdP for SaaS apps including ServiceNow, and you cannot (or don't want to) introduce a second IdP into the ServiceNow trust configuration. This is common in large enterprises where Okta is the corporate identity hub and Microsoft 365 / Entra is downstream.

### Identity flow

```mermaid
sequenceDiagram
  participant U as User (Teams / M365 Copilot)
  participant C as Copilot Studio Agent
  participant K as Custom Connector<br/>(Entra OAuth + OBO)
  participant F as Azure Function<br/>MCP Server
  participant E as Entra ID
  participant O as Okta Org<br/>(External IdP: Entra)
  participant S as ServiceNow

  U->>C: Invoke agent (already SSO'd)
  C->>K: Request tool call
  K->>E: Acquire token (OBO)<br/>aud = Server App
  E-->>K: User access token
  K->>F: POST /mcp + Bearer (user token)
  F->>F: entraAuthMiddleware validates
  F->>O: POST /token<br/>grant_type=jwt-bearer<br/>assertion=<Entra user JWT>
  O->>O: Validates JWT against Entra JWKS<br/>(External IdP trust)
  O-->>F: Okta access token, aud = ServiceNow
  F->>S: Bearer = Okta token
  S->>S: Validates against Okta (existing trust)
  S-->>F: Catalog / order data
  F-->>K-->>C-->>U: Adaptive card response
```

ServiceNow is **unchanged**. Okta becomes a *token broker* between Entra (who authenticated the user) and ServiceNow (who already trusts Okta).

### Okta configuration (one-time)

1. **Security → Identity Providers → Add → OpenID Connect IdP**
   - Issuer URI: `https://login.microsoftonline.com/<tenant-id>/v2.0`
   - JWKS URI: `https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys`
   - Audience restriction: `api://<server-app-id>`
   - User matching rule: `email` (or `preferred_username`) → Okta user `login`
   - JIT provisioning: enable if you want auto-create

2. **Security → API → Authorization Servers → Add** (or pick the org auth server)
   - Audience: your ServiceNow OAuth resource (e.g. `https://<instance>.service-now.com`)
   - **Scopes**: define the scopes you already use against ServiceNow
   - **Access Policy → Add Rule** allowing `urn:ietf:params:oauth:grant-type:jwt-bearer`

3. **Applications → Create App Integration → API Services** (or OIDC Service App with JWT-Bearer grant enabled)
   - Grant type: **JWT Bearer**
   - Client authentication: `private_key_jwt` (preferred) or client secret
   - Note the **Client ID** and (if secret) the secret — these are what the Function uses

### Code change in this repo

In [src/services/tokenManager.ts](../src/services/tokenManager.ts), add an Okta token exchange method:

```typescript
async getAccessTokenForCallerViaOkta(callerAccessToken: string): Promise<string> {
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: callerAccessToken,
    scope: config.okta.scopes,                  // e.g. "useraccount openid"
    client_id: config.okta.clientId,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: await buildOktaClientAssertion(),
  });
  const resp = await axios.post(
    `${config.okta.authServerUrl}/v1/token`,
    form,
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return resp.data.access_token;
}
```

Cache the Okta token per-user (key on the validated `oid` claim) for its lifetime to avoid hitting Okta on every tool call. The existing `CachedToken` shape in `TokenManager` is a good template.

Add new config keys in [src/config.ts](../src/config.ts):

```typescript
okta: {
  authServerUrl: process.env.OKTA_AUTH_SERVER_URL,           // https://<domain>/oauth2/<authServerId>
  clientId: process.env.OKTA_CLIENT_ID,
  privateKeyPem: process.env.OKTA_PRIVATE_KEY_PEM,           // if using private_key_jwt
  scopes: process.env.OKTA_SCOPES ?? "openid useraccount",
}
```

Add matching Bicep parameters in [infra/main.bicep](../infra/main.bicep) and store `OKTA_PRIVATE_KEY_PEM` in Key Vault (the project already routes secrets through Key Vault).

### Identity-matching prerequisite

The user must exist on both sides of the bridge with a deterministic key:

| Entra claim | Okta attribute | ServiceNow user field |
|---|---|---|
| `preferred_username` / `upn` | `login` | `sys_user.user_name` or `sys_user.email` |

If Okta is the primary corporate IdP and Microsoft 365 sign-in is already federated through Okta, this match is guaranteed — Entra UPN equals Okta login. Otherwise either run a transform rule in Okta or maintain a mapping table in the MCP server.

### Trade-offs

| Pros | Cons |
|---|---|
| **Zero changes in ServiceNow** — Okta continues to be its only IdP. | Adds Okta into the per-request hot path — latency + dependency. Mitigate with per-user token cache. |
| End-user experience is identical to Pattern A (silent SSO). | Requires Okta admin to enable JWT-Bearer grant and register Entra as an external IdP. Some Okta orgs lock these down. |
| Works in tenants where ServiceNow team is a separate org from the agent team. | Two trust links to maintain (Entra→Okta, Okta→ServiceNow). |

---

## Fallbacks if neither OBO pattern is feasible

If the ServiceNow team will not register Entra and Okta will not enable JWT-Bearer, you have two practical fallbacks:

1. **SAML 2.0 Bearer Assertion (RFC 7522)** — same idea as JWT-Bearer but uses a SAML assertion. Workable when Okta is already configured with Entra as a SAML IdP. Trades the JSON exchange for a SAML one; mechanics in the Function are similar.
2. **Stay on the current pattern** — keep the shared ServiceNow integration user, keep `requested_for` attribution from the Entra token (already implemented), and accept the one-time-per-channel "Open connection manager" prompt. Per-user *audit* is preserved; per-user *authorization* is not. This is what the repo does today and what the [COPILOT_STUDIO_SETUP.md](../COPILOT_STUDIO_SETUP.md#what-the-user-actually-experiences) workarounds table calls out as the recommended default.

---

## Migration checklist (either pattern)

1. ☐ Decide Pattern A vs Pattern B based on who owns the ServiceNow trust config.
2. ☐ Split (or repurpose) Entra registrations into **Server App** + **Client App**; pre-authorize the Client App and the first-party hosts on `access_as_user`.
3. ☐ Grant tenant-wide admin consent on the Server App scope.
4. ☐ Pattern A only: register Entra as an OIDC provider in ServiceNow; add the second App ID URI scope on the Server App.
5. ☐ Pattern B only: add Entra as an OIDC External IdP in Okta; create an auth server + JWT-Bearer-enabled service app in Okta.
6. ☐ Implement `getAccessTokenForCaller` (or `…ViaOkta`) in [src/services/tokenManager.ts](../src/services/tokenManager.ts) and surface `res.locals.callerAccessToken` from the middleware.
7. ☐ Add new env vars to [src/config.ts](../src/config.ts) and Bicep parameters to [infra/main.bicep](../infra/main.bicep); store secrets in Key Vault.
8. ☐ Set `SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN=true` to disable integration-user fallback once the new path is verified.
9. ☐ In Power Apps, edit the **ServiceNow MCP** custom connector → Security tab → switch to Azure AD with **Enable on-behalf-of login = true** (see table above). Delete and recreate all user connections.
10. ☐ Publish the Teams app manifest with `webApplicationInfo` pointing at the Server App. Verify the silent SSO path with a non-admin test user on Teams desktop and M365 Copilot web.
11. ☐ Update [AGENT_365_BYO_MCP.md](AGENT_365_BYO_MCP.md) registration so the BYO MCP record matches the Server App ID.
12. ☐ Smoke test: `npm run smoke:test` against the deployed endpoint with a real user token; verify Application Insights shows the OBO exchange and the user-scoped ServiceNow call.

---

## Reference docs

- [Configure OBO authentication for custom connectors](https://learn.microsoft.com/microsoft-copilot-studio/advanced-custom-connector-on-behalf-of)
- [Deploy Azure MCP Server with on-behalf-of authentication](https://learn.microsoft.com/azure/developer/azure-mcp-server/how-to/deploy-remote-mcp-server-on-behalf-of) — the canonical reference template; this doc adapts the same pattern to a non-Microsoft downstream (ServiceNow / Okta)
- [Use SSO for connectors in agents](https://learn.microsoft.com/power-platform/release-plan/2025wave1/microsoft-copilot-studio/use-sso-connectors-agents) (GA July 31, 2025)
- [Conditional Access for agent identities — OBO flow](https://learn.microsoft.com/entra/identity/conditional-access/agent-id#on-behalf-of-obo-flow)
- [Microsoft identity platform — On-behalf-of flow](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-on-behalf-of-flow)
- [RFC 7523 — JWT Profile for OAuth 2.0 Client Authentication and Authorization Grants](https://datatracker.ietf.org/doc/html/rfc7523) (used in Pattern B)
- [Okta — Configure an external OIDC Identity Provider](https://developer.okta.com/docs/concepts/identity-providers/) and [Token exchange grant](https://developer.okta.com/docs/guides/configure-direct-auth-grants/aiyamasi/main/)

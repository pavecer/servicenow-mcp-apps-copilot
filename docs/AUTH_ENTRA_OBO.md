# Per-user authentication (Entra On-Behalf-Of) for the ServiceNow MCP server

This document describes how each user gets their own ServiceNow identity through
this MCP server via Entra **On-Behalf-Of (OBO)**, enabling silent SSO instead of a
per-user OAuth connection prompt.

**Pattern A (Entra direct) is the implemented and deployed path.** Pattern B
(Okta in front of ServiceNow) is included as a design reference only — it has
**not been built or tested** in this repo; treat it as theoretical guidance.

It complements:

- [SERVICENOW_SETUP.md](SERVICENOW_SETUP.md) — ServiceNow OAuth app, integration user, roles.
- [AGENT_365_BYO_MCP.md](AGENT_365_BYO_MCP.md) — tenant-governed registration in Microsoft 365 admin.

> **TL;DR**
>
> | Pattern | ServiceNow IdP | Per-user prompt | Per-user SN identity | Changes to repo | Changes to ServiceNow |
> |---|---|---|---|---|---|
> | **Current fallback** | ServiceNow OAuth (password grant, integration user) | Yes (one-time / channel) | Attribution via `requested_for` only | None — already wired | None |
> | **Pattern A — Entra OBO direct** ✅ **deployed** | Entra ID (added as OIDC IdP in ServiceNow) | **None** (silent SSO) | Yes — per user, native | Already implemented (`oboTokenService.ts`) — set env + flip connector | Add Entra as OIDC provider |
> | **Pattern B — Entra OBO via Okta** | Okta (existing) | **None** (silent SSO) | Yes — per user, native | Reuses the same `oboTokenService.ts` exchange (Okta as the IdP) | None (Okta config only) |
>
> **As deployed (this repo's dev):** Pattern A is **live** on `func-yj453fjwuhph4`.
> The inbound server app (`f99cb568…`, `api://f99cb568…`) OBO-exchanges to the
> already-trusted downstream audience `api://8d73a1f1…/ServiceNow.Use`, which
> ServiceNow's `Entra MCP OBO` OIDC registry validates and maps
> `preferred_username`→`sys_user.email`. Set via `ENTRA_OBO_ENABLED=true` +
> `ENTRA_OBO_DOWNSTREAM_SCOPE`.

---

## Why this matters

Today, when you publish the agent to Teams or Microsoft 365 Copilot, every new user may be hit with a one-time OAuth connection prompt before any tool fires — typical of OAuth connectors that broker per-user sign-in via a PKCE/PRM identity provider.

Both patterns below replace that flow with an **SSO-capable** Entra ID OAuth connector configured with **Enable on-behalf-of login**. Combined with pre-authorizing the host (Teams / M365 Copilot) on the MCP server's Entra app, this eliminates the connection prompt entirely.

---

## What this repo already provides

The MCP server is **already a fully compliant Entra-protected OAuth resource**. The OBO patterns only add a downstream token exchange; nothing about the MCP edge changes.

| Capability | Where it lives | Status |
|---|---|---|
| Bearer token validation on `POST /mcp` | [src/utils/entraAuthMiddleware.ts](../src/utils/entraAuthMiddleware.ts), [src/services/entraTokenValidator.ts](../src/services/entraTokenValidator.ts) | ✅ |
| RFC 8414 / 9728 metadata at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` | [src/functions/oidc.ts](../src/functions/oidc.ts) | ✅ |
| RFC 7591 Dynamic Client Registration at `POST /oauth/register` | [src/functions/oidc.ts](../src/functions/oidc.ts) | ✅ |
| Multi-tenant token acceptance (`ENTRA_TRUSTED_TENANT_IDS`, `ENTRA_ALLOW_ANY_TENANT`) | [src/config.ts](../src/config.ts) | ✅ |
| Custom App ID URIs (`ENTRA_ALLOWED_AUDIENCES`) | [src/config.ts](../src/config.ts) | ✅ |
| `requested_for` attribution from Entra `upn` / `oid` | [src/services/servicenowClient.ts](../src/services/servicenowClient.ts) | ✅ |
| Optional "no fallback to integration user" enforcement (`SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN`) | [src/config.ts](../src/config.ts), [infra/main.bicep](../infra/main.bicep) | ✅ wired (kept `false` in dev so unmapped users still work) |
| Per-user ServiceNow token via `x-servicenow-access-token` header | [src/config.ts](../src/config.ts), [src/services/servicenowClient.ts](../src/services/servicenowClient.ts) | ✅ honored first in the request interceptor |
| **Entra OBO downstream exchange** (Pattern A) | [src/services/oboTokenService.ts](../src/services/oboTokenService.ts) | ✅ **implemented + deployed** (MSAL `acquireTokenOnBehalfOf`, per-user cache, single-flight) |

The OBO downstream exchange is **already implemented** in [src/services/oboTokenService.ts](../src/services/oboTokenService.ts) and invoked from the ServiceNow client's request interceptor ([src/services/servicenowClient.ts](../src/services/servicenowClient.ts)). Enabling either pattern is now **configuration only** — set `ENTRA_OBO_ENABLED=true` and `ENTRA_OBO_DOWNSTREAM_SCOPE`, plus the Entra app permission + the ServiceNow OIDC trust. Everything else — middleware, config, identity extraction, `requested_for`, Bicep parameters — stays as is.

---

## Common foundation for both patterns

Both patterns share the same Entra app layout, connector configuration, and host pre-authorizations. The downstream exchange to ServiceNow is the only divergence.

### Entra ID app registrations (in your home tenant)

You already have one Entra app registration for this server. For SSO-grade OBO, the recommended layout is **two** registrations to follow Microsoft's separation-of-concerns guidance (see [Deploy Azure MCP Server with on-behalf-of authentication](https://learn.microsoft.com/azure/developer/azure-mcp-server/how-to/deploy-remote-mcp-server-on-behalf-of)):

| Registration | Role | Settings |
|---|---|---|
| **Server App** (`ServiceNow MCP Server`) | OAuth 2.0 resource (your Function). This is the audience of incoming user tokens. | Application ID URI: `api://<server-app-id>`. Expose scope: `access_as_user` (delegated, admins+users). Federated credential bound to the Function's User-Assigned Managed Identity (recommended) **or** a client secret. |
| **Client App** (`ServiceNow MCP Connector`) | OAuth client used by the agent host's OAuth connector. | Web platform with the redirect URIs (already in [README.md](../README.md) step 2). Delegated API permission on `api://<server-app-id>/access_as_user`. **Pre-authorized client IDs**: see next section. |

> If you currently have a single combined app, you can keep using it — set its API permissions to pre-authorize *itself* on its own scope. Splitting into two apps is cleaner long-term but not required.

#### Pre-authorize the agent host and Microsoft 365 hosts

On the **Server App**, *Expose an API → Add a client application* and add the first-party app IDs that should be allowed to silently obtain tokens for `access_as_user` without a consent screen:

| First-party host | App ID to pre-authorize |
|---|---|
| Power Platform connector runtime | `7df0a125-d3be-4c96-aa54-591f83ff541c` (Power Apps) |
| Microsoft Teams desktop / web | `1fec8e78-bce4-4aaf-ab1b-5451cc387264` (Teams mobile/desktop) and `5e3ce6c0-2b1f-4285-8d4b-75ee78787346` (Teams web) |
| Microsoft 365 Copilot (web / Office) | `ab9b8c07-8f02-4f72-87fa-80105867a763` (M365 Copilot) |

Plus pre-authorize the **Client App** on the same scope. Grant tenant-wide admin consent for the scope on the Server App so no user-level consent screen appears.

> Exact first-party client IDs evolve; the canonical list lives in Microsoft documentation and the Teams/M365 Copilot manifest reference. Treat the table above as a starting point and verify against your tenant's sign-in logs.

### OAuth connector — security settings

In your agent host's OAuth connector, configure the security settings:

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

> ⚠️ Once you save this, **delete any existing user connections** for this connector. Existing PKCE/PRM-bound connections cannot be migrated; users must let the agent create a fresh, silent connection on next invocation.

### Teams / M365 Copilot manifest (only required for true silent SSO)

For Teams: add a `webApplicationInfo` block to the Teams app manifest with `id = <server-app-id>` and `resource = api://<server-app-id>`. Publish the Teams app to your tenant catalog. This is a prerequisite for SSO.

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
  participant C as Agent host
  participant K as OAuth connector<br/>(Entra OAuth + OBO)
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
  F-->>K-->>C-->>U: Widget (structuredContent) response
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

**Already implemented** — no code change required. The downstream exchange lives in
[src/services/oboTokenService.ts](../src/services/oboTokenService.ts)
(`getDownstreamTokenForCaller`, MSAL `acquireTokenOnBehalfOf` with a per-user
token cache + single-flight guard). The ServiceNow client's request interceptor
([src/services/servicenowClient.ts](../src/services/servicenowClient.ts)) resolves
the per-request bearer in this order:

1. `x-servicenow-access-token` header (explicit caller-provided SN token), then
2. **OBO exchange** of the inbound Entra user token when `ENTRA_OBO_ENABLED=true`
   and `ENTRA_OBO_DOWNSTREAM_SCOPE` is set, then
3. the integration-user password grant (fallback).

```typescript
// src/services/oboTokenService.ts (excerpt)
const result = await msal.acquireTokenOnBehalfOf({
  oboAssertion: req.callerAccessToken,            // inbound user token (aud = server app)
  scopes: [config.entraAuth.oboDownstreamScope],  // e.g. api://<api-app>/ServiceNow.Use
});
```

> ⚠️ **No fallback after a successful exchange.** If the OBO exchange *succeeds*
> but ServiceNow then rejects the token (HTTP 401 — e.g. the user's
> `preferred_username` doesn't match any `sys_user.email`), the tool call fails;
> the integration-user fallback only triggers when the *exchange itself* fails.
> So (a) every agent user's Entra UPN must map to a `sys_user`, and (b) never
> enable OBO before ServiceNow trusts the downstream audience.

**Tip — reuse an existing trusted audience.** You don't have to make ServiceNow
trust the server app directly. If ServiceNow already trusts another Entra app
(an "API"/resource app) for inbound OIDC, point `ENTRA_OBO_DOWNSTREAM_SCOPE` at
*that* app's scope and grant the server app delegated access to it. That's how
this repo's dev is wired: server app `f99cb568…` exchanges to
`api://8d73a1f1…/ServiceNow.Use`, reusing the pre-existing `Entra MCP OBO`
registry — zero new ServiceNow records.

### Trade-offs

| Pros | Cons |
|---|---|
| True per-user ACL enforcement in ServiceNow (no shared service account). | Requires ServiceNow admin to register Entra as an OIDC provider — political/governance hurdle in some orgs. |
| Conditional Access policies apply to the OBO exchange (granular per-resource policies). | User identities in Entra and SN must match deterministically (UPN/email). |
| No integration-user password to rotate. | ServiceNow scoped applications and ACLs must be authored to work with delegated tokens (not just `admin` / `itil` shortcuts). |

---

## Pattern B — Entra OBO with Okta in front of ServiceNow

> ⚠️ **Untested / theoretical.** This pattern has not been implemented or
> validated in this repo. The deployed solution uses **Pattern A** (Entra direct).
> The notes below are a starting point should you ever need Okta as the
> ServiceNow-facing IdP — verify every step against your Okta org before relying
> on it.

**When to choose this**: your enterprise standard is **Okta** as the IdP for SaaS apps including ServiceNow, and you cannot (or don't want to) introduce a second IdP into the ServiceNow trust configuration. This is common in large enterprises where Okta is the corporate identity hub and Microsoft 365 / Entra is downstream.

### Identity flow

```mermaid
sequenceDiagram
  participant U as User (Teams / M365 Copilot)
  participant C as Agent host
  participant K as OAuth connector<br/>(Entra OAuth + OBO)
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
  F-->>K-->>C-->>U: Widget (structuredContent) response
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

In [src/services/oboTokenService.ts](../src/services/oboTokenService.ts), the Okta exchange would replace the Entra `acquireTokenOnBehalfOf` call with an Okta token-exchange request:

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
2. **Stay on the current pattern** — keep the shared ServiceNow integration user, keep `requested_for` attribution from the Entra token (already implemented), and accept the one-time-per-channel "Open connection manager" prompt. Per-user *audit* is preserved; per-user *authorization* is not. This is what the repo does today and the recommended default.

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
9. ☐ In your agent host's OAuth connector, switch to Azure AD with **Enable on-behalf-of login = true** (see table above). Delete and recreate all user connections.
10. ☐ Publish the Teams app manifest with `webApplicationInfo` pointing at the Server App. Verify the silent SSO path with a non-admin test user on Teams desktop and M365 Copilot web.
11. ☐ Update [AGENT_365_BYO_MCP.md](AGENT_365_BYO_MCP.md) registration so the BYO MCP record matches the Server App ID.
12. ☐ Smoke test: `npm run smoke:test` against the deployed endpoint with a real user token; verify Application Insights shows the OBO exchange and the user-scoped ServiceNow call.

---

## Reference docs

- [Deploy Azure MCP Server with on-behalf-of authentication](https://learn.microsoft.com/azure/developer/azure-mcp-server/how-to/deploy-remote-mcp-server-on-behalf-of) — the canonical reference template; this doc adapts the same pattern to a non-Microsoft downstream (ServiceNow / Okta)
- [Conditional Access for agent identities — OBO flow](https://learn.microsoft.com/entra/identity/conditional-access/agent-id#on-behalf-of-obo-flow)
- [Microsoft identity platform — On-behalf-of flow](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-on-behalf-of-flow)
- [RFC 7523 — JWT Profile for OAuth 2.0 Client Authentication and Authorization Grants](https://datatracker.ietf.org/doc/html/rfc7523) (used in Pattern B)
- [Okta — Configure an external OIDC Identity Provider](https://developer.okta.com/docs/concepts/identity-providers/) and [Token exchange grant](https://developer.okta.com/docs/guides/configure-direct-auth-grants/aiyamasi/main/)

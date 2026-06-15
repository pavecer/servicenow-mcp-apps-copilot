import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import axios from "axios";
import crypto from "node:crypto";
import { config } from "../config";
import { buildCorsHeaders } from "../utils/cors";
import { withFunctionContext } from "./wrap";

/**
 * OAuth 2.0 Dynamic Discovery endpoints that enable Copilot Studio's
 * "OAuth 2.0 → Dynamic discovery" MCP authentication type.
 *
 * Two endpoints are exposed:
 *
 *   GET  /.well-known/openid-configuration
 *        OpenID Connect Discovery document pointing at the Entra tenant's
 *        authorization and token endpoints.  Includes a `registration_endpoint`
 *        so Copilot Studio can use Dynamic Client Registration (DCR, RFC 7591).
 *        Falls back gracefully (404) when Entra auth is not configured.
 *        The issuer and endpoint URLs are proxied from Microsoft's real OIDC
 *        discovery document so they stay accurate even when ENTRA_TENANT_ID is
 *        configured as a domain rather than a GUID.
 *        When ENTRA_TRUSTED_TENANT_IDS or ENTRA_ALLOW_ANY_TENANT is set, the
 *        authorization and token endpoints use the /common/ tenant so that users
 *        from any Entra tenant can authenticate (cross-tenant support).
 *
 *   POST /oauth/register
 *        RFC 7591 Dynamic Client Registration endpoint.  Returns the
 *        pre-registered Entra application credentials (client_id + client_secret)
 *        so Copilot Studio's wizard can complete OAuth setup automatically.
 *        Returns 404 when ENTRA_CLIENT_SECRET is not configured (the "Dynamic"
 *        or "Manual" Copilot Studio auth types can be used instead).
 *
 *        SECURITY NOTE: This endpoint is closed by default unless one of these
 *        conditions is met:
 *        - ENTRA_DCR_REGISTRATION_TOKEN is set and provided as
 *          "Authorization: Bearer <token>"
 *        - ENTRA_DCR_ALLOW_UNAUTHENTICATED=true is explicitly set
 *
 *        For enterprise deployments, keep unauthenticated DCR disabled and use
 *        registration tokens, network restrictions (private networking), and/or
 *        manual OAuth configuration in Copilot Studio.
 *
 * CORS: All endpoints include Access-Control-Allow-Origin: * headers and handle
 * OPTIONS preflight requests so that browser-based clients (including Copilot
 * Studio) can reach them from any origin without being blocked.
 */

const OIDC_CACHE_MAX_AGE_SECONDS = 3600; // 1 hour
const MS_METADATA_CACHE_TTL_MS = OIDC_CACHE_MAX_AGE_SECONDS * 1_000;

// CORS headers included on every OIDC response so that browser-based clients
// (including Microsoft Copilot Studio) can reach these endpoints cross-origin.
// Implemented via the shared helper in src/utils/cors.ts.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MsOidcMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
}

interface MsMetadataCache {
  metadata: MsOidcMetadata;
  expiresAtMs: number;
}

// Module-level cache so repeated discovery requests reuse the same metadata.
const msMetadataCache = new Map<string, MsMetadataCache>();

/**
 * Returns the scopes that this server advertises in OIDC discovery and DCR.
 *
 * Default (when ENTRA_OAUTH_SCOPES is not set and clientId is known):
 *   api://<clientId>/access_as_user  openid  profile  offline_access
 *
 * - `api://<clientId>/access_as_user` is the correct v2 delegated scope that
 *   makes Power Platform request a token for THIS API specifically, not for
 *   Microsoft Graph. Tokens issued with this scope have aud=api://<clientId>
 *   which our validator accepts.
 * - `offline_access` is mandatory for stable refresh-token issuance. Without
 *   it Power Platform cannot silently refresh and connections go stale.
 * - `openid` and `profile` are always enforced even if omitted in overrides.
 *
 * Override via ENTRA_OAUTH_SCOPES env var (space-delimited).
 */
function getAdvertisedOAuthScopes(clientId?: string): string[] {
  const configured = (config.entraAuth.oauthScopes ?? "").trim();
  const defaultScopes = clientId
    ? [`api://${clientId}/access_as_user`, "openid", "profile", "offline_access"]
    : ["openid", "profile", "offline_access"];
  const scopes = (configured ? configured : defaultScopes.join(" "))
    .split(/\s+/)
    .map(scope => scope.trim())
    .filter(Boolean);

  const normalized = new Set(scopes);
  normalized.add("openid");
  normalized.add("offline_access");
  return Array.from(normalized);
}

/**
 * Fetches real endpoint URLs from Microsoft's OIDC discovery document so the
 * issuer in our discovery doc matches the iss claim in actual tokens — which is
 * always GUID-based even when ENTRA_TENANT_ID is configured as a domain.
 * Results are cached for OIDC_CACHE_MAX_AGE_SECONDS to avoid repeated fetches.
 * Falls back to an empty object on fetch failure.
 */
async function fetchMsOidcMetadata(tenantId: string): Promise<MsOidcMetadata> {
  const now = Date.now();
  const cached = msMetadataCache.get(tenantId);
  if (cached && now < cached.expiresAtMs) {
    return cached.metadata;
  }

  const metadataUrl = `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`;
  try {
    const { data } = await axios.get<MsOidcMetadata>(metadataUrl, { timeout: 5_000 });
    msMetadataCache.set(tenantId, { metadata: data, expiresAtMs: now + MS_METADATA_CACHE_TTL_MS });
    return data;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// /.well-known/openid-configuration
// ---------------------------------------------------------------------------

async function oidcDiscoveryHandler(
  request: HttpRequest,
  _context: InvocationContext
): Promise<HttpResponseInit> {
  const { tenantId, clientId } = config.entraAuth;

  if (!tenantId || !clientId) {
    const corsHeaders = buildCorsHeaders(request.headers.get("origin"));
    return {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders },
      body: JSON.stringify({ error: "Entra ID is not configured on this server" })
    };
  }

  // Derive the base URL of this server from the incoming request so the
  // registration_endpoint URL is correct regardless of deployment host.
  const requestUrl = new URL(request.url);
  const serverBase = `${requestUrl.protocol}//${requestUrl.host}`;

  // For cross-tenant scenarios (Copilot Studio in a different Entra tenant), all
  // OIDC document values — issuer, authorization_endpoint, token_endpoint, and
  // jwks_uri — must be sourced from Microsoft's /common metadata rather than the
  // primary tenant's.  The /common issuer is "https://login.microsoftonline.com/
  // {tenantid}/v2.0" (literal template placeholder), which OIDC clients use to
  // accept tokens from any tenant while still validating the iss claim in each
  // individual token.  Without this, a token issued to a user in Tenant B carries
  // an iss that doesn't match the Tenant A issuer in the discovery doc.
  const trustedRemoteTenantIds = (config.entraAuth.trustedTenantIds ?? []).filter(
    tid => Boolean(tid) && tid !== tenantId
  );
  const isCrossTenant = config.entraAuth.allowAnyTenant || trustedRemoteTenantIds.length > 0;

  // Fetch real endpoint URLs from Microsoft so values are always accurate.
  // In cross-tenant mode use the /common endpoint so all fields are consistent.
  const msMetadataTenant = isCrossTenant ? "common" : tenantId;
  const msMetadata = await fetchMsOidcMetadata(msMetadataTenant);

  const issuerBase =
    msMetadata.issuer ??
    (isCrossTenant
      ? "https://login.microsoftonline.com/{tenantid}/v2.0"
      : `https://login.microsoftonline.com/${tenantId}/v2.0`);

  const authorizationEndpoint =
    msMetadata.authorization_endpoint ??
    (isCrossTenant
      ? "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
      : `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);

  const tokenEndpoint =
    msMetadata.token_endpoint ??
    (isCrossTenant
      ? "https://login.microsoftonline.com/common/oauth2/v2.0/token"
      : `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`);

  const jwksUri =
    msMetadata.jwks_uri ??
    (isCrossTenant
      ? "https://login.microsoftonline.com/common/discovery/v2.0/keys"
      : `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`);

  const oauthScopes = getAdvertisedOAuthScopes(clientId);

  const discoveryDoc = {
    issuer: issuerBase,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    jwks_uri: jwksUri,
    userinfo_endpoint: "https://graph.microsoft.com/oidc/userinfo",
    // DCR endpoint: present only when the client secret is configured
    ...(config.entraAuth.clientSecret
      ? { registration_endpoint: `${serverBase}/oauth/register` }
      : {}),
    scopes_supported: oauthScopes,
    response_types_supported: ["code"],
    response_modes_supported: ["query", "fragment"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    subject_types_supported: ["pairwise"],
    id_token_signing_alg_values_supported: ["RS256"],
    claims_supported: [
      "sub", "iss", "aud", "exp", "iat", "auth_time",
      "oid", "tid", "name", "preferred_username", "email"
    ]
  };

  return {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // Allow browsers / clients to cache the discovery document.
      "Cache-Control": `public, max-age=${OIDC_CACHE_MAX_AGE_SECONDS}`,
      ...buildCorsHeaders(request.headers.get("origin"))
    },
    body: JSON.stringify(discoveryDoc)
  };
}

app.http("oidc-discovery", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: ".well-known/openid-configuration",
  handler: withFunctionContext(oidcDiscoveryHandler)
});

// CORS preflight for the OIDC discovery endpoint.
app.http("oidc-discovery-options", {
  methods: ["OPTIONS"],
  authLevel: "anonymous",
  route: ".well-known/openid-configuration",
  handler: withFunctionContext(async (request): Promise<HttpResponseInit> => ({
    status: 204,
    headers: buildCorsHeaders(request.headers.get("origin"))
  }))
});

// ---------------------------------------------------------------------------
// /.well-known/oauth-authorization-server  — RFC 8414 alias
// ---------------------------------------------------------------------------
// Some MCP clients (including Copilot Studio) try this path before the
// OIDC well-known path.  Serve the same discovery document for compatibility.
app.http("oauth-authorization-server", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: ".well-known/oauth-authorization-server",
  handler: withFunctionContext(oidcDiscoveryHandler)
});

app.http("oauth-authorization-server-options", {
  methods: ["OPTIONS"],
  authLevel: "anonymous",
  route: ".well-known/oauth-authorization-server",
  handler: withFunctionContext(async (request): Promise<HttpResponseInit> => ({
    status: 204,
    headers: buildCorsHeaders(request.headers.get("origin"))
  }))
});

// ---------------------------------------------------------------------------
// /.well-known/oauth-protected-resource  — RFC 9728
// ---------------------------------------------------------------------------
// OAuth 2.0 Protected Resource Metadata document.  MCP clients use this to
// locate the authorization server for this resource (the MCP server).
// Reference: https://datatracker.ietf.org/doc/rfc9728/
async function oauthProtectedResourceHandler(
  request: HttpRequest,
  _context: InvocationContext
): Promise<HttpResponseInit> {
  const { tenantId, clientId } = config.entraAuth;

  if (!tenantId || !clientId) {
    const corsHeaders = buildCorsHeaders(request.headers.get("origin"));
    return {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders },
      body: JSON.stringify({ error: "Entra ID is not configured on this server" })
    };
  }

  const requestUrl = new URL(request.url);
  const serverBase = `${requestUrl.protocol}//${requestUrl.host}`;
  const mcpResourceUrl = `${serverBase}/mcp`;

  const metadata = {
    resource: mcpResourceUrl,
    authorization_servers: [serverBase],
    bearer_methods_supported: ["header"],
    scopes_supported: getAdvertisedOAuthScopes(clientId),
    resource_documentation: `${serverBase}/.well-known/openid-configuration`
  };

  return {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${OIDC_CACHE_MAX_AGE_SECONDS}`,
      ...buildCorsHeaders(request.headers.get("origin"))
    },
    body: JSON.stringify(metadata)
  };
}

app.http("oauth-protected-resource", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: ".well-known/oauth-protected-resource",
  handler: withFunctionContext(oauthProtectedResourceHandler)
});

app.http("oauth-protected-resource-options", {
  methods: ["OPTIONS"],
  authLevel: "anonymous",
  route: ".well-known/oauth-protected-resource",
  handler: withFunctionContext(async (request): Promise<HttpResponseInit> => ({
    status: 204,
    headers: buildCorsHeaders(request.headers.get("origin"))
  }))
});

// ---------------------------------------------------------------------------
// /oauth/register  — RFC 7591 Dynamic Client Registration
// ---------------------------------------------------------------------------

export async function oauthRegisterHandler(
  request: HttpRequest,
  _context: InvocationContext
): Promise<HttpResponseInit> {
  const { clientId, clientSecret, dcrRegistrationToken } = config.entraAuth;
  const corsHeaders = buildCorsHeaders(request.headers.get("origin"));

  if (!clientId || !clientSecret) {
    return {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders },
      body: JSON.stringify({
        error: "invalid_client_metadata",
        error_description:
          "Dynamic Client Registration is not enabled on this server. " +
          "Use 'Dynamic' or 'Manual' OAuth type in Copilot Studio and provide " +
          "the Entra application credentials manually."
      })
    };
  }

  // Secure-by-default policy: do not allow unauthenticated registration unless explicitly enabled.
  if (!dcrRegistrationToken && !config.entraAuth.dcrAllowUnauthenticated) {
    return {
      status: 403,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders
      },
      body: JSON.stringify({
        error: "access_denied",
        error_description:
          "Dynamic Client Registration is disabled without a registration token. " +
          "Set ENTRA_DCR_REGISTRATION_TOKEN or explicitly set ENTRA_DCR_ALLOW_UNAUTHENTICATED=true."
      })
    };
  }

  // When ENTRA_DCR_REGISTRATION_TOKEN is configured, require an RFC 7591
  // initial access token in the Authorization header before returning credentials.
  // Use constant-time comparison to prevent timing-based token inference.
  if (dcrRegistrationToken) {
    const authHeader = request.headers.get("authorization") ?? "";
    const presentedToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const expected = Buffer.from(dcrRegistrationToken, "utf8");
    const presented = Buffer.from(presentedToken, "utf8");
    const tokenValid =
      expected.length === presented.length &&
      crypto.timingSafeEqual(expected, presented);
    if (!tokenValid) {
      return {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": 'Bearer realm="oauth-register"',
          ...corsHeaders
        },
        body: JSON.stringify({
          error: "unauthorized",
          error_description:
            "A valid registration access token is required. " +
            "Set ENTRA_DCR_REGISTRATION_TOKEN and pass it as 'Authorization: Bearer <token>'."
        })
      };
    }
  }

  // Return the pre-registered Entra application credentials.
  // Copilot Studio stores these and uses them for the Authorization Code flow.
  const registrationResponse = {
    client_id: clientId,
    client_secret: clientSecret,
    client_id_issued_at: Math.floor(Date.now() / 1_000),
    // 0 = non-expiring (the Entra app registration controls the actual lifetime)
    client_secret_expires_at: 0,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
    scope: getAdvertisedOAuthScopes(clientId).join(" ")
  };

  return {
    status: 201,
    headers: { "Content-Type": "application/json", ...corsHeaders },
    body: JSON.stringify(registrationResponse)
  };
}

app.http("oauth-register", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "oauth/register",
  handler: withFunctionContext(oauthRegisterHandler)
});

// Some OAuth clients probe the DCR endpoint with GET before issuing POST.
// Return a lightweight capability document instead of 404 for compatibility.
app.http("oauth-register-get", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "oauth/register",
  handler: withFunctionContext(async (request): Promise<HttpResponseInit> => ({
    status: 200,
    headers: { "Content-Type": "application/json", ...buildCorsHeaders(request.headers.get("origin")) },
    body: JSON.stringify({
      registration_endpoint: "/oauth/register",
      registration_policy: "post-required"
    })
  }))
});

// CORS preflight for the DCR endpoint.
app.http("oauth-register-options", {
  methods: ["OPTIONS"],
  authLevel: "anonymous",
  route: "oauth/register",
  handler: withFunctionContext(async (request): Promise<HttpResponseInit> => ({
    status: 204,
    headers: buildCorsHeaders(request.headers.get("origin"))
  }))
});

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  serviceNow: {
    instanceUrl: getRequiredEnv("SERVICENOW_INSTANCE_URL"),
    clientId: getRequiredEnv("SERVICENOW_CLIENT_ID"),
    clientSecret: getRequiredEnv("SERVICENOW_CLIENT_SECRET"),
    username: process.env.SERVICENOW_USERNAME,
    password: process.env.SERVICENOW_PASSWORD,
    tokenPath: process.env.SERVICENOW_OAUTH_TOKEN_PATH || "/oauth_token.do",
    tokenAuthStyle: process.env.SERVICENOW_OAUTH_CLIENT_AUTH_STYLE || "auto",
    grantType: process.env.SERVICENOW_OAUTH_GRANT_TYPE || "auto",
    requestedForLookupFields: process.env.SERVICENOW_REQUESTED_FOR_LOOKUP_FIELDS
      ? process.env.SERVICENOW_REQUESTED_FOR_LOOKUP_FIELDS.split(",").map(v => v.trim()).filter(Boolean)
      : ["email", "user_name"],
    requestedForCallerFields: process.env.SERVICENOW_REQUESTED_FOR_CALLER_FIELDS
      ? process.env.SERVICENOW_REQUESTED_FOR_CALLER_FIELDS.split(",").map(v => v.trim()).filter(Boolean)
      : ["callerUpn"],
    requestedForFallbackToCallerValue: process.env.SERVICENOW_REQUESTED_FOR_FALLBACK_TO_CALLER_VALUE !== "false",
    requestedForDiagnosticsEnabled: process.env.SERVICENOW_REQUESTED_FOR_DIAGNOSTICS === "true",
    // When false (default), requested_for diagnostics never include caller PII.
    // Set true only for short-lived troubleshooting in a controlled environment.
    requestedForDiagnosticsIncludePii: process.env.SERVICENOW_REQUESTED_FOR_DIAGNOSTICS_INCLUDE_PII === "true",
    // When true, all ServiceNow API calls must use a caller-provided ServiceNow
    // bearer token (x-servicenow-access-token). This enforces ServiceNow ACLs for
    // each end user and prevents fallback to a shared integration identity.
    requireCallerAccessToken: process.env.SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN === "true",
    // When true (default), after an order is placed under the shared integration
    // identity the server patches `opened_by` and `requested_by` on the created
    // sc_request (and its sc_req_item rows) to the real ordering user. Without
    // this, ServiceNow stamps `opened_by` with whoever authenticated the REST
    // call — the integration user — so the record shows "Opened by: System
    // Administrator" instead of the person who placed the order. Set to "false"
    // to disable (e.g. if the integration user lacks write access to opened_by).
    attributeOwnershipToCaller: process.env.SERVICENOW_ATTRIBUTE_OWNERSHIP_TO_CALLER !== "false"
  },

  // Microsoft Entra ID (Azure AD) OAuth 2.0 settings.
  // When ENTRA_TENANT_ID and ENTRA_CLIENT_ID are set the MCP endpoint requires
  // a valid Entra Bearer token on every request. Set ENTRA_AUTH_DISABLED=true
  // to skip validation during local development.
  //
  // For cross-tenant scenarios (the calling agent host signs in users in a
  // different tenant than the Azure Function):
  // - Sets Entra app to multi-tenant (signInAudience: AzureADMultipleOrgs) in portal
  // - Obtain admin consent in remote tenant
  // - Set ENTRA_TRUSTED_TENANT_IDS to comma-separated list of allowed remote tenant GUIDs
  // - Or set ENTRA_ALLOW_ANY_TENANT=true to accept any Microsoft tenant (use with caution)
  entraAuth: {
    tenantId: process.env.ENTRA_TENANT_ID,
    clientId: process.env.ENTRA_CLIENT_ID,
    // Used in the DCR response so an MCP client can use the auth code flow.
    clientSecret: process.env.ENTRA_CLIENT_SECRET,
    // Optional RFC 7591 "initial access token" that must be presented as
    // "Authorization: Bearer <token>" when calling POST /oauth/register.
    // When unset the endpoint is open (required for automated DCR clients).
    dcrRegistrationToken: process.env.ENTRA_DCR_REGISTRATION_TOKEN,
    // Keep DCR closed by default when no registration token is configured.
    // Set ENTRA_DCR_ALLOW_UNAUTHENTICATED=true only if you explicitly require
    // unauthenticated dynamic client registration for your client onboarding flow.
    dcrAllowUnauthenticated: process.env.ENTRA_DCR_ALLOW_UNAUTHENTICATED === "true",
    // Expected audience in the Bearer token. Defaults to the Entra client ID.
    // Override to "api://<clientId>" when the app exposes a custom App ID URI.
    audience: process.env.ENTRA_AUDIENCE,
    // Space-delimited OAuth scopes advertised in OIDC discovery and DCR output.
    // Must contain delegated scopes (v2 style) and should include offline_access
    // to allow stable refresh token behavior in Power Platform connectors.
    // Example: "openid profile offline_access User.Read"
    oauthScopes: process.env.ENTRA_OAUTH_SCOPES,
    // Set to "true" to bypass Bearer token validation (local dev / smoke tests).
    disabled: process.env.ENTRA_AUTH_DISABLED === "true",
    // For cross-tenant scenarios: comma-separated list of trusted remote tenant GUIDs
    // Tokens from these tenants will be accepted. Empty/unset = only primary tenant.
    trustedTenantIds: process.env.ENTRA_TRUSTED_TENANT_IDS
      ? process.env.ENTRA_TRUSTED_TENANT_IDS.split(",").map(t => t.trim()).filter(Boolean)
      : [],
    // For cross-tenant scenarios: set to "true" to accept tokens from ANY Microsoft tenant.
    // ⚠️  Use caution: this creates an open OAuth endpoint. Verify via audience validation
    // and request identifiers that the caller is authorized before giving access to data.
    allowAnyTenant: process.env.ENTRA_ALLOW_ANY_TENANT === "true",
    // Additional accepted audience values beyond the auto-derived GUID and api://<clientId>.
    // Comma-separated list. Use when your app has a custom App ID URI or non-standard audience.
    allowedAudiences: process.env.ENTRA_ALLOWED_AUDIENCES
      ? process.env.ENTRA_ALLOWED_AUDIENCES.split(",").map(a => a.trim()).filter(Boolean)
      : [],
    // On-Behalf-Of (OBO) token exchange (Pattern A in docs/AUTH_ENTRA_OBO_OKTA.md).
    // When true, the inbound user Entra Bearer token is exchanged via MSAL
    // `acquireTokenOnBehalfOf` for a downstream token whose audience ServiceNow
    // accepts (ServiceNow must be configured with Entra ID as an OIDC provider).
    // Default false keeps the existing integration-user grant path unchanged.
    oboEnabled: process.env.ENTRA_OBO_ENABLED === "true",
    // Downstream scope requested in the OBO exchange. Typical values:
    //   api://<server-app-id>/ServiceNow.Use
    //   api://<server-app-id>/.default
    // Required when oboEnabled is true.
    oboDownstreamScope: process.env.ENTRA_OBO_DOWNSTREAM_SCOPE
  },

  http: {
    // Comma-separated CORS allowlist for API/browser endpoints.
    // Empty means no explicit browser origins are allowed.
    corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS
      ? process.env.CORS_ALLOWED_ORIGINS.split(",").map(v => v.trim()).filter(Boolean)
      : []
  },

  // Microsoft 365 Copilot "MCP Apps" (SEP-1865) widget rendering.
  // This server always targets the MCP Apps surface:
  //   - Registers `ui://` HTML resources via `resources/read` with mime type
  //     `text/html;profile=mcp-app`.
  //   - Decorates widget-backed tools in `tools/list` with `_meta.ui.resourceUri`.
  //   - Emits compact `structuredContent` so the widget can render immediately
  //     on tool result.
  mcpApps: {
    // Optional: the public origin where this MCP server is reachable from the
    // M365 Copilot widget host. Documentation only — not consumed by any
    // runtime code path. Pair with https://aka.ms/mcpwidgeturlgenerator if
    // you need to register CORS or validDomains externally.
    publicOrigin: process.env.MCP_APPS_PUBLIC_ORIGIN
  }
};

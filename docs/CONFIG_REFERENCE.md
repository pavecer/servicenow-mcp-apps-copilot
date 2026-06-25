# Environment Variables Reference

All configuration is managed via environment variables. Secrets are stored in Azure Key Vault and read by the Function App via managed identity.

## Required Settings

### ServiceNow Connection

| Variable | Description |
|----------|-------------|
| `SERVICENOW_INSTANCE_URL` | ServiceNow base URL (e.g., `https://instance.service-now.com`) |
| `SERVICENOW_CLIENT_ID` | OAuth App Registry client ID (from ServiceNow setup) |
| `SERVICENOW_CLIENT_SECRET` | OAuth App Registry client secret |
| `SERVICENOW_USERNAME` | Integration user login (must have `catalog` role) |
| `SERVICENOW_PASSWORD` | Integration user password |

### Entra ID Configuration

| Variable | Description |
|----------|-------------|
| `ENTRA_TENANT_ID` | Entra directory (tenant) ID |
| `ENTRA_CLIENT_ID` | App registration client ID (from Entra setup) |
| `ENTRA_CLIENT_SECRET` | App registration client secret |
| `ENTRA_AUDIENCE` | Expected `aud` claim in tokens; defaults to `api://<ENTRA_CLIENT_ID>` |

## Optional Settings

### Entra Auth

| Variable | Default | Description |
|----------|---------|-------------|
| `ENTRA_AUTH_DISABLED` | `false` | **Dev only**: skip Bearer validation. Never use in production. |
| `ENTRA_OAUTH_SCOPES` | `api://<ENTRA_CLIENT_ID>/access_as_user openid profile offline_access` | Scopes advertised in OIDC discovery |
| `ENTRA_TRUSTED_TENANT_IDS` | _(empty)_ | Comma-separated tenant IDs to trust (multi-tenant scenarios) |
| `ENTRA_ALLOW_ANY_TENANT` | `false` | Accept any Microsoft tenant's tokens (use with caution) |
| `ENTRA_ALLOWED_AUDIENCES` | _(empty)_ | Comma-separated extra `aud` values to accept (custom App ID URIs) |

### Dynamic Client Registration (DCR)

| Variable | Default | Description |
|----------|---------|-------------|
| `ENTRA_DCR_REGISTRATION_TOKEN` | _(unset)_ | Bearer token required on `POST /oauth/register` for security |
| `ENTRA_DCR_ALLOW_UNAUTHENTICATED` | `false` | Allow anonymous DCR (not recommended for enterprise) |

### ServiceNow OAuth & Identity

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVICENOW_OAUTH_TOKEN_PATH` | `/oauth_token.do` | ServiceNow token endpoint path |
| `SERVICENOW_OAUTH_GRANT_TYPE` | `auto` | Override grant type: `password` or `client_credentials` |
| `SERVICENOW_OAUTH_CLIENT_AUTH_STYLE` | `auto` | OAuth client auth style: `request_body` or `basic` |
| `SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN` | `false` | Require per-user ServiceNow access token on each request |
| `SERVICENOW_ATTRIBUTE_OWNERSHIP_TO_CALLER` | `true` | Patch `opened_by`/`requested_by` with real user after order placement. Set `false` if integration user lacks write access. |
| `SERVICENOW_REQUESTED_FOR_LOOKUP_FIELDS` | `email,user_name` | Comma-separated `sys_user` fields to search for caller identity |
| `SERVICENOW_REQUESTED_FOR_CALLER_FIELDS` | `callerUpn` | Entra token claims to use for identity matching |
| `SERVICENOW_REQUESTED_FOR_FALLBACK_TO_CALLER_VALUE` | `true` | Fall back to UPN if no `sys_user` match found |
| `SERVICENOW_REQUESTED_FOR_DIAGNOSTICS` | `false` | Include identity-resolution diagnostics in responses |
| `SERVICENOW_REQUESTED_FOR_DIAGNOSTICS_INCLUDE_PII` | `false` | Include raw caller identifiers in diagnostics (short-lived troubleshooting only) |

### On-Behalf-Of (OBO) Token Exchange

See [AUTH_ENTRA_OBO.md](AUTH_ENTRA_OBO.md) for detailed setup.

| Variable | Default | Description |
|----------|---------|-------------|
| `ENTRA_OBO_ENABLED` | `false` | Exchange inbound user token for downstream ServiceNow token via MSAL OBO |
| `ENTRA_OBO_DOWNSTREAM_SCOPE` | _(unset)_ | Downstream scope for OBO exchange (e.g., `api://<app-id>/.default`). Required when `ENTRA_OBO_ENABLED=true` |

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Minimum log level: `debug`, `info`, `warn`, or `error` |
| `LOG_INCLUDE_CALLER_IDENTITY` | `false` | Include caller `oid`/`upn` in every log (PII). Default off. |
| `LOG_INCLUDE_ERROR_STACK` | `false` | Include error stack traces in error logs |

### CORS & HTTP

| Variable | Default | Description |
|----------|---------|-------------|
| `CORS_ALLOWED_ORIGINS` | _(empty)_ | Comma-separated browser origins for CORS (e.g., `https://example.com,https://another.com`) |

### Microsoft 365 Copilot MCP Apps (SEP-1865)

MCP Apps is always on: the server registers `ui://servicenow-mcp/*.html`
resources and decorates widget-backed tool responses with `_meta.ui` and
compact `structuredContent`. There is no enable/disable flag.

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_APPS_PUBLIC_ORIGIN` | _(unset)_ | Public origin where this server is reachable (documentation only, not used at runtime) |

## Setting Variables

### Local Development

Edit `local.settings.json` after copying from `local.settings.sample.json`:

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "SERVICENOW_INSTANCE_URL": "https://instance.service-now.com",
    "SERVICENOW_CLIENT_ID": "YOUR_CLIENT_ID",
    "SERVICENOW_CLIENT_SECRET": "YOUR_CLIENT_SECRET",
    "SERVICENOW_USERNAME": "integration_user",
    "SERVICENOW_PASSWORD": "integration_password",
    "ENTRA_TENANT_ID": "YOUR_TENANT_ID",
    "ENTRA_CLIENT_ID": "YOUR_ENTRA_APP_ID",
    "ENTRA_CLIENT_SECRET": "YOUR_ENTRA_SECRET",
    "ENTRA_AUTH_DISABLED": "true",
    "LOG_LEVEL": "debug"
  }
}
```

### Azure Function App (Portal)

1. Go to **Function App > Settings > Environment variables**
2. Add each variable individually
3. Secrets should go to **Key Vault** and referenced via **Managed Identity**

### Azure Developer CLI (azd)

```bash
azd env set SERVICENOW_INSTANCE_URL "https://instance.service-now.com"
azd env set SERVICENOW_CLIENT_ID "YOUR_CLIENT_ID"
# ... set all required variables
azd up
```

## Security Best Practices

- **Never commit `local.settings.json`** — it's in `.gitignore` for a reason
- **Never set `ENTRA_AUTH_DISABLED=true`** in production
- **Secure Dynamic Client Registration** — always set `ENTRA_DCR_REGISTRATION_TOKEN` in enterprise
- **Keep `ENTRA_DCR_ALLOW_UNAUTHENTICATED=false`** unless intentional
- **Disable PII diagnostics** — keep `SERVICENOW_REQUESTED_FOR_DIAGNOSTICS_INCLUDE_PII=false` unless actively troubleshooting
- **Prefer per-user ACLs** — use `SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN=true` when policy demands user-level enforcement (see [AUTH_ENTRA_OBO.md](AUTH_ENTRA_OBO.md))
- **Use Key Vault** — store all secrets there and read via managed identity, never in plaintext

## Troubleshooting Config Issues

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common configuration problems and solutions.

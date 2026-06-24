# Troubleshooting Guide

## Deployment Issues

### `azd up` fails with "Resource creation timeout"

**Symptom:** Deployment hangs or times out during resource provisioning.

**Solution:**
1. Check your Azure subscription quotas: `az vm list-usage --location <region>`
2. Verify you have permissions to create Function Apps, Key Vault, App Insights
3. Try a different Azure region
4. Check [Azure status page](https://status.azure.com/) for service issues

---

### "Insufficient permissions" error

**Symptom:** `az` or `azd` commands fail with permission errors.

**Solution:**
1. Ensure you're logged in: `az account show`
2. Verify you have the right subscription: `az account list`
3. Switch if needed: `az account set --subscription <subscription-id>`
4. Ask your admin to grant **Contributor** or **Owner** role on the subscription

---

## Authentication & Auth Errors

### 401 on MCP endpoint

**Symptom:** MCP requests return `401 Unauthorized`.

**Causes:**
- Entra Bearer token is missing or invalid
- Token claims don't match expected audience

**Local dev workaround:**
```json
{
  "Values": {
    "ENTRA_AUTH_DISABLED": "true"
  }
}
```
Then restart the server. **Never use this in production.**

**Deployed fix:**
1. Ensure the client is sending a valid Bearer token:
   ```bash
   az account get-access-token --resource api://<ENTRA_CLIENT_ID> --query accessToken -o tsv
   ```
2. Verify `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID` are set on the Function App
3. Check Application Insights for auth middleware logs

---

### "Failed to validate audience"

**Symptom:** Deployment or token validation fails with audience mismatch.

**Causes:**
- `ENTRA_AUDIENCE` or `ENTRA_CLIENT_ID` is wrong
- Entra app registration App ID URI doesn't match

**Solution:**
1. Get your app's ID URI from [Azure Portal](https://portal.azure.com):
   - Go to **Entra ID > App registrations > your app > Expose an API**
   - Copy the **Application ID URI**
2. Set `ENTRA_AUDIENCE` on the Function App to that URI
3. Ensure tokens are requested with the same scope

---

### Dynamic discovery fails in MCP client (Power Platform, etc.)

**Symptom:** "Cannot reach OIDC endpoint" or "Unknown server config".

**Causes:**
- OIDC discovery endpoint (`.well-known/openid-configuration`) is unreachable
- Entra credentials are invalid
- MCP client cached stale metadata

**Solution:**
1. Verify OIDC discovery works:
   ```bash
   curl https://<function-app>.azurewebsites.net/.well-known/openid-configuration
   ```
   Should return JSON with `issuer`, `authorization_endpoint`, etc.

2. Verify `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID` are set

3. In Power Platform or the MCP client, **delete and re-add the connection** — it caches metadata on first connect

---

## ServiceNow Connectivity Issues

### "Failed to get OAuth token" / ServiceNow 401

**Symptom:** ServiceNow API calls fail with 401 or "Bad credentials".

**Causes:**
- ServiceNow client ID / secret is wrong
- Integration user password is expired or wrong
- OAuth app is disabled in ServiceNow

**Solution:**
1. Re-run the setup script:
   ```powershell
   pwsh -File scripts/setup-servicenow.ps1 -InstanceUrl https://<instance>.service-now.com -AdminUser <user> -AdminPassword <pass>
   ```

2. Manually verify in ServiceNow:
   - **System OAuth > Application Registry** — find your app, copy Client ID
   - **System Security > Users** — verify integration user exists and password hasn't expired
   - Integration user needs **catalog** role (at minimum)

3. Test locally with direct probe:
   ```bash
   npm run sn:local -- validate
   ```

---

### Orders created but `requested_for` is wrong

**Symptom:** Orders are placed, but the user identity is stamped as the integration user instead of the real caller.

**Causes:**
- Integration user lacks write permission on `opened_by`/`requested_by`
- Caller's Entra email doesn't match any `sys_user.email` or `sys_user.user_name`
- `SERVICENOW_ATTRIBUTE_OWNERSHIP_TO_CALLER` is set to `false`

**Solution:**
1. **Grant permissions** on the integration user in ServiceNow:
   - Go to **Users** and select the integration user
   - Ensure they have **read+write** on `sc_request` and `sc_req_item` tables
   - Ensure they have **read** on `sys_user`

2. **Check caller matching**:
   - Enable diagnostics:
     ```json
     {
       "Values": {
         "SERVICENOW_REQUESTED_FOR_DIAGNOSTICS": "true",
         "SERVICENOW_REQUESTED_FOR_DIAGNOSTICS_INCLUDE_PII": "true"
       }
     }
     ```
   - Make an order and check Application Insights logs for the `requested_for` resolution details

3. **Verify email matching**:
   - Ensure the Entra user's email matches their `sys_user.email` or `sys_user.user_name` in ServiceNow
   - Example: if Entra says `alice@contoso.com`, ServiceNow must have a user with `email = alice@contoso.com`

4. If still failing, set `SERVICENOW_ATTRIBUTE_OWNERSHIP_TO_CALLER=false` as a workaround (not ideal)

---

## MCP & Widget Issues

### MCP client can't call tools

**Symptom:** MCP client connects but `tools/call` returns errors.

**Causes:**
- Tool definition doesn't match implementation
- Missing required environment variables
- ServiceNow connection is broken

**Solution:**
1. Verify MCP discovery works:
   ```bash
   curl -H "Authorization: Bearer <token>" \
     https://<function-app>.azurewebsites.net/mcp \
     -X POST \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

2. Check Application Insights for errors:
   - Go to **Function App > Application Insights > Logs**
   - Run:
     ```kusto
     traces | where message contains "ERROR" | take 20
     ```

3. Test locally first:
   ```bash
   npm run smoke:test
   ```

---

### Widgets don't render in Microsoft 365 Copilot

**Symptom:** Tools work but widgets appear as plain text (not interactive cards).

**Causes:**
- The declarative agent isn't sideloaded, or the host isn't an MCP Apps host
- Widget HTML files weren't regenerated during build
- Browser doesn't support the widget sandbox

**Solution:**
1. **Confirm the agent + host**:
   - Sideload the [`m365-agent/`](../m365-agent/README.md) package and use an
     MCP Apps host (Microsoft 365 Copilot / Cowork)

2. **Verify widgets are registered**:
   ```bash
   curl -H "Authorization: Bearer <token>" \
     https://<function-app>.azurewebsites.net/mcp \
     -X POST \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"resources/list"}'
   ```
   Should return entries like `ui://servicenow-mcp/catalog-browse.html`

3. **Rebuild widgets** (if you edited them locally):
   ```bash
   npm run build
   npm run start:dev  # or redeploy to Azure
   ```

4. In Microsoft 365 Copilot, **refresh the agent** — the UI caches widget definitions

---

## Logging & Diagnostics

### Application Insights shows no logs

**Symptom:** Function App runs but no traces appear in Application Insights.

**Causes:**
- Application Insights isn't configured
- Logs aren't being sent (network issue, disabled)
- Filter is too strict

**Solution:**
1. Verify Application Insights is linked:
   - **Function App > Settings > Application Insights > Connected to...**
   - Should show an AI instance name

2. Check logs:
   - **Application Insights > Logs > traces**
   - Run: `traces | take 50`

3. Enable verbose logging locally:
   ```json
   {
     "Values": {
       "LOG_LEVEL": "debug",
       "LOG_INCLUDE_CALLER_IDENTITY": "true"
     }
   }
   ```

---

## Performance & Cost Issues

### Function App is slow or timing out

**Symptom:** MCP requests are slow or hit timeout (230 seconds).

**Causes:**
- Flex Consumption SKU is underpowered
- ServiceNow queries are slow
- Cold start overhead

**Solution:**
1. Check Application Insights for slow requests:
   - **Application Insights > Performance**
   - Look for slow `requests` with long duration

2. Upgrade to Premium SKU:
   - Go to **Function App > App Service plan > Pricing tier**
   - Consider **Premium 1 (P1)** for consistent performance

3. Enable Application Insights sampling if it's taking storage:
   - **Application Insights > Configure > Sampling**

---

### Azure bill is too high

**Symptom:** Monthly costs exceed expectations.

**Causes:**
- Application Insights is storing too much telemetry
- Function App is running warm 24/7
- Storage account has high transaction count

**Solution:**
1. See [COST_ESTIMATION.md](COST_ESTIMATION.md) for pricing details

2. Optimize telemetry:
   - **Application Insights > Configure > Sampling** — set to 10–25%
   - Reduce `LOG_LEVEL` to `info` (disable debug logs)
   - Disable PII logging: `LOG_INCLUDE_CALLER_IDENTITY=false`

3. Monitor usage:
   - **Function App > Monitor > Metrics**
   - Look for `FunctionExecutionCount`, `FunctionExecutionUnits`
   - Spike = possible issue (large batch job, runaway loop)

---

## Advanced Troubleshooting

### Check Function App logs in real time

```bash
az functionapp log tail -n <function-app> -g <resource-group> --provider azure
```

### Get Bicep deployment errors

```bash
az deployment group show -n <deployment-name> -g <resource-group> --query properties.error -o json
```

### Validate Bicep before deploying

```bash
az bicep build --file infra/main.bicep
```

### SSH into Function App container (Premium SKU only)

```bash
az webapp remote-connection create --resource-group <rg> --name <function-app>
```

---

## Still Stuck?

1. **Check logs** — Application Insights is your best friend
2. **Run smoke tests** — isolate whether it's local, deployment, or ServiceNow
3. **Search docs** — [CONTRIBUTING.md](../CONTRIBUTING.md) has debugging patterns
4. **Open an issue** — include logs, config (sans secrets), and exact steps to reproduce

See [CONTRIBUTING.md](../CONTRIBUTING.md) for bug report guidelines.

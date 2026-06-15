# ServiceNow Setup Guide

This guide walks through configuring ServiceNow to work with the MCP server. You can follow the manual steps or run the automation script (`scripts/setup-servicenow.ps1`) which does steps 1–3 via the ServiceNow REST API.

---

## Step 1 — Create an OAuth Application in the App Registry

1. Log in to your ServiceNow instance as an administrator.
2. Navigate to **System OAuth > Application Registry**.
3. Click **New** and select **Create an OAuth API endpoint for external clients**.
4. Fill in:

   | Field | Value |
   |-------|-------|
   | Name | `MCP Server` (or any descriptive name) |
   | Default Grant Type | `Password Credentials` |
   | Active | ✅ Checked |
   | Redirect URL | leave blank |

5. Click **Submit** (or **Save**).
6. Open the newly created record. Copy the **Client ID** — this is `SERVICENOW_CLIENT_ID`.
7. To get the **Client Secret**: click the lock icon next to the Client Secret field (or click **Generate** if not yet set). Copy the value immediately — this is `SERVICENOW_CLIENT_SECRET`.

> **Why Password Credentials?**  
> ServiceNow's standard App Registry supports `grant_type=password` out of the box.  
> `client_credentials` requires a system property (`glide.oauth.inbound.client.credential.grant_type.enabled = true`) that is not in the default UI and must be manually created in **System Properties**.

---

## Step 2 — Create an Integration User

The MCP server uses a shared service account (integration user) to authenticate with ServiceNow.

1. Navigate to **User Administration > Users > New**.
2. Fill in:

   | Field | Value |
   |-------|-------|
   | User ID | e.g. `mcp_integration` |
   | First / Last name | e.g. `MCP Integration` |
   | Email | a real or service mailbox address |
   | Active | ✅ Checked |
   | Password | set a strong, stable password |

3. Uncheck **Password needs reset** if shown.
4. Save the user record.

---

## Step 3 — Assign Required Roles

Start from least privilege. The integration user should only have access required for the APIs used by this server.

Baseline roles:

| Role | Purpose |
|------|---------|
| `catalog` | Search/read catalog items; browse catalogs and categories |
| `itil` (optional) | Broad ServiceNow operational permissions. Prefer replacing with scoped ACLs where possible. |

Preferred enterprise approach:
- Keep `catalog` for catalog visibility.
- Replace broad `itil` with explicit table/API ACLs for only:
  - `sc_request` (read + update of requestor-owned records)
  - `sc_req_item` (read + update for request enrichment)
  - `sys_user` (read only for identity resolution)
- Restrict visibility to approved catalogs/categories using user criteria.
- If your security policy requires strict per-user access enforcement, set `SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN=true` and provide `x-servicenow-access-token` per caller.

**To assign roles:**

1. Open the integration user record.
2. Scroll to the **Roles** related list at the bottom.
3. Click **Edit** and add `catalog` and `itil`.

> **For the delegated identity (requested_for) feature**, the integration user also needs:
> - **Read** access to the `sys_user` table (to resolve caller email → sys_id)
> - **Write** access to the `sc_request` table (to patch `requested_for` after order creation)
>
> In many default environments `itil` enables this indirectly, but it is usually broader than required. Validate the final permission set with `validate_servicenow_config`.

---

## Step 4 — Validate Access

After deploying the MCP server, call the `validate_servicenow_config` tool to confirm everything is working:

```json
{
  "name": "validate_servicenow_config",
  "arguments": {
    "query": "laptop",
    "probeOrderNow": false
  }
}
```

A successful response confirms:
- OAuth token acquisition works
- Catalog item search works
- Item detail retrieval works
- (Optional) `requested_for` delegation works

To also probe order placement (creates and immediately cancels a test order):

```json
{
  "name": "validate_servicenow_config",
  "arguments": {
    "query": "laptop",
    "probeOrderNow": true,
    "orderProbeItemSysId": "<test-item-sys-id>",
    "orderProbeVariables": {}
  }
}
```

---

## Step 5 — Verify Catalog Visibility

The MCP server only exposes what the integration user can see. Before testing through the MCP server, verify directly in ServiceNow that the integration user can:

- Browse the intended catalogs and categories
- Open and read the target catalog items
- Submit orders for those items

If a catalog item is not accessible in ServiceNow for this user, it will not be accessible through the MCP server.

---

## Required ServiceNow API Endpoints

The MCP server calls these standard ServiceNow Service Catalog APIs:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/oauth_token.do` | POST | Obtain OAuth tokens |
| `/api/sn_sc/servicecatalog/items` | GET | Search catalog items |
| `/api/sn_sc/servicecatalog/items/{sys_id}` | GET | Get item details and variables |
| `/api/sn_sc/servicecatalog/items/{sys_id}/order_now` | POST | Place an order |
| `/api/now/table/sys_user` | GET | Resolve caller identity (for requested_for) |
| `/api/now/table/sc_request/{sys_id}` | PATCH | Correct requested_for after order creation |

Ensure no firewall rules, IP allow-lists, or network policies block access from the Azure Function App to these endpoints.

---

## Automation Script

`scripts/setup-servicenow.ps1` automates steps 1–3 using the ServiceNow Table API and OAuth API. It requires admin credentials.

```powershell
pwsh -File scripts/setup-servicenow.ps1 `
  -InstanceUrl https://<instance>.service-now.com `
  -AdminUser <admin-username> `
  -AdminPassword <admin-password> `
  -IntegrationUserPassword <password-for-integration-user>
```

The script outputs the Client ID, Client Secret, and integration user credentials ready to paste into the deployment script.

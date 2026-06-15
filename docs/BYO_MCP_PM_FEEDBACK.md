# Agent 365 BYO MCP — Field Feedback for PM

**Audience:** Product team owning the Agent 365 BYO (Bring-Your-Own) MCP registration
flow, the `a365` CLI, and the M365 admin center "Tools > Requests" surface.

**Context:** Real-world end-to-end registration of a custom remote MCP server
(this repo: a ServiceNow Service Catalog MCP backed by Azure Functions, EntraOAuth
authenticated). What "should" be a 1–2 minute flow turned into 5+ failed
registration attempts spanning ~2 hours due to undocumented constraints, silent
warnings, and lack of automated cleanup. Below is a consolidated list of issues
ranked by severity, with concrete reproductions where possible.

**Tenant / tooling versions used:**
- `a365` CLI: **1.1.178** (`Microsoft.Agents.A365.DevTools.Cli`)
- `az` CLI: 2.x
- M365 admin center: <https://admin.cloud.microsoft/>
- Power Platform default environment, region: westeurope
- Tenant: `*.onmicrosoft.com`, signed in as Global Admin

---

## TL;DR — what bit us, in priority order

| # | Issue | Severity |
|---|---|---|
| 1 | CLI emits "**registered with N warning(s)**" success message even when the registration is **functionally broken** (RemoteProxy app missing API permission). Causes silent downstream "We couldn't load the Tool app" admin-center failure. | **Blocker** |
| 2 | CLI looks up the literal string `.default` in the resource app's published OAuth2 scopes — fails for every backend that doesn't publish a scope literally named `.default`. Should resolve `.default` against the actual scope set. | **Blocker** |
| 3 | Failed registration **leaves up to 4 Entra apps + 2 Power Platform connectors orphaned**. No `--rollback` or `--cleanup` mode. Soft-deleted apps further block re-registration via `identifierUris` collision. | **High** |
| 4 | Admin center **"Reject" does not delete underlying Entra apps, PP connectors, or oauth2PermissionGrants**. Repeated reject cycles accumulate orphans indefinitely. | **High** |
| 5 | Multiple undocumented length / format constraints (`serverName ≤ 20 incl. ext_`, `description ≤ 80`, `tool name ≤ 30`) — only enforced server-side with cryptic errors. | **High** |
| 6 | M365 admin center surfaces opaque error **"We couldn't load the Tool app at the moment. Please try again later."** with no correlation ID, no telemetry, no admin diagnostic view. | **High** |
| 7 | The CLI ships **no sample JSON file**, the schema is **undocumented**, and the README does not mention the `register-external-mcp-server` JSON shape. | Medium |
| 8 | Registration creates **two PP connectors per server** (`ext_<name>` and `ext_<name>P` with a "P" suffix) — undocumented. The P-variant blocks name reuse just as much as the regular one. | Medium |
| 9 | No public API or admin-center action to delete a stale request entry from "Tools > Requests". | Medium |
| 10 | Popup-based consent windows in admin center auto-close, **destroying the HAR** before the developer can save it. Makes self-diagnosis nearly impossible. | Medium |
| 11 | Approved BYO MCP server appears in the **`discoverMCPServers`** tenant catalog and in `a365 develop list-available`, but **never appears in the Copilot Studio MCP picker** ("Add a tool → Model Context Protocol" tab). **Root cause confirmed:** the PP connectors created by the registration flow have `properties.capabilities = []` instead of `["actions"]`. Copilot Studio's picker filters by `capabilities has 'actions'`, silently excluding the server. **Workaround validated end-to-end** — PATCH the canonical connector in the system env to set `capabilities = ["actions"]`; tenant-scoped replicas (`shared_tc-ext-*`) propagate the fix to user envs within ~1 hour. | **Blocker** |
| 12 | **BYO MCP does NOT deliver seamless SSO to end users.** The registration flow creates the OAuth custom connector with `enableOnbehalfOfLogin: true` but ships **none** of the four Entra-side configurations that Microsoft's own docs require for silent OBO: (a) a scope on the connector app, (b) preauth of the Azure API Connections SP (`fe053c5f-...`) on the connector app, (c) preauth of the connector app on the backend service app, (d) preauth of the first-party hosts (Power Apps/Copilot Studio `7df0a125-...`, Teams, M365 Copilot) on the backend service app. Per Microsoft's documented behavior, *"users would need to explicitly sign in each time they use the connector"* — BYO MCP ships an **incomplete implementation of the documented OBO recipe** for custom connectors, defeating the value proposition of MCP as a tenant-shared MCS tool. | **Blocker** |

---

## 1. CLI says "success" when it isn't

### What happened

```text
Registering MCP server 'ext_SnowCat'...
Created Entra app 'ext_SnowCat-A365Proxy' (clientId: <a365proxy-appId>)
Created Entra app 'ext_SnowCat-RemoteProxy' (clientId: <remoteproxy-appId>)
Created Entra app 'ext_SnowCat-PublicClients' (clientId: <publicclients-appId>)
Updated redirect URIs on 'ext_SnowCat-A365Proxy'
Scope '.default' not found on resource <backend-appId>        ← CRITICAL
Updated redirect URIs on 'ext_SnowCat-RemoteProxy'
Added API permission on 'ext_SnowCat-A365Proxy'
Added API permission on 'ext_SnowCat-PublicClients'
Scope '.default' not found on resource <backend-appId>
Scope '.default' not found on resource <backend-appId>
ERROR: Failed to look up scope '.default' on resource app <backend-appId> after retries: A task was canceled.. API permission not added to RemoteProxy app.
ERROR: Could not find scope '.default' on resource app <backend-appId> API permission not added to RemoteProxy app.
MCP server 'ext_SnowCat' was registered with 2 warning(s):
  - Could not find scope '.default' on resource app <backend-appId> API permission not added to RemoteProxy app.
  - Failed to look up scope '.default' on resource app <backend-appId> after retries: A task was canceled.. API permission not added to RemoteProxy app.

Please ask your tenant admin to approve MCP server 'ext_SnowCat'.
```

The CLI returns **exit code 0** and prints a happy "Please ask your tenant
admin to approve" line. But the RemoteProxy → backend chain is broken — admin
approval will fail with the opaque admin-center error in §6 below.

### Suggested fix

- Treat permission-add failures as **errors, not warnings**. Exit non-zero.
- If a non-fatal warning is genuinely OK to proceed with, separate it visually
  ("BLOCKING" vs "INFO") and explain consequence.
- Optionally, **automatically rollback** the partial state on fatal errors.

---

## 2. `.default` scope lookup is wrong

### What happened

The CLI takes `remoteScopes: api://<backendAppId>/.default` from the
registration JSON, then tries to add `.default` as a literal `Scope`-type
permission on the RemoteProxy app's `requiredResourceAccess`. It does this by
**searching the backend app's published `oauth2PermissionScopes` for an entry
whose `value` equals `.default`** — which is never the case for normal apps.

`.default` is a **runtime-only pseudo-scope** in MSAL/AAD: callers request it
to mean "give me the union of everything I'm pre-authorized for or already
configured to require". It is **never** declared as a published scope on the
resource app.

### Reproduction

A backend Entra app with `api.oauth2PermissionScopes = [{ value: "access_as_user", … }]`
will fail. The CLI logs:

```
Scope '.default' not found on resource <backend-appId>
```

### Workaround we applied

After registration, manually `PATCH https://graph.microsoft.com/v1.0/applications/{remoteProxyId}`:

```json
{
  "requiredResourceAccess": [{
    "resourceAppId": "<backendAppId>",
    "resourceAccess": [{ "id": "<actual-scope-guid>", "type": "Scope" }]
  }]
}
```

…using the actual scope (e.g. `access_as_user`) GUID, not `.default`.

### Suggested fix

- When the user passes `.default` as a remoteScope, the CLI should:
  1. Enumerate the resource app's published `oauth2PermissionScopes`.
  2. Either pick the canonical scope (e.g. there's only one) or require the
     user to pass an explicit scope name in `remoteScopes`.
  3. Fail loudly upfront if no scopes are published, instead of silently
     trying to find `.default`.
- Document clearly: "`remoteScopes` should be the exact scope value(s) your
  backend app publishes, or `.default` only when there is exactly one scope
  with `adminConsentRequired = false` and you understand the implications."

---

## 3. Failed registrations leak artifacts

### What happened

Across 5 attempts we accumulated:

- **3 sets** of orphan Entra apps × 4 apps each = **12 orphan apps** (proxy +
  remote proxy + public clients + BYO).
- **4 orphan Power Platform custom connectors** in the default environment.
- **1 orphan oauth2PermissionGrant** on the Agent 365 service principal.

None of these are cleaned up by the CLI. Worse, plain `az ad app delete` only
**soft-deletes** an app — its `identifierUris`
(`https://agent365.svc.cloud.microsoft/agents/servers/{name}/tenants/{tenant}`
on the BYO app) keeps the name reserved until it's manually purged from the
deleted-items bin via Graph:

```http
DELETE https://graph.microsoft.com/v1.0/directory/deletedItems/{appObjectId}
```

So a developer who fails registration and tries again with the same name gets
this error from the second attempt, with no hint at the cause:

```
Another object with the same value for property identifierUris already exists.
```

### Reproduction

1. Run `a365 develop-mcp register-external-mcp-server -f registration.json`
   with a `description` longer than 80 chars.
2. It creates 3 proxy Entra apps + 1 BYO app, then fails server-side.
3. Re-run with a shorter description and the same `serverName`:
   identifierUri collision.
4. Even after `az ad app delete --id <byo-app-id>` for all four, re-registering
   the same name still fails until you Graph-delete from `deletedItems`.

### Suggested fix

- **Atomic registration:** wrap proxy app + BYO app + connector creation in a
  single transactional flow with auto-rollback on failure.
- At minimum, when registration fails, the CLI should `--rollback`
  automatically (delete the apps it just created AND purge from soft-delete bin).
- Provide an `a365 develop-mcp cleanup --server-name ext_X` command that finds
  and deletes orphan artifacts.

---

## 4. Admin "Reject" doesn't cascade

### What happened

After clicking **Reject** on a request in M365 admin center > Tools > Requests,
all of the following remained intact in the tenant:

- 4 Entra apps (`ext_<name>-A365Proxy`, `-RemoteProxy`, `-PublicClients`,
  ` - BYO`).
- 2 Power Platform custom connectors (`ext_<name>` and `ext_<name>P`).
- 1 oauth2PermissionGrant on the Agent 365 SP (`PlatformRuntime.Internal.All`).

Verified via Graph immediately after reject (count of artifacts unchanged).

### User impact

- Tenant pollution. Every rejected developer experiment leaves trash apps in
  the directory.
- Re-trying the same `serverName` requires manual cleanup the developer
  doesn't know they need to do.
- Org-wide identifierUri collisions when multiple devs experiment.

### Suggested fix

- Reject should perform best-effort cascade delete of:
  - The 4 Entra apps (with permanent purge).
  - The 2 PP custom connectors.
  - Any oauth2PermissionGrants the registration created.
- Surface a confirmation dialog ("This will permanently remove 4 Entra apps,
  2 connectors, and revoke 1 grant. Continue?").

---

## 5. Undocumented format / length constraints

| Field | Constraint | How discovered |
|---|---|---|
| `serverName` | Must start with `ext_` AND total length ≤ **20** chars | Server-side error after CLI accepts it |
| `description` | ≤ **80** chars (otherwise: "Short description exceeds the maximum length of 80 characters") | Failed registration #1 |
| Each `tools[].name` | ≤ **30** chars (otherwise: "Tool name 'X' exceeds the maximum length of 30 characters (current: 33)") | Failed registration #3 |
| `serverName` | Must be globally unique across the tenant including soft-deleted apps' identifierUris | identifierUris collision |

None of these are mentioned in the public docs or surfaced by the CLI's
`--help`. **All four** were learned by failure.

### Suggested fix

- Document in the [Manage tools for agents](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/manage-tools-for-agent?view=o365-worldwide#bring-your-own-byo-mcp-server)
  reference.
- Validate client-side in the CLI before any apps are created.
- If possible, relax the limits (30 chars is very tight for descriptive tool
  names like `validate_servicenow_configuration`).

---

## 6. Admin center error: "We couldn't load the Tool app"

### What we saw

When the tenant admin opens **M365 admin center > Tools > Requests > {request}**:

> ⊘ We couldn't load the Tool app at the moment. Please try again later.

The Approve button is greyed out; only Reject works. There is:

- No correlation ID
- No "more details" expander
- No link to a diagnostic page or admin telemetry view
- The error persists across browser refresh, incognito retry, and waiting 30+ minutes

In our case, root cause was the broken RemoteProxy permission from §1/§2.
There was no way for the admin to know that without the developer doing
Graph-level forensics.

### Suggested fix

- Surface the actual failure (e.g. "RemoteProxy app `xxx` is missing required
  delegated permission `access_as_user` on resource `yyy`. Ask the developer
  to re-register with a valid `remoteScopes` value.")
- At minimum, expose a correlation/request ID admins can paste into a support
  ticket.
- Add a "Validate" button that runs the same checks the Approve flow does,
  surfacing all problems at once instead of only the first one that blocks
  page rendering.

---

## 7. Missing CLI / schema documentation

The `a365 develop-mcp register-external-mcp-server -f <file>` command requires a
JSON file but:

- Ships **no sample**, no `--init` / `--scaffold` to produce one.
- The expected schema is **not** in `a365 develop-mcp register-external-mcp-server --help`.
- Microsoft Learn does not document the field names.
- Trial-and-error on field names cost ~30 minutes by itself.

### The schema we reverse-engineered

```jsonc
{
  "serverName": "ext_MyServer",                  // string, ext_ + ≤16 chars
  "serverUrl": "https://my.example.com/mcp",     // public HTTPS endpoint
  "authType": "EntraOAuth",                      // | "None" | …?
  "description": "Short description.",           // ≤ 80 chars
  "publisherName": "Contoso IT",
  "remoteScopes": "api://<backendAppId>/<scope>",// see §2 — NOT `.default`
  "tenantId": "<tenant-guid>",
  "tools": [
    { "name": "tool_name", "description": "..." }  // name ≤ 30 chars
  ]
}
```

### Suggested fix

- Add `a365 develop-mcp register-external-mcp-server --init my-config.json` to
  scaffold a commented template.
- Publish the schema (JSON Schema would be ideal — IDEs could lint it).
- Update Microsoft Learn page with the full schema + length constraints.

---

## 8. Two PP connectors per registration

Registration creates **both** `ext_<name>` and `ext_<name>P` Power Platform
custom connectors in the user's default environment. Example:

```
shared_ext-5fsnowcat-5fde08...   (displayName: ext_SnowCat)
shared_ext-5fsnowcatp-5fde08...  (displayName: ext_SnowCatP)
```

What `P` means is undocumented (Production vs Preview? Public vs Private?).
Both block name reuse on a re-registration. Failed registration #4 exhibited:

```
Failed to create connector shared_ext_ServiceNowMCPP for environment <compliant-container-env-id>
Status: BadRequest, Error: HTTP 400: Bad Request
```

…because the P-variant of a previous failed attempt was still present, even
though its sibling had been cleaned up.

### Suggested fix

- Document the dual-connector pattern.
- Make connector creation atomic (delete first if a sibling already exists, or
  fail upfront with a clear "stale connector found, delete it first" message).

---

## 9. No way to delete a stale request from the admin center

If the M365 admin center request entry exists but its underlying Entra apps
have been deleted (e.g. developer cleaned up manually), the request entry
sits in **Tools > Requests** forever. Neither Approve nor Reject can resolve
it — Approve fails with §6, and Reject doesn't cascade-delete (§4) so the
artifacts stay broken.

There is no admin-center API surface or UI button for deleting a stuck
request.

### Suggested fix

- Add a "Delete" or "Force remove" action on stale requests.
- Implement a server-side health check that auto-removes requests whose
  underlying Entra apps no longer exist.

---

## 10. HAR loss in popup consent flows

Standard consent flows in M365 admin center spawn a popup window pointing at
`login.microsoftonline.com/{tenant}/.../adminconsent`. When that popup completes
(or errors and auto-closes), the popup's HAR is **destroyed** with the window.

This makes self-diagnosis essentially impossible: the failing call is in the
popup, but you can't capture it. We tried 3+ times with DevTools open in the
popup and "Preserve log" enabled — the HAR was empty after the close.

### Suggested fix

- For the admin-center consent flow, prefer same-window navigation (or at
  minimum, log the resulting redirect URL with `error=`/`error_description=`
  parameters into the parent window before the popup closes).

---

## Reproduction summary

The minimum steps to hit at least 6 of the issues above:

1. Build a remote MCP server backed by an Entra app that publishes a single
   custom delegated scope (e.g. `access_as_user`). **Don't** publish a scope
   literally named `.default`.
2. Author a registration JSON with `remoteScopes: api://<appId>/.default`.
3. Run `a365 develop-mcp register-external-mcp-server -f config.json`.
4. CLI completes with exit 0 and a "registered with 2 warning(s)" message.
5. Sign in to M365 admin center as Global Admin → Tools → Requests → click
   the new request → see "We couldn't load the Tool app at the moment".
6. Click Reject. Verify via `az ad app list` that all 4 apps still exist, and
   via PowerApps API that 2 connectors still exist.
7. Try to re-register the same name → identifierUris collision, requires
   manual purge from `directory/deletedItems` to recover.

---

## What "good" would look like

For a developer publishing their first BYO MCP server, the ideal flow is:

```text
$ a365 develop-mcp init                # scaffolds registration.json with comments
$ a365 develop-mcp validate -f registration.json   # checks all constraints client-side
$ a365 develop-mcp register-external-mcp-server -f registration.json
✓ Created 4 Entra apps
✓ Wired RemoteProxy permission to backend (scope: access_as_user)
✓ Created 2 Power Platform connectors
✓ Submitted approval request to admin center

Server ext_X is awaiting tenant admin approval.
Track status: a365 develop-mcp status ext_X
```

…and on failure:

```text
✗ Failed to wire RemoteProxy permission: backend app does not publish a scope.
  Either:
    - Publish a delegated scope on app aaaa-bbbb-cccc, OR
    - Use 'remoteScopes: api://aaaa-bbbb-cccc/access_as_user'

  Rolling back created artifacts...
  ✓ Deleted 3 Entra apps
  ✓ Purged from soft-delete bin
  ✓ Deleted 0 PP connectors

  No artifacts left behind.
```

…and the admin can click Approve / Reject knowing Reject will fully clean up.

---

## 11. Approved BYO MCP never appears in Copilot Studio MCP picker

### What happened

After completing the full registration + admin approval flow successfully:

- ✅ All 4 Entra apps exist with correct `requiredResourceAccess` chain.
- ✅ Both Power Platform connectors (`ext_SnowCat`, `ext_SnowCatP`) created in
  the `Microsoft 365 Compliant Container` system env (`<compliant-container-env-id>`).
- ✅ Tenant-wide admin consent granted for `PlatformRuntime.Internal.All`
  (BYO → Agent 365 SP) and `access_as_user` (RemoteProxy → backend).
- ✅ M365 admin center shows the request as **Available** / approved.
- ✅ The Agent 365 catalog endpoint **`https://agent365.svc.cloud.microsoft/agents/v2/discoverMCPServers`**
  returns `ext_SnowCat` alongside the Microsoft built-in MCPs:

  ```json
  {
    "mcpServerName": "ext_SnowCat",
    "id": "<server-entity-id>",
    "url": "https://agent365.svc.cloud.microsoft/agents/servers/ext_SnowCat",
    "scope": "Tools.ListInvoke.All",
    "audience": "<byo-appId>",
    "publisher": "<tenant-guid>"
  }
  ```

- ✅ `a365 develop list-available` lists `ext_SnowCat` correctly.

Despite all of the above, **the server never appears in the Copilot Studio
MCP picker** (`copilotstudio.microsoft.com` → agent → Tools → Add tool → MCP
servers tab). Verified across:

- Multiple browser sessions (regular + incognito)
- Multiple Power Platform environments (Default, Microsoft 365, others)
- Hard refresh (Ctrl+F5)
- Sign-out / sign-in cycles
- **5+ hours of waiting after approval**

The Microsoft built-in MCPs (`mcp_M365Copilot`, `mcp_TeamsServer`, etc.) DO
show up in the picker. Only the BYO `ext_SnowCat` is missing.

### Why this matters

This is the **end-to-end blocker** for any BYO MCP scenario. Every preceding
issue (#1–#10) can be worked around with developer toil, but if the result is
invisible in the consumer surface (Copilot Studio), the whole feature is
effectively unusable for its primary purpose.

### Root cause (confirmed via API forensics + end-to-end test)

**Status:** Workaround validated. After applying the PATCH below to the
canonical connector, the BYO MCP server **did become visible** in the Copilot
Studio "Add a tool → Model Context Protocol" picker in a user-facing env
("Contoso Personal Productivity" / Default env). Propagation delay from the
PATCH to picker visibility was on the order of **tens of minutes** (not
immediate, not requiring a full picker refresh of the canonical metadata; the
fix flows through the same tenant-connector replication pipeline that originally
produced the broken `tc-ext-*` copies).

Brute-force comparison of the two PP connectors created by the BYO registration
(`shared_ext-<name>-...` and `shared_ext-<name>p-...`) against the working
Microsoft built-in MCP connectors (`shared_a365copilotchatmcp`,
`shared_a365adminmcp`, `shared_a365outlookmailmcp`, etc.) revealed:

| Field | Working built-in MCPs | BYO `ext_<name>` connector |
|---|---|---|
| `properties.metadata.source` | `marketplace` | `powerapps-user-defined` |
| `properties.capabilities` | `["actions"]` | **`[]` (empty!)** |
| `properties.publisher` | `Microsoft` | `<tenant maker display name>` (creator) |
| `properties.tier` | `Premium` | `Standard` |
| `properties.runtimeUrls` host | `*.common.europe002.azure-apihub.net` | `*.custom.europe002.azure-apihub.net` |
| `properties.iconUri` | branded `static.powerapps.com/...` | default `defaulticons.powerapps.com/...` |

The **decisive filter** is `properties.capabilities has 'actions'` on the
`https://api.powerapps.com/providers/Microsoft.PowerApps/apis` endpoint — every
single one of the 1100+ visible custom-connector picker entries in this env has
that capability. The two BYO connectors created by the Agent 365 registration
flow do **not** declare it. The Copilot Studio MCP picker (which is built on top
of the same connector list) consequently filters them out before ever showing
the user.

**Workaround that fixes visibility immediately:**

```powershell
$envId    = "<compliant-container-env-id>"
$ppToken  = az account get-access-token --resource "https://service.powerapps.com/" --query accessToken -o tsv
$headers  = @{ Authorization = "Bearer $ppToken"; "Content-Type" = "application/json" }
$body     = @{ properties = @{ capabilities = @("actions") } } | ConvertTo-Json
foreach ($cn in @(
  "shared_ext-5f<name>-5f<envSuffix>",
  "shared_ext-5f<name>p-5f<envSuffix>"
)) {
  $url = "https://api.powerapps.com/providers/Microsoft.PowerApps/apis/$cn" + `
         "?%24filter=environment%20eq%20%27$envId%27&api-version=2016-11-01"
  Invoke-RestMethod -Method Patch -Uri $url -Headers $headers -Body $body
}
```

After the PATCH the connector appears in the standard `capabilities has 'actions'`
listing — confirmed via:

```http
GET https://api.powerapps.com/providers/Microsoft.PowerApps/apis
    ?api-version=2016-11-01
    &$filter=environment eq '<env-id>' and properties/capabilities has 'actions'
```

`metadata.source` is **read-only** for custom connectors (PATCH returns
`CannotUpdateApiMetadata`), so we cannot fake the connectors as `marketplace`.
That field is informational only — the real picker filter is `capabilities`.
This is **confirmed**: after the PATCH the connector remains
`metadata.source: powerapps-user-defined` and `publisher: <tenant maker display name>`
yet is now picker-visible.

**Replication caveat:** the registration creates the canonical connector in the
hidden `Microsoft 365 Compliant Container` system env (`<compliant-container-env-id>`, *not*
listed by `a365 develop-mcp list-environments` and *not* in the BAP admin env
list) and then propagates two `shared_tc-ext-<name>-...` tenant-scoped replicas
into a curated subset of envs (in this tenant: 7 of 14 envs got the
replicas — PVE Sandbox/Dev envs were excluded). The replicas are *not* custom
APIs (`isCustomApi: false`, `metadata.source: tenant-scoped`) and reject the
standard custom-connector PATCH with `CustomApiNotFound`. Patching the
canonical is the only path; the platform's replication eventually copies
`capabilities` to all the `tc-ext-*` replicas.

### Suggested fix

1. **Make Agent 365 registration set `capabilities: ["actions"]` on the
   connectors it creates.** This is the single highest-impact fix in this
   document — it turns the BYO feature from "fully invisible to end users"
   into "actually works end-to-end".
2. **Document the propagation pipeline** explicitly: `discoverMCPServers` →
   PP connector listing → Copilot Studio picker. State the expected SLA
   (minutes? hours? daily batch?).
3. **Surface a status indicator** in M365 admin center: "Visible in Copilot
   Studio: Yes/No". The check can be a simple PP API call.
4. **Provide a CLI command** `a365 develop check-visibility --server ext_X`
   that reports whether the server is visible in each consumer surface
   (Copilot Studio, VS Code, Claude, GitHub CLI) and explains why if not.
   The check for Copilot Studio is essentially: does the connector have
   `capabilities` containing `actions` in the user's working environment?

### Reproduction (verified May 2026)

1. Complete the full BYO registration + admin approval flow (issues #1–#10
   notwithstanding).
2. Run `a365 develop list-available` — confirm `ext_<name>` appears in the
   `discoverMCPServers` catalog.
3. Inspect the canonical PP connector:
   ```http
   GET https://api.powerapps.com/providers/Microsoft.PowerApps/apis
       ?api-version=2016-11-01
       &$filter=environment eq '<compliant-container-env-id>'
   ```
   Filter for `name = shared_ext-5f<name>-...`. Observe
   `properties.capabilities: []` and `properties.metadata.source:
   powerapps-user-defined`.
4. Inspect the `tc-ext-*` replicas in any user-facing env (e.g. the Default
   env / personal productivity). Observe they also have
   `properties.capabilities: []` and `properties.metadata.source:
   tenant-scoped`. Direct PATCH on these returns
   `400 CustomApiNotFound`.
5. Open `https://copilotstudio.microsoft.com`, switch to a user-facing env
   that has the replicas, create / open an agent, go to **Tools → Add a
   tool → Model Context Protocol** tab, search `ext_<name>`. **Result:
   not found.**
6. Apply the PATCH workaround above to **both** canonical connectors
   (`shared_ext-<name>-...` and `shared_ext-<name>p-...`) in the
   Compliant Container env.
7. Wait for tenant-connector replication (observed: tens of minutes).
8. Refresh Copilot Studio MCP picker. **Result: `ext_<name>` appears under
   the Model Context Protocol tab and can be added to the agent.**

---

## 12. BYO MCP ships an incomplete OBO setup — every end user hits the OAuth popup

### What happened

After completing the full registration + admin approval + visibility-fix
(issue #11) flow, the BYO MCP server is finally selectable in the Copilot
Studio "Add a tool → Model Context Protocol" picker. However, **the BYO
feature is implemented on top of the existing Power Platform custom connector
model with OAuth 2.0**, and inspection of the resulting Entra app
configuration shows that the registration flow **implements only the
connector-side half of the documented OBO recipe** and skips the entire
Entra-side configuration that the same docs say is mandatory for silent SSO.

The result: every end user of any Copilot Studio agent that uses the BYO MCP
server has to go through the per-user OAuth consent / sign-in popup (the
infamous "Open connection manager" UX) — exactly the friction MCS adopters
expect MCP to *eliminate*.

> **Note for the PM team:** for a fully-worked reference of what BYO
> *should* be producing automatically, this same repo carries a hand-written
> recipe at [docs/AUTH_ENTRA_OBO_OKTA.md](AUTH_ENTRA_OBO_OKTA.md) that walks
> through the complete Entra app layout, scope, pre-authorizations, and
> connector settings needed for silent SSO. Today, that doc exists because
> BYO doesn't do any of it for you. The ideal future state is for that doc
> to become obsolete because `a365 develop-mcp register-external-mcp-server`
> already does all the same steps.

### Evidence (verified via Graph API on the live tenant)

The Agent 365 BYO registration creates 4 Entra apps:

| App | Purpose | `api.oauth2PermissionScopes` | `api.preAuthorizedApplications` |
|---|---|---|---|
| `<name>-A365Proxy` (clientId of the PP connector) | "Connector app" — what the PP custom connector authenticates as | **(none)** | **(none)** |
| `<name>-RemoteProxy` | Forwards OBO to the backend MCP | (none) | (none) |
| `<name>-PublicClients` | Public-client redirect URIs (VS Code, localhost) | (none) | (none) |
| `<name>-BYO` (the backend / "service" app) | Exposes the API the MCP backend protects | `Tools.ListInvoke.All` | **(none)** |

The PP custom connector itself *is* configured for OBO at the connector level
(`enableOnbehalfOfLogin: "true"`, `IsOnbehalfofLoginSupported: true`,
`IsFirstParty: "True"`), but on the Entra side the chain that would make OBO
work seamlessly is missing.

### Why this matters — Microsoft's own docs spell it out

From [Configure OBO authentication for custom connectors](https://learn.microsoft.com/microsoft-copilot-studio/advanced-custom-connector-on-behalf-of)
(emphasis added):

> In the **Authorized client applications** section, select **Add a client
> application**. Enter the client ID for the Microsoft Azure API Connections
> service principal: `fe053c5f-3692-4f14-aef2-ee34fc081cae`.
> Select the scope you created. Select **Add application**.
>
> You need to authorize the Azure API Connections service principal to sign
> in on behalf of users. **Without this configuration, users would need to
> explicitly sign in each time they use the connector.**

That is the entire point of MCP-as-a-tool in Copilot Studio: a tenant admin
publishes a server once, and every authorised end user of any agent that
references it gets a transparent OBO experience. The BYO flow as shipped
breaks this promise because it skips the preauthorization step.

### Verification commands

```powershell
# 1. The Azure API Connections SP exists in the tenant (it's a global Microsoft SP)
az ad sp show --id fe053c5f-3692-4f14-aef2-ee34fc081cae --query 'displayName' -o tsv
# -> "Azure API Connections"

# 2. The BYO-created apps have ZERO preAuthorizedApplications
$gToken = az account get-access-token --resource https://graph.microsoft.com/ --query accessToken -o tsv
$hg = @{ Authorization = "Bearer $gToken" }
foreach ($appId in @(
  "<A365Proxy-appId>", "<RemoteProxy-appId>",
  "<PublicClients-appId>", "<BYO-appId>"
)) {
  $a = Invoke-RestMethod -Method Get -Headers $hg `
       -Uri "https://graph.microsoft.com/v1.0/applications(appId='$appId')"
  "$($a.displayName) -> preAuthorized=$($a.api.preAuthorizedApplications.Count) scopes=$($a.api.oauth2PermissionScopes.Count)"
}
# Observed on this tenant:
#   <name>-A365Proxy     -> preAuthorized=0 scopes=0
#   <name>-RemoteProxy   -> preAuthorized=0 scopes=0
#   <name>-PublicClients -> preAuthorized=0 scopes=0
#   <name>-BYO           -> preAuthorized=0 scopes=1   (Tools.ListInvoke.All)
```

### Comparison: how a working SSO connector looks

The Microsoft 365 built-in MCP connectors (e.g. `shared_a365copilotchatmcp`,
`shared_a365adminmcp`) use a **certificate-based** OAuth (`identityProvider:
aadcertificate`) and have full first-party trust, so the user never sees a
sign-in popup. They cannot fail the preauthorization check because they ARE
first-party. The Agent 365 BYO flow instead uses
`identityProvider: aad` with a customer-owned client app (A365Proxy) and a
customer-owned backend app (BYO) — i.e. the *normal* custom-connector OBO
path — but then doesn't actually complete the OBO setup.

### Suggested fix (low effort, high impact)

The full manual recipe is documented by Microsoft in
[Configure OBO authentication for custom connectors](https://learn.microsoft.com/microsoft-copilot-studio/advanced-custom-connector-on-behalf-of)
and [Deploy Azure MCP Server with on-behalf-of authentication](https://learn.microsoft.com/azure/developer/azure-mcp-server/how-to/deploy-remote-mcp-server-on-behalf-of).
The BYO registration must execute the same Entra-side steps. Concretely,
during `a365 develop-mcp register-external-mcp-server`, after creating the
A365Proxy and BYO apps, the registration should also perform **all four**
of the following PATCHes:

1. **Expose a scope on the A365Proxy (connector) app**, e.g.
   `access_as_user` (`oauth2PermissionScopes` entry). Without this, there
   is nothing to preauthorize against — step 2 has no scope to grant.
2. **Add the Azure API Connections SP as a preauthorized client** on
   A365Proxy with the new scope (this is the connector→runtime OBO hop
   the Power Platform documentation calls out explicitly):

   ```http
   PATCH https://graph.microsoft.com/v1.0/applications/{a365proxy-objectId}
   Content-Type: application/json

   {
     "api": {
       "oauth2PermissionScopes": [{
         "id": "<new-guid>", "value": "access_as_user",
         "type": "User", "isEnabled": true,
         "adminConsentDisplayName": "...", "adminConsentDescription": "...",
         "userConsentDisplayName": "...", "userConsentDescription": "..."
       }],
       "preAuthorizedApplications": [{
         "appId": "fe053c5f-3692-4f14-aef2-ee34fc081cae",
         "delegatedPermissionIds": ["<id-of-access_as_user>"]
       }]
     }
   }
   ```
3. **Add the A365Proxy app as a preauthorized client on the BYO service
   app** for the `Tools.ListInvoke.All` scope, so the second hop
   (connector→backend) also doesn't prompt.
4. **Add the first-party hosts as preauthorized clients on the BYO
   service app** for the same scope, so users invoking the agent from
   Teams or Microsoft 365 Copilot get a true silent token-passthrough
   without ever touching the Power Platform connection flow:

   | First-party host | App ID to add as `preAuthorizedApplications[].appId` |
   |---|---|
   | Power Apps / Copilot Studio | `7df0a125-d3be-4c96-aa54-591f83ff541c` |
   | Microsoft Teams desktop/web | `1fec8e78-bce4-4aaf-ab1b-5451cc387264` and `5e3ce6c0-2b1f-4285-8d4b-75ee78787346` |
   | Microsoft 365 Copilot | `ab9b8c07-8f02-4f72-87fa-80105867a763` |

With these four PATCHes the end-user experience for *any* user authorized
to use the agent becomes: open the agent → ask a question that triggers
the tool → answer is returned. No popups, no per-user connection record,
no "Open connection manager" detour, no agent-side Teams manifest tweaks
beyond what the agent already needs for its own host SSO.

Note: this is the exact same set of steps the in-repo
[AUTH_ENTRA_OBO_OKTA.md](AUTH_ENTRA_OBO_OKTA.md) recipe walks a developer
through manually today. Folding them into the registration tool is the
difference between BYO being a viable production feature and BYO being a
demo-only capability that every customer has to manually fix after the
tool tells them "success".

### Why this is a Blocker, not a Medium

A BYO MCP server that the admin has explicitly approved tenant-wide
should behave like a built-in tool: invisible plumbing. If every end user
has to click through an OAuth consent popup the first time the agent
fires the tool — and again on every new session if the connection record
expires — then BYO MCP delivers a *worse* UX than just configuring a
plain custom connector (where at least the maker knows that's expected).
The whole "shared, governed, tenant-managed MCP" pitch falls apart.

### Reproduction

1. Complete BYO registration + admin approval + capabilities patch (#11).
2. In Copilot Studio (in an env where the connector replicated, e.g.
   "Contoso Personal Productivity"), open or create an agent.
3. **Tools → Add a tool → Model Context Protocol → search `ext_<name>` →
   Add to agent**.
4. As the maker, observe that adding the tool prompts you to **Create
   connection** — this opens a sign-in popup against the A365Proxy app.
5. Publish the agent and share it with a second test user who has *no
   prior connection* to this connector.
6. As that test user, open the agent and ask a question that should fire
   the MCP tool.
7. **Observed:** the agent stops and asks the user to sign in / create a
   connection (the "Open connection manager" experience).
8. **Expected (per BYO MCP value proposition):** the call goes through
   transparently — the user's existing M365 session is OBO-exchanged for
   a token that the backend accepts. No popup.

---

*Captured by a developer doing live tenant validation, May 2026. Happy to
provide tenant IDs, app object IDs, HARs, and exact CLI invocations to the
PM team on request.*

# Work IQ Developer Tools plugin

This repository can be brought into Microsoft 365 Copilot through Microsoft's
**Work IQ Developer Tools (WIQD)** plugin workflow. This is an alternative
packaging and sharing path to the existing [`m365-agent/`](../m365-agent/)
Agents Toolkit package; it does not replace the MCP Apps server, its widgets,
or the existing release workflow.

The checked-in starter package is under
[`wiqd-plugin/`](../wiqd-plugin/). It composes:

- an `agentConnectors[]` entry for the remote ServiceNow MCP server;
- an `agentSkills[]` skill with safe routing and confirmation guidance; and
- a checked-in MCP tool description used by Copilot Cowork connection
  verification.

## Before using the package

The package deliberately contains no tenant-specific credentials. In
[`wiqd-plugin/appPackage/manifest.json`](../wiqd-plugin/appPackage/manifest.json):

1. Replace `https://example.invalid/mcp` with the deployed HTTPS MCP endpoint.
2. Register an OAuth client for the target Microsoft 365 tenant using the
   tenant's supported plugin-vault/OAuth registration flow.
3. Replace `REPLACE_WITH_OAUTH_PLUGIN_VAULT_REFERENCE_ID` with the resulting
   reference ID.
4. Keep the client secret in the managed plugin-vault registration. Never put
   it in the manifest, a `.env` file committed to Git, or documentation.

The Azure management tenant/subscription and Microsoft 365 runtime tenant are
separate concerns. A tenant migration does not justify changing Azure
management identifiers in the repository.

The MCP endpoint must be HTTPS (TLS 1.2+), use Streamable HTTP and JSON-RPC
2.0, expose `tools/list` and `tools/call`, and complete calls within the
Copilot connector timeout. The endpoint remains responsible for Entra token
validation, caller-to-ServiceNow identity mapping, ServiceNow ACLs, and
MCP Apps widget resources.

## Configure ServiceNow

WIQD does not replace or bypass the ServiceNow integration. Configure the
ServiceNow instance before provisioning the Copilot plugin:

1. Create the ServiceNow OAuth application and record its client ID and secret.
2. Create an active integration user with a stable password and clear
   **Password needs reset** and **Web service access only**.
3. Assign `catalog` plus the least-privilege table/API ACLs needed for
   Knowledge, catalog, requests, approvals, incidents, attachments, and
   `sys_user` identity lookup.
4. Configure the MCP server's ServiceNow variables
   (`SERVICENOW_INSTANCE_URL`, OAuth client values, and integration-user
   credentials) in the deployment secret store.
5. Enable the Entra OBO path when per-user authorship and caller ACLs are
   required. The caller's Entra email must resolve to the matching
   `sys_user.email` record.
6. Run `validate_servicenow_config` and verify a read-only Knowledge/catalog
   request before enabling write actions.

The complete table/role matrix, OAuth details, OBO identity mapping, endpoint
list, and cleanup guidance are in
[`SERVICENOW_SETUP.md`](SERVICENOW_SETUP.md) and
[`AUTH_ENTRA_OBO.md`](AUTH_ENTRA_OBO.md). Do not use an administrator account
as the runtime integration identity, and do not place ServiceNow credentials in
the plugin manifest or skill.

## Local package validation

Install WIQD using the current [installation
guide](https://microsoft.github.io/wiqd/getting-started/installation/), then
run these commands from `wiqd-plugin/`:

```powershell
wiqd auth login --interactive
wiqd plugin validate
wiqd plugin provision --environment dev
wiqd plugin package
wiqd plugin validate --mode deep
```

Provision before packaging. `wiqd plugin share` is tenant-scoped and requires
custom plugin sharing to be enabled by the tenant administrator:

```powershell
wiqd plugin share --scope users --email <user@tenant.example>
```

The `wiqd plugin` command tree is currently alpha and may change. Use the
official [WIQD plugin documentation](https://microsoft.github.io/wiqd/concepts/plugins/)
for the installed CLI version.

## Keeping tool descriptions current

[`wiqd-plugin/appPackage/mcp-tool-description.json`](../wiqd-plugin/appPackage/mcp-tool-description.json)
must describe the public `tools/list` inventory. When tools are added, removed,
or renamed, obtain a fresh `tools/list` response from the deployed server,
replace this file with the corresponding tool-description JSON, and run the
repository tests. The package contract test ensures the connector description
does not silently drift from the server's tool inventory.

## Relationship to other Microsoft 365 paths

| Path | Use it when |
| --- | --- |
| [`m365-agent/`](../m365-agent/) | You use the existing Agents Toolkit declarative-agent lifecycle and MCP Apps widgets. |
| [`wiqd-plugin/`](../wiqd-plugin/) | You want a WIQD-composed plugin that can be validated, provisioned, packaged, and shared as a Copilot plugin. |
| [Agent 365 BYO MCP](AGENT_365_BYO_MCP.md) | You need a tenant-level Agent 365 tool registration rather than an app package. |

All paths call the same MCP server and therefore retain the same ServiceNow
authorization and per-user attribution boundaries.

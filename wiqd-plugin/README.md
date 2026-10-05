# ServiceNow Assistant Work IQ plugin

This directory is a standalone [Work IQ Developer Tools (WIQD)](https://microsoft.github.io/wiqd/)
plugin for bringing this repository's ServiceNow MCP server into Microsoft 365
Copilot. It is intentionally separate from [`m365-agent/`](../m365-agent/), so
the existing Agents Toolkit package and release workflow remain unchanged.

## Configure the package

Before validating or provisioning, edit
[`appPackage/manifest.json`](appPackage/manifest.json):

1. Replace `https://example.invalid/mcp` with the deployed HTTPS MCP endpoint.
2. Replace `REPLACE_WITH_OAUTH_PLUGIN_VAULT_REFERENCE_ID` with the OAuth
   client-registration reference created for the target Microsoft 365 tenant.
3. Keep the OAuth client secret in the plugin-vault registration; never place it
   in this repository.

The MCP endpoint must support Streamable HTTP, JSON-RPC 2.0, `tools/list`, and
`tools/call`. The checked-in
[`mcp-tool-description.json`](appPackage/mcp-tool-description.json) is supplied
because Copilot Cowork requires `mcpToolDescription` even though the 1.29
manifest schema makes it optional. Regenerate it from the server's
`tools/list` response whenever the public tool inventory changes.

## WIQD lifecycle

Install WIQD using Microsoft's current installation instructions, then run from
this directory:

```powershell
wiqd auth login --interactive
wiqd plugin validate
wiqd plugin provision --environment dev
wiqd plugin package
wiqd plugin validate --mode deep
```

Provisioning must complete before packaging. Sharing is tenant-scoped and
requires the target tenant to allow custom plugin sharing:

```powershell
wiqd plugin share --scope users --email <user@tenant.example>
```

The `agentSkills` entry provides intent guidance, while the `agentConnectors`
entry connects Copilot to the remote MCP server. The MCP server remains
responsible for Entra OAuth validation, per-user identity mapping, ServiceNow
ACLs, confirmation behavior, and widget rendering.

Configure the ServiceNow side first using the repository's
[ServiceNow setup guide](../docs/SERVICENOW_SETUP.md), including the OAuth
application, integration user, least-privilege roles/ACLs, and
`sys_user.email` identity mapping required by OBO.

## Testing boundaries

Local testing can validate the package and, separately, run the MCP server
against a local or deployed endpoint. Cloud testing requires a reachable HTTPS
endpoint and OAuth registration in the target Microsoft 365 tenant. The Azure
management tenant and subscription are independent of the runtime/M365 tenant;
do not copy Azure management identifiers into this package.

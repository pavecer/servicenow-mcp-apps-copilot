# Agent 365 Publishing and Governance

This runbook explains how the ServiceNow Assistant moves from a developer copy
to a tenant-published Microsoft 365 agent, how that lifecycle differs from Agent
365 MCP tool registration, and which Microsoft 365 admin center metadata fields
are expected for an Agents Toolkit declarative agent.

## Three Separate Control Planes

| Control plane | Repository path / command | Purpose |
| --- | --- | --- |
| Microsoft 365 agent app | `m365-agent/`, `atk provision`, `atk publish` | Packages and distributes the declarative agent in Copilot. |
| Agent 365 tool registry | `scripts/register-agent365-mcp.ps1` | Registers the remote MCP server for tenant-wide tool approval, blocking, and gateway telemetry. |
| Microsoft Entra Agent ID | Agent identity blueprint and agent identity APIs | Gives an agent a purpose-built nonhuman identity for identity governance and Conditional Access. |

These planes complement each other but are not interchangeable. Publishing the
app does not register the MCP server in the Agent 365 tool registry. The OAuth
application used by the MCP plugin is not an Entra Agent ID.

## Development Versus Publication

`atk provision` creates or updates the developer/sideloaded app and extends it to
Microsoft 365. It is the correct loop for development and test prompt validation,
but it does not submit the package to the organizational catalog.

```bash
npm run release:auto -- --environment snowmcpwidg-dev
```

`atk publish` packages the agent and submits it to Teams Admin Center for
organizational-catalog approval. The repository wraps this in:

```bash
npm run release:publish -- --environment snowmcpwidg-dev
```

Use publication only after:

1. The app manifest version is incremented.
2. Local build and tests pass.
3. The deployed MCP endpoint passes live validation.
4. Prompt tests pass in the developer copy.
5. The package is ready for administrator review.

Publication still requires an administrator to approve the submission in
**Teams Admin Center > Teams apps > Manage apps**. The package isn't
organizationally published until that approval completes.

The Azure/azd environment and Agents Toolkit environment are distinct. Select
the latter explicitly for production:

```bash
npm run release:publish -- \
  --environment <azd-environment> \
  --agent-environment prod
```

## Interpreting Microsoft 365 Admin Center Fields

The following observations apply to an Agents Toolkit declarative agent such as
this project.

| Field | Meaning | Expected state |
| --- | --- | --- |
| Platform | Where the agent was created | `Microsoft 365 Agents Toolkit` |
| Version | Version from `appPackage/manifest.json` | Must match the submitted package, currently `1.1.5` |
| Last updated | Most recent registry/package update | Populated after `provision` or package update |
| Last published | Organizational-catalog publication | Blank for a developer/sideloaded copy; populated after `atk publish` submission is approved and propagated |
| Last used | Latest observed agent activity | Confirms the agent is discoverable in inventory and usage telemetry is arriving |
| Entra agent ID | Purpose-built Entra Agent ID | Blank unless a supported blueprint/agent-identity integration explicitly binds one |
| Identity | Agent identity metadata | Blank when no Entra Agent ID is associated |
| Environment | Source-platform environment metadata | Often blank for Agents Toolkit apps; this isn't the ATK `.env.dev` file |
| Instructions | Registry-extracted instructions metadata | The submitted ZIP contains resolved instructions; a blank panel can be stale or unsupported metadata extraction |
| Owner / Created by | Registry accountability | Should be reassigned to the enduring owner or owning group if the original developer differs |

Do not copy `ENTRA_CLIENT_ID` into the Entra agent ID field. `ENTRA_CLIENT_ID`
identifies the OAuth application protecting the MCP API. An Entra Agent ID is a
specialized service principal created from an agent identity blueprint.

## Current Test-Tenant State

As of 2026-08-06:

- Developer app ID: `0d52a642-334e-4835-94b6-f6acc349569d`
- Display name: `ServiceNow Assistantdev`
- M365 title ID: `T_7083fecd-9cd0-e94d-285b-0e25bfc2a169`
- M365 app ID: `78042b33-06cc-48ec-84e2-2cd20e185e9b`
- Package version: `1.1.5`
- `atk publish` completed successfully with 61 package checks and submitted the
  package to the Admin Portal.
- Admin approval remains required before `Last published` is expected to
  populate.
- The exact submitted ZIP contains a 5,202-character resolved `instructions`
  string. `No instructions provided` isn't caused by a missing package file.
- The registry shows publisher Pavel Vecer but owner/creator David Vecer. Assign
  an enduring owner or owning group in Microsoft 365 admin center.

The `dev` suffix is intentional for the test environment. A production rollout
should use a separate `.env.prod`, Teams app ID, and OAuth configuration, with no
`dev` suffix.

## Post-Approval Registry Projection

Approval can produce two visible records for the same logical agent package:

1. The developer-installed/shared record created by `atk provision`.
2. The organizational record created by catalog publication and approval.

This was observed for `ServiceNow Assistantdev` version `1.1.5` on 2026-08-06.
The developer record displayed the expanded `RemoteMCPServer` endpoint,
`OAuthPluginVault` authentication, and all 23 operations. The approved
**Published by your org** record displayed the tool name and description but not
the expanded operation list.

This difference isn't evidence that the approved package lost its tools. The
exact submitted ZIP contains the same `RemoteMCPServer` runtime and 23 function
definitions, and Microsoft documents that Data & tools metadata varies by agent
type/platform and might not yet be synchronized to the admin center.

The approved record also initially showed:

- `Created`: 6 August 2026
- `Last published`: blank
- `Last used`: Never
- `Publisher type`: Your org
- `Owner` and `Created by`: blank
- `Entra agent ID`: blank

Interpret these fields as follows:

- **Publisher type: Your org** confirms that organizational publication and
  approval succeeded, even if `Last published` is blank.
- **Last used: Never** applies to the new organizational record. Using the older
  developer copy doesn't update it. Install and invoke the approved copy, then
  allow usage analytics to ingest the interaction.
- **Owner blank** is a governance action. Assign an accountable user or group.
- **Entra agent ID blank** remains expected for this non-Agent-ID-backed
  declarative agent.
- **Expanded MCP operations missing** is currently a registry metadata
  projection/synchronization limitation for this published Agents Toolkit
  record, not a runtime packaging failure.

Microsoft's admin documentation explicitly states that Data & tools metadata
isn't available for every agent type and can be empty or incomplete when the
agent type doesn't support fields or metadata hasn't synchronized yet. Tabs and
fields are capability-dependent.

### Verify the approved copy

1. Distinguish the records by **Publisher type** (`Your org` versus the
   developer/shared record), not by display name alone.
2. Configure **Users > Available to** for a small test group.
3. Install the approved organizational copy for the test user.
4. Remove or unpin the older developer copy to avoid testing the wrong record.
5. Start a new Copilot chat and invoke a catalog search plus one approval flow.
6. Allow telemetry/registry ingestion time, then refresh the agent registry and
   recheck **Last used**, **Activity**, and **Data & tools**.
7. If the approved copy executes all 23 tools but the operation list remains
   collapsed or absent, record it as an admin-center metadata limitation.

Do not republish merely to populate these display fields. Republish only for an
actual versioned package change; every catalog update requires a version bump
and admin approval.

## Agent 365 MCP Tool Registry

Tool registration is optional for running the declarative agent but recommended
when the tenant needs centralized tool governance and Tooling Gateway telemetry.
It is separate from agent app publication.

Validate the current 23-tool payload without tenant mutation:

```powershell
pwsh -File scripts/register-agent365-mcp.ps1 `
  -ServerName ext_ServiceNowMCP `
  -PublisherName "<publisher>" `
  -McpEndpointUrl "https://<function-app>.azurewebsites.net/mcp" `
  -EntraClientId "<MCP API app client ID>" `
  -TenantId "<tenant ID>" `
  -DryRun
```

Before submitting a real registration, check **Microsoft 365 admin center >
Agents > Tools > Requests/Registry** for an existing `ext_ServiceNowMCP` entry.
The current Agent 365 preview doesn't provide a safe pre-registration list
command for external registrations. Do not submit blindly because duplicate
entries are difficult to reconcile and MCP republishing has preview limitations.

The test suite asserts that the Agent 365 registration template has the same
exact tool names as the runtime manifest.

### Published agent cannot call the MCP server

Publishing the declarative agent package doesn't automatically register its
remote MCP server in the Agent 365 Tools registry. A published agent can display
the `RemoteMCPServer` metadata in **Data & tools** yet still tell users it has no
access to the tools when tenant tool governance has no approved server entry.

Diagnose this state in this order:

1. Validate the live endpoint with `npm run validate:live`.
2. Open **Microsoft 365 admin center > Agents > Tools > Requests/Registry**.
3. If no matching endpoint/server exists, submit the external MCP registration.
4. Verify the generated RemoteProxy has delegated `access_as_user` permission
  to the MCP API and tenant-wide admin consent.
5. Have an AI Administrator or Global Administrator approve the tool request.
6. Wait for propagation, reinstall the published organizational agent, and
  start a new Copilot chat.

Use the named `access_as_user` scope in `remoteScopes`. Although `.default` is a
valid OAuth token request convention after permissions are configured, Agent
365 CLI `1.1.165-preview` treats remote scopes as named exposed scopes. With
`.default`, it creates the proxy apps but warns that the scope wasn't found and
doesn't add the downstream permission.

On 2026-08-06, the test tenant registration created three proxy applications:
`ext_ServiceNowMCP-A365Proxy`, `ext_ServiceNowMCP-RemoteProxy`, and
`ext_ServiceNowMCP-PublicClients`. The initial `.default` warning was repaired
by adding the MCP API's delegated `access_as_user` permission to the
RemoteProxy, creating its service principal, and granting `AllPrincipals`
consent. The MCP request was submitted, but CLI approval was blocked because the
signed-in identity wasn't an AI Administrator or Global Administrator. Admin
Center approval remains mandatory.

## Monitoring Expectations

After organizational approval:

1. Use **Microsoft 365 admin center > Agents > All agents** for inventory,
   owner, users, permissions, security, and activity.
2. Use the agent's **Activity** tab to confirm tenant usage telemetry.
3. Use Microsoft Purview/Defender features according to the tenant's Agent 365
   and Microsoft 365 licensing.
4. If the MCP server is registered and approved in the Agent 365 tool registry,
   monitor gateway-routed tool execution in Defender XDR.
5. Application Insights remains the source for Azure Function runtime and
   ServiceNow dependency telemetry.

Agent 365 observability and security features are license-dependent. Inventory
and basic governance can appear without the full Agent 365 observability plan;
advanced interaction visibility, Defender, Purview, and Entra protections require
the corresponding licenses.

## Approval Checklist

After `release:publish` succeeds:

1. Open **Teams Admin Center > Teams apps > Manage apps**.
2. Find the pending `ServiceNow Assistantdev` version `1.1.5` submission.
3. Review permissions, valid domains, privacy/terms URLs, tools, and publisher.
4. Approve the package for the intended test users or groups.
5. In Microsoft 365 admin center, assign the correct owner or owning group.
6. Allow time for registry propagation, then verify `Last published`.
7. Remove and re-add the agent in Copilot and start a new chat when testing a
   version change.
8. Confirm **Last used** and Activity update after a test interaction.
9. Re-check Instructions. If still blank, treat it as a registry metadata
   display issue because the resolved package contains the instructions.

## Known Tooling Caveat

The installed Agents Toolkit beta can report six false schema errors from the
standalone `atk validate` command for a valid v2.4 `RemoteMCPServer` runtime. The
official v2.4 schema permits `spec.url` and `mcp_tool_description.file`. The
lifecycle `atk publish` package validator is authoritative for this package and
passes all 61 checks.

Do not change the valid MCP runtime to `local_endpoint` to silence that old
validator; doing so would describe an Office add-in local plugin, not this remote
MCP server.

## References

- [Publish agents for Microsoft 365 Copilot](https://learn.microsoft.com/microsoft-365/copilot/extensibility/publish)
- [Understand agent details in Microsoft 365 admin center](https://learn.microsoft.com/microsoft-365/admin/manage/agent-details)
- [Microsoft Agent 365 overview](https://learn.microsoft.com/microsoft-agent-365/overview)
- [Microsoft Entra Agent ID](https://learn.microsoft.com/entra/agent-id/what-is-microsoft-entra-agent-id)
- [Agent 365 BYO MCP setup](AGENT_365_BYO_MCP.md)

# Repository State

Last updated: 2026-08-06

This file is the tracked handover for future agents and cloud Copilot sessions.
It records the latest verified runtime state, active deployment assumptions, and
the shortest path to resume work safely.

## Current verified state

- Repo: `servicenow-mcp-apps-copilot`, branch `main`.
- Surface: MCP Apps only.
- Current inventory: 23 tools, 8 widgets.
- Primary deployed endpoint:
  `https://func-yj453fjwuhph4.azurewebsites.net/mcp`
- Primary Azure resource group: `rg-snowmcpwidg-dev`
- Current ServiceNow development instance:
  `https://dev351709.service-now.com`
- Current integration identity: `mcp_integration`

## Operational checkpoint

- Local ServiceNow validation is passing with current `local.settings.json`
  values (`npm run sn:local -- validate`).
- Deployed Function App has been migrated to `dev351709` and validated live.
- Entra CLI consent issue that previously blocked authenticated live tests is
  resolved.
- OBO is restored and enabled again on the deployed Function App.
- Step 1 manager approval actions are deployed: `approve_order_approval` and
  `reject_order_approval` both render the order-detail widget.
- The live endpoint exposes all 23 tools, including both approval actions.
- M365 agent package `1.1.5` was validated and applied to the existing tenant
  app `0d52a642-334e-4835-94b6-f6acc349569d`; OAuth registration was preserved.
- `npm run release:auto -- --environment snowmcpwidg-dev` is the verified
  automation path through the human M365 Copilot prompt-test boundary.
- Tenant policy `MCAPSGovDeployPolicies / StorageAccount_PublicNetwork_Modify`
  forces deployment storage public access off. Release automation creates a
  narrow temporary exemption only for that rule/account, removes it after
  deployment, and restores public access to `Disabled`.
- The Function App is integrated with `vnet-yj453fjwuhph4` and the deployment
  storage Blob endpoint is private (`pep-styj453fjwuhph4-blob`, Approved), so
  the app remains healthy after storage public access is disabled.
- Repeatable approval demo data is available through `npm run demo:seed`,
  `demo:verify`, and `demo:cleanup`; records are marker-owned and idempotent.
- Current pending demo fixtures on `dev351709`:
  - Alex action: `REQ0010003` (`b9444f5597220310a1cd3b90f053afc3`), approval
    `da44439997220310a1cd3b90f053af99`
  - admin action: `REQ0010004` (`1244439997220310a1cd3b90f053aff4`), approval
    `e644839997220310a1cd3b90f053af7f`
  - Alex/manager narrative: `REQ0010005`
    (`ba44839997220310a1cd3b90f053affc`), admin approval
    `4344079997220310a1cd3b90f053af1f`
- The deployed admin approval action was exercised successfully, then all three
  fixtures were reset to request/approval state `requested`.
- Agent package `1.1.5` was formally submitted to the test tenant organizational
  catalog with `atk publish` on 2026-08-06; all 61 package checks passed. Teams
  Admin Center approval remains required before `Last published` is expected to
  populate.
- The Admin Center `Entra agent ID` field is expected to be blank: this
  declarative Agents Toolkit app uses an OAuth application but has no explicitly
  associated Entra Agent ID. Do not substitute the OAuth client ID.
- The submitted ZIP contains 5,202 characters of resolved instructions. A blank
  Instructions panel is registry metadata ingestion/display, not missing package
  content.
- Publisher is Pavel Vecer while owner/creator is David Vecer; reassign the
  registry owner to the enduring owner or owning group during admin approval.
- Agent 365 CLI `1.1.165-preview` is installed and the complete 23-tool external
  MCP registration passes a no-mutation dry run. No real tool registration was
  submitted because an existing registry entry could not be safely ruled out.
- Release automation accepts `--agent-environment` independently from the azd
  `--environment`; it defaults to `dev`, while production must use a separately
  configured `prod` Agents Toolkit environment/app ID.
- Post-approval screenshots on 2026-08-06 confirm a second organizational
  registry record for `ServiceNow Assistantdev` v1.1.5. It shows Publisher type
  `Your org`, Created 6 August 2026, Last used `Never`, and blank Last published,
  Owner/Created by, and Entra agent ID. Its Data & tools view shows the
  RemoteMCPServer summary but not the expanded 23-operation list shown on the
  developer record.
- The submitted ZIP still contains all 23 functions and full instructions.
  Treat the reduced approved-record view as capability-dependent or delayed
  Agent Registry metadata, not tool loss. Test the approved copy specifically,
  assign an owner, and allow analytics/metadata synchronization before
  escalating or republishing.
- Published organizational agent still can't call tools although its package
  and live endpoint are healthy. The earlier diagnosis that Agent 365 Tools
  registration was required was incorrect.
- Submitted external server `ext_ServiceNowMCP` with all 23 tools on 2026-08-06.
  Agent 365 CLI `.default` handling failed to add the downstream permission, so
  the generated RemoteProxy was repaired with delegated `access_as_user`, a
  service principal, and an `AllPrincipals` consent grant. Future templates use
  the named scope.
- Tool approval is still pending. CLI approval failed with Unauthorized because
  the Agent 365 signed-in identity isn't AI Administrator or Global
  Administrator. An appropriately privileged admin must approve it under
  **Agents > Tools > Requests**, then the published agent must be reinstalled
  and tested in a new chat after propagation.
- The admin subsequently approved `ext_ServiceNowMCP`. The A365Proxy service
  principal has `Tools.ListInvoke.All`; RemoteProxy has tenant-wide delegated
  `access_as_user`; the live endpoint exposes 23 tools. This didn't enable the
  declarative agent. Official docs state Agent 365 BYO MCP preview supports
  Copilot Studio and coding clients, not Microsoft 365 Declarative Agents.
- Correct investigation target: native `RemoteMCPServer` plus
  `OAuthPluginVault` resolution for the published organizational package. A
  fresh HAR from the failing org-agent chat is required; the existing HAR is a
  June developer-copy capture and predates this failure.
- Selecting **Uninstall** on the published org agent removed its organizational
  registry projection entirely in this tenant; only the developer record
  remained as `Not available`, even with filters cleared. Recovery first checks
  Registry **Status > Available**; when no **Your org** record exists, resubmit
  the same package and approve it again. Version `1.1.5` was resubmitted on
  2026-08-06 and passed all 61 checks. Do not use `atk install`, which creates
  another developer copy.

## OBO / per-user attribution status

- Function App runtime settings are expected to be:
  - `ENTRA_OBO_ENABLED=true`
  - `ENTRA_OBO_DOWNSTREAM_SCOPE=api://8d73a1f1-5a04-42dd-bbdc-5da72feb6fc5/ServiceNow.Use`
- ServiceNow inbound OIDC trust on `dev351709` was repaired on 2026-08-05 with:
  - provider config `Entra MCP OBO`
  - oauth OIDC entity `Entra MCP OBO`
  - downstream audience/client ID:
    `8d73a1f1-5a04-42dd-bbdc-5da72feb6fc5`
  - user mapping: `preferred_username` -> `sys_user.email`
- Live deployed validation now passes in OBO mode:
  - `validate_servicenow_config` returns `authModeUsed=obo`
  - OBO exchange succeeds
  - catalog list/detail checks return HTTP 200
- On 2026-08-06, release-config auditing found that absent local OBO values had
  reprovisioned the Function with OBO disabled and an invalid Entra client
  secret. The active M365 OAuth credential was synchronized to ignored local
  settings, azd, and Key Vault; `release:auto` now preserves OBO values from
  local/azd configuration. Live `validate_servicenow_config` again reports
  `authModeUsed=obo` with exchange and catalog checks passing.
- Verified attribution behavior:
  - incident `INC0010012` was created through deployed `/mcp`
  - a comment was added through deployed `/mcp`
  - latest comment author was `System Administrator`
  - this matched the Entra caller
    `admin@D365DemoTSCE54115347.onmicrosoft.com`, which ServiceNow maps to user
    `admin`

## Important behavior

- Authorship in ServiceNow follows the effective ServiceNow session user.
- With OBO enabled, that user comes from the caller token only if the caller's
  Entra identity maps to a `sys_user` record in ServiceNow.
- Current mapping rule on `dev351709`: Entra `preferred_username` must match
  `sys_user.email`.
- If OBO exchange succeeds but ServiceNow rejects or cannot map the token, the
  request fails; it does not silently fall back to the integration user.

## Resume checklist

- Read [AUTH_ENTRA_OBO.md](AUTH_ENTRA_OBO.md) before changing any OBO or
  attribution behavior.
- Read [TROUBLESHOOTING.md](TROUBLESHOOTING.md) before rotating secrets or
  recreating ServiceNow auth objects.
- If widget HTML changes, always run `npm run build` before `npm test` because
  generated widget resources are rebuilt during the build step.
- For a test-tenant release, bump the M365 app patch version when tool schemas
  or annotations change, run `npm run release:auto -- --environment
  snowmcpwidg-dev`, test the developer copy, then use `npm run release:publish
  -- --environment snowmcpwidg-dev` for catalog submission.
- Read [AGENT_365_PUBLISHING.md](AGENT_365_PUBLISHING.md) before interpreting
  `Last published`, Entra Agent ID, Instructions, Environment, or tool-registry
  metadata in Microsoft 365 admin center.
- If a future task changes verified environment state, update this file in the
  same change so the state remains visible to repo-scoped and cloud agents.

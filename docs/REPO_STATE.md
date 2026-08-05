# Repository State

Last updated: 2026-08-05

This file is the tracked handover for future agents and cloud Copilot sessions.
It records the latest verified runtime state, active deployment assumptions, and
the shortest path to resume work safely.

## Current verified state

- Repo: `servicenow-mcp-apps-copilot`, branch `main`.
- Surface: MCP Apps only.
- Current inventory: 21 tools, 8 widgets.
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
- If a future task changes verified environment state, update this file in the
  same change so the state remains visible to repo-scoped and cloud agents.
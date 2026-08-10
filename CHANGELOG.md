# Changelog

<!-- markdownlint-disable MD024 -->

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

## [1.2.0] - 2026-08-10

### Added

- Add enforceable release planning and version checks for contributors.
<!-- release-impact: minor -->
- Add ranked, caller-visible ServiceNow Knowledge retrieval with a three-attempt resolution journey and consent-based incident escalation.
<!-- release-impact: minor -->

### Changed

### Fixed

## [1.1.6] - 2026-08-10

### Added

- **Manager approval actions.** Added `approve_order_approval` and
  `reject_order_approval`, pending approval controls in the order-detail MCP App,
  and ServiceNow request/approval ownership validation. The server now exposes
  23 tools and 8 widgets.
- **Copilot-ready release automation.** `npm run release:auto` now builds,
  tests, provisions, performs policy-aware Flex deployment, validates the live
  MCP tool surface, and updates the existing M365 agent package before stopping
  at the human prompt-test boundary. Policy-secured deployment storage uses a
  VNet, Blob private endpoint, and private DNS.
- **Repeatable approval demo fixtures.** `demo:seed`, `demo:verify`, and
  `demo:cleanup` create/reset or remove marker-owned requests, requested items,
  and pending approvals for Alex Baker and admin. Mutations use the signed-in
  Entra admin through the configured ServiceNow OBO trust; no admin password is
  stored.
- **Organizational-catalog release path.** Added `release:publish`, which runs
  the verified deployment flow and submits a version-bumped Agents Toolkit
  package for Teams Admin Center approval. Added a publication/governance
  runbook covering Agent 365 metadata and Entra Agent ID expectations.
- **Agent 365 tool inventory drift guard.** The BYO MCP registration template
  now contains all 23 tools, and tests require exact parity with the runtime
  manifest.
- **Per-user authorship via Entra OBO (Pattern A) — enabled.** ServiceNow writes
  now run **as the real end user** when `ENTRA_OBO_ENABLED=true`, so incident
  comments and attachments are authored by the user (`sys_created_by`) instead of
  the integration account. The OBO exchange ([src/services/oboTokenService.ts](src/services/oboTokenService.ts))
  was already implemented; enabling it is configuration only
  (`ENTRA_OBO_DOWNSTREAM_SCOPE` + an Entra app permission + a ServiceNow inbound
  OIDC trust). The dev deployment reuses an existing trusted audience rather than
  adding new ServiceNow records. See [docs/AUTH_ENTRA_OBO.md](docs/AUTH_ENTRA_OBO.md).
- **Remove incident attachments (MCP Apps).** New `remove_incident_attachment`
  tool plus a **Remove** button on each attachment in the incident-detail and
  my-incidents widgets. The server verifies the attachment belongs to the target
  incident before deleting it. At that stage, the server exposed 21 tools and
  8 widgets.
- **Resilient incident widgets.** The incident-detail and my-incidents widgets no
  longer blank out the detail when a host returns an empty widget-initiated tool
  result (observed in M365 Copilot); they retain the last good detail, classify
  results robustly, and fall back to a chat-driven follow-up so comments and
  attachment changes always land.
- **Incident management for end users (MCP Apps).** Six new tools —
  `get_incident_form`, `report_incident`, `list_user_incidents`,
  `get_incident_detail`, `add_incident_comment`, `add_incident_attachment` —
  and three new `ui://` widgets (incident-form, my-incidents, incident-detail).
  End users can report a problem, track their own incidents, read the
  customer-visible comment activity, add a comment, and attach a file/screenshot
  (max 5 MB). Incidents are attributed to the real caller via `caller_id`
  (delegated identity, same model as orders) and the list/detail views are
  caller-scoped. At that stage, the server exposed 20 tools and 8 widgets.
- Public-readiness pass: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, this changelog,
  GitHub issue/PR templates, and README **Roadmap**, **Contributing**, and
  **License** sections.
- `docs/SERVICENOW_SCENARIO_FLOWS.md` documents the end-to-end flow of every
  supported scenario and the ServiceNow APIs/tables each one touches.

### Changed

- **Order-detail lifecycle experience.** Reworked the order-detail MCP App into
  a glanceable Approval → Queued → Underway → Complete view with prominent
  phase guidance, explicit next steps, compact request facts and item stages,
  accessible approval validation and busy/error states, and responsive
  light/dark layouts. Approval actions now appear only when the server marks a
  caller-owned pending approval as actionable; request reads, updates, and
  approval decisions enforce caller ownership and strict ServiceNow `sys_id`
  validation. Widget-backed update and approval tools return compact model text
  with structured success/failure payloads.
- **Runtime-aligned Node types.** Constrained `@types/node` to the current Node
  20 line used by Azure Functions and configured Dependabot to ignore
  incompatible major updates while continuing to propose Node 20 patches and
  minors.
- **Security hardening.** Updated vulnerable transitive dependencies
  `@hono/node-server` and `ip-address`, and stopped development scripts from
  logging environment-derived identities and ServiceNow configuration values.
- **Organizational MCP action discovery.** Switched the declarative agent's
  bundled `RemoteMCPServer` action from a pinned 23-tool package snapshot to
  Microsoft 365 Agents Toolkit's current dynamic-discovery pattern
  (`functions: []`, `run_for_functions: ["*"]`). Package version `1.1.6` now
  resolves tools and MCP Apps metadata from the authenticated live server at
  runtime, avoiding the organizational catalog projection that retained the
  action summary but omitted its pinned operations.
- **OAuth lifecycle reconciliation.** Fixed `m365agents.yml` to use the actual
  suffixed OAuth environment variables, explicitly maintain the static OAuth
  registration as `AnyApp` within `HomeTenant`, and run `oauth/update` during
  provision. Release automation no longer deletes the OAuth lifecycle block.
  The existing vault record was verified as `AnyApp` and updated from
  `AnyTenant` to `HomeTenant` without another catalog submission.
- **Key Vault credential delivery.** Fixed the production HTTP 401 regression
  found through Application Insights. Function settings no longer pin historical
  Key Vault secret versions; every infrastructure provision writes fresh secret
  versions from secure azd inputs. Added a Key Vault private endpoint and
  `privatelink.vaultcore.azure.net` VNet DNS link so the Flex Function can resolve
  rotated credentials while vault public access remains disabled.
- Incident comment activity is now read from the incident record's own
  `comments` journal field (display value) instead of a direct
  `sys_journal_field` table query. The latter is gated by an out-of-box read ACL
  requiring the `admin` role, so the new approach works for a least-privilege
  scoped integration user (and for end-user OBO). No `sys_journal_field` access
  is required.
- Release automation preserves `ENTRA_OBO_ENABLED` and
  `ENTRA_OBO_DOWNSTREAM_SCOPE` from local/azd configuration so infrastructure
  provisioning cannot silently disable delegated ServiceNow access.
- Agent 365 registration now has a functional `-DryRun` mode that writes the
  ignored resolved payload and invokes the CLI's no-mutation validator. Generic
  PowerShell `-WhatIf` intentionally remains a full skip.
- Documented the observed metadata differences between developer-installed and
  approved organizational Agents Toolkit records, including incomplete expanded
  MCP operation metadata, separate usage counters, and owner assignment.
- Corrected Agent 365 external MCP registration to use the named
  `access_as_user` delegated scope. Documented that publishing an agent package
  doesn't automatically approve its remote MCP server in the tenant Tools
  registry.
- Corrected earlier guidance that implied Agent 365 BYO MCP approval could
  enable this Microsoft 365 Declarative Agent. Current preview documentation
  explicitly excludes declarative agents; investigation returned to the native
  `RemoteMCPServer` authentication configuration.
- Documented organizational-agent recovery after Admin Center Uninstall. The
  approved record might remain Available or disappear entirely; recovery checks
  filters first, then republishes/reapproves only when the org record is absent.
- `get_order_detail` now reads ServiceNow fields fetched with
  `sysparm_display_value=all` (handles both plain strings and
  `{ display_value, value }` objects).
- Genericized all live deployment identifiers (Function App host, tenant ID,
  Application Insights, resource group, azd env) to placeholders across the docs
  and the `m365-agent/` package so a fork never carries another tenant's names.
- Corrected the repository name (`servicenow-mcp-apps-copilot`) in
  `package.json` and the declarative-agent manifest.
- Added the copyright holder (Pavel Vecer) to the MIT `LICENSE`.

### Removed

- The `MCP_APPS_ENABLED` feature flag and the legacy Adaptive Card surface. MCP
  Apps is now the only surface: widget resources and `_meta.ui` are always
  registered, the cart and order line-item tools are always exposed, and every
  widget-backed tool returns compact `structuredContent` plus a concise, neutral
  `content` summary. The `buildOrderFormAdaptiveCard` /
  `buildCatalogItemSelectionAdaptiveCard` / `buildOrderConfirmationAdaptiveCard`
  builders and `src/utils/adaptiveCards.ts` are gone; the shared field helpers
  moved to `src/utils/catalogFields.ts`.

## [1.0.0]

### Initial release

- Stateless ServiceNow Service Catalog MCP server on Azure Functions
  (Flex Consumption), Node.js 20, TypeScript.
- MCP tools: `search_catalog_items`, `get_catalog_item_form`, `place_order`,
  `list_user_orders`, `get_order_detail`, `update_order`,
  `validate_servicenow_config`.
- MCP Apps (SEP-1865) surface behind `MCP_APPS_ENABLED`: five `ui://` widgets,
  the cart tools (`add_to_cart`, `view_cart`, `update_cart_item`,
  `remove_cart_item`, `submit_cart`) and per-item order edits
  (`update_order_item`, `remove_order_item`).
- OAuth 2.0 via Microsoft Entra ID for MCP clients; delegated identity
  attribution; opt-in Entra On-Behalf-Of token exchange.
- Azure infrastructure as Bicep, `azd` deployment, optional Azure Container
  Apps path, and the `m365-agent/` declarative-agent package.

[Unreleased]: https://github.com/pavecer/servicenow-mcp-apps-copilot/compare/v1.2.0...HEAD
[1.1.6]: https://github.com/pavecer/servicenow-mcp-apps-copilot/tree/d629c7ab1030a971658b69514b67a082ab43653a
[1.0.0]: https://github.com/pavecer/servicenow-mcp-apps-copilot/tree/3504769e45422609c7274ce1da46a636a1db1797

[1.2.0]: https://github.com/pavecer/servicenow-mcp-apps-copilot/releases/tag/v1.2.0

# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Incident comment activity is now read from the incident record's own
  `comments` journal field (display value) instead of a direct
  `sys_journal_field` table query. The latter is gated by an out-of-box read ACL
  requiring the `admin` role, so the new approach works for a least-privilege
  scoped integration user (and for end-user OBO). No `sys_journal_field` access
  is required.

### Added
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
  incident before deleting it. The server now exposes 21 tools and 8 widgets.
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
  caller-scoped. The server now exposes 20 tools and 8 widgets.

### Removed
- The `MCP_APPS_ENABLED` feature flag and the legacy Adaptive Card surface. MCP
  Apps is now the only surface: widget resources and `_meta.ui` are always
  registered, the cart and order line-item tools are always exposed, and every
  widget-backed tool returns compact `structuredContent` plus a concise, neutral
  `content` summary. The `buildOrderFormAdaptiveCard` /
  `buildCatalogItemSelectionAdaptiveCard` / `buildOrderConfirmationAdaptiveCard`
  builders and `src/utils/adaptiveCards.ts` are gone; the shared field helpers
  moved to `src/utils/catalogFields.ts`.

### Added
- Public-readiness pass: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, this changelog,
  GitHub issue/PR templates, and README **Roadmap**, **Contributing**, and
  **License** sections.

### Changed
- `get_order_detail` now reads ServiceNow fields fetched with
  `sysparm_display_value=all` (handles both plain strings and
  `{ display_value, value }` objects).
- Genericized all live deployment identifiers (Function App host, tenant ID,
  Application Insights, resource group, azd env) to placeholders across the docs
  and the `m365-agent/` package so a fork never carries another tenant's names.
- Corrected the repository name (`servicenow-mcp-apps-copilot`) in
  `package.json` and the declarative-agent manifest.
- Added the copyright holder (Pavel Vecer) to the MIT `LICENSE`.

### Added (docs)
- `docs/SERVICENOW_SCENARIO_FLOWS.md` — end-to-end flow of every supported
  scenario and the ServiceNow APIs/tables each one touches.

## [1.0.0]

### Added
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

[Unreleased]: https://github.com/pavecer/servicenow-mcp-apps-copilot/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/pavecer/servicenow-mcp-apps-copilot/releases/tag/v1.0.0

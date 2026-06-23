# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

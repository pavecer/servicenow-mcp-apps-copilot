# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] — 2026-06-23

### Added

- **MCP server on Azure Functions** — stateless Node.js 20 / TypeScript server exposing a full ServiceNow Service Catalog ordering surface over the [Model Context Protocol](https://modelcontextprotocol.io).
- **12 MCP tools**: `search_catalog_items`, `get_catalog_item_form`, `place_order`, `add_to_cart`, `view_cart`, `update_cart_item`, `remove_cart_item`, `submit_cart`, `list_user_orders`, `get_order_detail`, `update_order`, `validate_servicenow_config`.
- **MCP Apps (SEP-1865) widget rendering** — five self-contained HTML widgets (`catalog-browse`, `order-form`, `cart`, `my-orders`, `order-detail`) rendered inline in Microsoft 365 Copilot / Cowork when `MCP_APPS_ENABLED=true`.
- **Entra ID OAuth 2.0 protection** — per-user ****** validation, RFC 8414 / 9728 metadata endpoints, RFC 7591 Dynamic Client Registration, multi-tenant and custom audience support.
- **On-Behalf-Of (OBO) foundation** — `ENTRA_OBO_ENABLED` flag, downstream scope config, and `tokenManager.ts` hook ready for Pattern A (Entra OBO direct) and Pattern B (Entra OBO via Okta) — described in [`docs/AUTH_ENTRA_OBO_OKTA.md`](docs/AUTH_ENTRA_OBO_OKTA.md).
- **Declarative agent package** — [`m365-agent/`](m365-agent/) for sideloading via Microsoft 365 Agents Toolkit.
- **Azure Developer CLI (`azd`) support** — `azure.yaml` + `infra/main.bicep` for one-command Flex Consumption deployment with Key Vault secrets and managed identity.
- **Optional container deployment** — `Dockerfile` + Azure Container Apps path documented in [`docs/DEPLOY_CONTAINER_AZURE.md`](docs/DEPLOY_CONTAINER_AZURE.md).
- **CI/CD workflows** — GitHub Actions `ci.yml` (build + test on every push/PR) and `deploy.yml` (OIDC-authenticated `azd` deploy, inert until configured).
- **Feature flag gate** — `MCP_APPS_ENABLED=false` default preserves byte-identical legacy Adaptive Card surface for all existing clients.
- **Secret redaction logger** — `src/utils/logger.ts` strips tokens/secrets from all structured log output.
- **Cost estimation doc** — [`docs/COST_ESTIMATION.md`](docs/COST_ESTIMATION.md) with per-tool unit costs and scenario tables (pilot → enterprise).
- **Security guidelines** — [`SECURITY.md`](SECURITY.md), `.gitignore` patterns for HAR files, local settings, and private docs.
- **Copilot coding-agent support** — [`AGENTS.md`](AGENTS.md) with build/test commands, critical invariants, and repo structure for AI coding agents.

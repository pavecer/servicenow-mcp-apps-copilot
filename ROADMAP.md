# Roadmap

This document tracks planned improvements, known limitations, and longer-term ideas for the ServiceNow MCP Apps Copilot server.

Items are roughly ordered by priority. Community contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Near-term (next minor releases)

### Authentication & identity
- [ ] **Pattern A — Entra OBO direct**: complete the `tokenManager.ts` OBO exchange so each user's Entra token is traded for a native ServiceNow identity token (no per-user connection prompt). Foundation is in place; only the downstream exchange is missing. See [`docs/AUTH_ENTRA_OBO_OKTA.md`](docs/AUTH_ENTRA_OBO_OKTA.md).
- [ ] **Pattern B — Entra OBO via Okta**: implement the JWT-****** from Entra to Okta for organizations that use Okta as their ServiceNow IdP.
- [ ] **`SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN` enforcement**: complete the per-user token injection path so organizations that require strict per-user ServiceNow ACL enforcement can use the flag without a code change.

### Catalog & ordering
- [ ] **Category browsing tool** (`browse_catalog_categories`): allow users to explore the catalog hierarchy before searching.
- [ ] **Order approval actions**: surface pending approvals in `list_user_orders` and add an `approve_order` / `reject_order` tool for approvers.
- [ ] **Attachment support**: allow users to attach files to a request (for incidents/requests that require supporting evidence).
- [ ] **Variable type coverage**: expand `get_catalog_item_form` to handle all ServiceNow variable types (multi-row, reference, date pickers) beyond the current text/select/checkbox set.

### Widgets (MCP Apps)
- [ ] **Widget pagination**: the `my-orders` widget currently caps at the first page; add next/prev navigation.
- [ ] **Cart widget animations**: add item-add/remove transitions consistent with Fluent 2 motion tokens.
- [ ] **Accessibility audit**: full WCAG 2.1 AA audit of all five widgets.
- [ ] **Dark/high-contrast polish**: validate all widgets against the Teams high-contrast theme.

---

## Medium-term

- [ ] **Multi-tenant deployment guide**: document and test a scenario where a single MCP server instance serves multiple Entra tenants (using `ENTRA_TRUSTED_TENANT_IDS` / `ENTRA_ALLOW_ANY_TENANT`).
- [ ] **Knowledge base / incident tools**: extend beyond the service catalog to cover Incident Management (`create_incident`, `update_incident`, `list_my_incidents`) using the same architecture.
- [ ] **End-to-end integration tests**: add a Vitest suite that spins up a mock ServiceNow server and exercises the full tool → service → response chain.
- [ ] **`azd` multi-environment support**: document and test deploying dev / staging / prod environments from a single repo with environment-specific Bicep parameter files.
- [ ] **Power Platform connector package**: publish a ready-to-import custom connector definition for Power Automate / Power Apps users.

---

## Long-term / ideas

- [ ] **ServiceNow scoped app**: optional ServiceNow-side scoped application that installs the OAuth app, integration user, and ACL rules in one Update Set — reducing the manual setup steps.
- [ ] **Azure API Management gateway**: optional APIM layer in front of the Function App for enterprise rate limiting, policy enforcement, and centralized OAuth token caching.
- [ ] **GitHub Actions reusable workflow**: a reusable workflow other repos can call to deploy a fork of this server into their own Azure subscription.
- [ ] **Terraform / OpenTofu infra option**: alternative to the Bicep `infra/main.bicep` for teams that standardize on Terraform.

---

## Known limitations (v1.0.0)

| Limitation | Tracking |
|---|---|
| OBO token exchange not yet implemented — integration-user password grant only | Near-term |
| `get_catalog_item_form` handles text / single-select / checkbox variables; other types rendered as text | Near-term |
| `my-orders` widget paginates only the first 20 records | Near-term |
| No approval-action tools | Medium-term |
| Container deployment does not yet support Azure Container Registry private image pull with managed identity in the Bicep templates | Medium-term |

---

Found a gap or have an idea? [Open a GitHub issue](https://github.com/pavecer/servicenow-mcp-apps-copilot/issues/new) or submit a PR.

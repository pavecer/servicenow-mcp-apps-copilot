# Microsoft 365 Copilot MCP Apps integration

> This repo is a **standalone project dedicated to the MCP Apps capability** —
> delivering ServiceNow catalog ordering to Microsoft 365 Copilot / Cowork. (It
> began as a fork of `mcp-server-servicenow` and was promoted to its own repo on
> 2026-06-15.) For the full build-and-debug story (every bug we hit and how it
> was fixed) see [`DEVELOPMENT_JOURNAL.md`](../DEVELOPMENT_JOURNAL.md).

This server optionally exposes [SEP-1865 "MCP Apps"][sep-1865] widget UIs that
render inline inside Microsoft 365 Copilot. When you ask the agent to "order a
laptop" or "show my open ServiceNow orders", Copilot mounts a sandboxed
HTML iframe right in the chat — backed by the same MCP tools an MCP client
(such as a Copilot Studio agent) can call.

[sep-1865]: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx

## Live deployment

| What | Value |
| --- | --- |
| Function app | `func-yj453fjwuhph4` (RG `rg-snowmcpwidg-dev`, westeurope) |
| MCP endpoint | `https://func-yj453fjwuhph4.azurewebsites.net/mcp` |
| Feature flag | `MCP_APPS_ENABLED=true` (set on this app) |
| azd env | `snowmcpwidg-dev` — deploy with `azd deploy api -e snowmcpwidg-dev` |
| ServiceNow | `https://dev310193.service-now.com` (admin / password grant) |
| Telemetry | App Insights `appi-yj453fjwuhph4` (AppId `2985a951-eef7-4587-8ff1-edf043211e08`) |

> The original (pre-MCP-Apps) MCP server runs on a **separate** function app
> (`func-xflvdzmohd3e2`, RG `rg-dev-alt-tenant`, no `MCP_APPS_ENABLED`) and is
> not affected by anything in this repo.

## TL;DR

| What | Where |
| --- | --- |
| **Feature flag (server)** | `MCP_APPS_ENABLED=true` on the deployed function app |
| **Widget resources** | Served at `ui://servicenow-mcp/{name}.html` via MCP `resources/read` |
| **Tool decoration** | `_meta.ui.resourceUri` injected into `tools/list` for the four widget tools |
| **Declarative agent** | [`m365-agent/`](../m365-agent/README.md) — sideload with M365 Agents Toolkit |
| **Spec docs** | [Microsoft Learn: plugin-mcp-apps][learn-plugin], [Cowork host guide][learn-cowork] |

[learn-plugin]: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-mcp-apps
[learn-cowork]: https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/mcp-apps-support

## Why a feature flag?

The widget integration is purely additive, but enabling it changes two MCP
surfaces:

1. `tools/list` entries for `search_catalog_items`, `get_catalog_item_form`,
   `list_user_orders`, and `get_order_detail` gain a `_meta.ui.resourceUri`
   field.
2. `initialize` advertises the `resources` capability so the host can call
   `resources/list` / `resources/read`.

Existing Copilot Studio agents (`employee-self-service-it`,
`ess-servicenow-catalog-extension`, `[CTOP] - SnowMCP OrderCat`) only consume
the `adaptiveCard` field inside `content[0].text` — that text payload is
preserved **byte-for-byte** regardless of the flag. The flag is **off by
default** so you can deploy this code without disturbing any agent currently
in production, then flip it after validating in dev.

## Widgets shipped

| Tool                    | Widget URI                                       | Purpose                                                  |
| ----------------------- | ------------------------------------------------ | -------------------------------------------------------- |
| `search_catalog_items`  | `ui://servicenow-mcp/catalog-browse.html`        | Grid of catalog items; click → opens the order form      |
| `get_catalog_item_form` | `ui://servicenow-mcp/order-form.html`            | Inline form; submit → invokes `place_order`              |
| `list_user_orders`      | `ui://servicenow-mcp/my-orders.html`             | Table of open orders; click row → opens detail widget    |
| `get_order_detail`      | `ui://servicenow-mcp/order-detail.html`          | Single request: items, approvals, comment / cancel form  |

All widgets are vanilla HTML with inline CSS/JS (no external CDN), authored
under [`src/ui/widgets/src/`](../src/ui/widgets/src/) and embedded as TS
string constants at build time by
[`scripts/dev/build-widgets.mjs`](../scripts/dev/build-widgets.mjs). The
generated `src/ui/widgets/generated/` folder is gitignored — `npm run build`
and `npm test` regenerate it.

> **Build-tool gotcha (hard-won):** the generated HTML is stored as **base64**
> and injected with a *replacement function*, not a replacement string. A plain
> `String.replace(marker, bundle)` corrupts the output because the minified
> bundle contains `` $` ``, `$&`, and `$$` sequences that `String.replace`
> interprets specially. See the journal entry #2.

### Host bridge & interaction model

Every widget loads `src/ui/widgets/bridge/host-bridge.ts` (bundled and injected
at the `<!-- MCP_HOST_BRIDGE -->` marker). It exposes a small `window.mcpHost`
facade and works with **both** host bridges Microsoft documents — the OpenAI
Apps SDK (`window.openai.*`) and the MCP Apps `App` postMessage protocol — with
a visible self-diagnostic if neither delivers data within 5s.

| Interaction | Bridge call | Why |
| --- | --- | --- |
| Navigate (card click → open form, row click → open detail) | `sendFollowUp(...)` | A widget-initiated `callTool` returns data only to the *same* widget; only the **agent** can mount a *new* widget, so we drive it with a follow-up message. |
| Action (submit order, post comment) | `callTool(...)` with `sendFollowUp` fallback | Reliable and **traceable** in telemetry; re-renders the confirmation in place. A `settled` guard prevents double-submit. |
| Open ServiceNow record | `openExternal(url)` | The sandboxed iframe can't navigate via `<a target="_blank">`; routes through `window.openai.openExternal` → `app.openLink`. |

Each widget honours `window.openai.theme` / `displayMode` (inline + fullscreen;
PIP is not supported by Cowork), reads `toolOutput` for initial state, and
degrades gracefully if the bridge is absent — the agent still has the full text
payload to answer the user.

## Server requirements per the Microsoft docs

The M365 Copilot host enforces:

- **Authentication** — OAuth 2.1 or Microsoft Entra SSO. This repo uses
  Entra; reuse the existing `ENTRA_CLIENT_ID` / `ENTRA_TENANT_ID` and add
  these redirect URIs to the app registration:
  - `https://teams.microsoft.com/api/platform/v1.0/oAuthConsentRedirect` —
    M365 Copilot SSO consent
  - `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect` —
    M365 Copilot OAuth 2.1 redirect
  - `https://vscode.dev/redirect` — Agents Toolkit "Fetch action from MCP"
- **CORS for the widget host** — the widget renders under
  `{sha256(mcp-domain)}.widget-renderer.usercontent.microsoft.com`. Cowork
  brokers `tools/call` and `resources/read` server-to-server, so the inlined
  widgets in this repo do not need direct browser fetches and CORS does
  **not** need to be widened. Use <https://aka.ms/mcpwidgeturlgenerator> if
  you ever add direct outbound calls.

## Per-user identity ("Opened by") — OBO status

Today the server authenticates to ServiceNow with the `admin` integration
account (password grant), so ServiceNow stamps **"Opened by" = System
Administrator**. "Requested for" is correct because `place_order` sets
`sysparm_requested_for` from the M365 caller's Entra `upn`/`oid`.

To make **"Opened by" the real user**, enable the **Entra On-Behalf-Of (OBO)**
path. This is documented and supported for MCP Apps (Microsoft Learn:
*"OAuth 2.1 and Microsoft Entra SSO are supported"*; the on-behalf-of flow for a
custom MCP server is a first-class pattern), and it **does not change the widget
contract** — Cowork/M365 attach auth at the channel level.

The OBO machinery is **already implemented and unit-tested** in this repo and is
gated behind two app settings (off by default):

- `src/services/oboTokenService.ts` — MSAL `acquireTokenOnBehalfOf` + per-user
  cache + single-flight.
- `src/services/servicenowClient.ts` interceptor prefers OBO when
  `ENTRA_OBO_ENABLED=true` and `ENTRA_OBO_DOWNSTREAM_SCOPE` is set, else falls
  back to the integration user.

Enabling it is **configuration**, not code, but has real external dependencies:
ServiceNow must trust Entra as an OIDC provider, users must map to a `sys_user`,
and per-user ServiceNow ACLs then apply. **Pilot in a test ServiceNow instance
first.** Full runbook: [`docs/AUTH_ENTRA_OBO_OKTA.md`](AUTH_ENTRA_OBO_OKTA.md)
and the journal's *"last task"* section.

## Enable & validate

```bash
# 1. Local dev — flag on
export MCP_APPS_ENABLED=true
npm install       # node_modules is NOT copied into this fork
npm test          # 177 tests pass; the gating + widget + field suites cover the flag-on path
npm run build
npm run smoke:test  # against `func start` if you have one

# 2. Inspect with MCP Inspector
npx @modelcontextprotocol/inspector http://localhost:8080/mcp
#   resources/list  → four ui:// resources
#   resources/read  → text/html;profile=mcp-app body
#   tools/list      → _meta.ui.resourceUri present on the four widget tools

# 3. Sideload the declarative agent
cd m365-agent
cp env/.env.dev env/.env.dev.user      # fill in MCP_SERVER_URL / DOMAIN
#   then use the M365 Agents Toolkit VS Code extension → Provision

# 4. Production — set the app setting and recycle
az functionapp config appsettings set \
  --name <function-app> \
  --resource-group <rg> \
  --settings MCP_APPS_ENABLED=true
```

## Regression — Copilot Studio surface stays byte-identical

The repo's vitest suite includes explicit gating tests that prove this:

- [`test/mcpAppsGating.test.ts`](../test/mcpAppsGating.test.ts) — when the
  flag is off, `getMinimalToolDefinitions()` carries no `_meta` field on any
  tool and `getWidgetForTool()` returns `undefined`.
- [`test/widgetResources.test.ts`](../test/widgetResources.test.ts) —
  flag-off registers zero resources; flag-on registers exactly four with the
  spec-mandated `text/html;profile=mcp-app` mime.
- [`test/widgetStructuredContent.test.ts`](../test/widgetStructuredContent.test.ts) —
  flag-off responses do not include `structuredContent`; flag-on responses
  stay well under the 64 KiB cap.

The pre-existing test suite (manifest content parity, prefill,
adaptive-card emission, update_order, list-orders concurrency, …) continues
to pass unchanged — **177 tests across 23 files**. Run `npm test` to verify.
The widget-specific suites also include `test/widgetFieldExploration.test.ts`,
which maps real catalog-item variable types against the widget field schema
using captured fixtures in `test/fixtures/catalogItems.json`.

# Development journal — MCP Apps widget capability

> This repo started as the **MCP Apps fork** of `mcp-server-servicenow` and, on
> 2026-06-15, was promoted to a **standalone private repo**
> (`github.com/pavecer/mcp-server-servicenow-mcp-apps`) with its own fresh git
> history. The legacy Copilot Studio agent exports and connector docs were
> removed at that point so the repo is dedicated to delivering ServiceNow
> catalog ordering to Microsoft 365 Copilot / Cowork via MCP Apps. This file is
> the "lab notebook" for that work — what we built, the bugs we hit, and how each
> was fixed (mostly the hard way, with a real headless browser). Some entries
> below predate the split and still describe the fork layout for historical
> context.

## Repo & deployment map (READ FIRST)

| Thing | Value |
| --- | --- |
| **This repo** | `mcp-server-servicenow-mcp-apps` — now a standalone private repo at `github.com/pavecer/mcp-server-servicenow-mcp-apps` (fresh history; squashed initial commit). Originally forked from public `mcp-server-servicenow` at base commit `bab317a`. |
| **Original public repo** | `mcp-server-servicenow` — restored to a clean `origin/main` (`bab317a`). Contains **no** MCP Apps code. The public GitHub repo was never pushed any of this work. |
| **This fork's function app** | `func-yj453fjwuhph4` in RG `rg-snowmcpwidg-dev` (westeurope), `MCP_APPS_ENABLED=true`. MCP endpoint `https://func-yj453fjwuhph4.azurewebsites.net/mcp`, `/health` 200. azd env `snowmcpwidg-dev`. |
| **Original repo's function app** | `func-xflvdzmohd3e2` in RG `rg-dev-alt-tenant` — **no** `MCP_APPS_ENABLED`. Pre-MCP-Apps MCP server. Never touched by the widget work. |
| Subscription | `ff6e6a8b-29f6-4666-b4b0-ff238c72bb23` |
| ServiceNow dev instance | `https://dev310193.service-now.com` (admin / password grant) |
| Deploy command | `azd deploy api -e snowmcpwidg-dev` (~1m30s) |
| Build widgets | `npm run build:widgets` (regenerates `src/ui/widgets/generated/*.ts`) |
| Tests | `npx vitest run` — 177 passing (23 files) |

> `node_modules/` was **not** copied into this fork to save space. Run
> `npm install` before building or testing.

## What we built

A SEP-1865 "MCP Apps" widget layer on top of the existing ServiceNow MCP tools,
rendering inline inside Microsoft 365 Copilot:

- **Host bridge** — `src/ui/widgets/bridge/host-bridge.ts`, a dual-mode,
  self-diagnosing bootstrap bundled by `scripts/dev/build-widgets.mjs` and
  injected into every widget. It exposes a small `window.mcpHost` facade
  (`onData`, `getData`, `markRendered`, `callTool`, `sendFollowUp`,
  `openExternal`, `applyTheme`, `diagnostics`). It works with **both** the
  OpenAI Apps SDK (`window.openai.*`) and the MCP Apps `App` postMessage bridge,
  and falls back to a visible diagnostic if neither delivers data within 5s.
- **Four widgets** — `src/ui/widgets/src/`:
  - `catalog-browse.html` — grid of catalog items; click a card → opens the order form.
  - `order-form.html` — typed form (checkboxes, dropdowns, textareas, section
    headers, email) with submit → `place_order` → in-place confirmation.
  - `my-orders.html` — table of the user's open orders; click a row → order detail.
  - `order-detail.html` — one request with items, approvals, comment / cancel, and
    a "View in ServiceNow" deep link.
- **`get_order_detail` tool** + per-tool widget binding (`_meta.ui.resourceUri`),
  gated behind `MCP_APPS_ENABLED` (off by default → byte-identical to the
  Copilot Studio surface).
- **`m365-agent/`** — the declarative-agent package for sideloading.

## The journey (bugs & fixes, in order)

1. **Stuck loading / blank widget** — Azure Functions intercepts the CORS
   OPTIONS preflight before Express, so app-level CORS couldn't fix it. Fixed
   with **platform-level** CORS on the function app + `infra/main.bicep`
   `siteConfig.cors` including the widget-renderer origins.

2. **Widget never rendered (THE root cause)** — discovered via a real headless
   browser (playwright-core + cached Chrome): the page threw
   `missing ) after argument list` and served HTML had 19 `<!doctype html>`.
   Cause: `build-widgets.mjs` inlined the bundle with `html.replace(MARKER, str)`
   — and `String.replace` treats `$\``, `$&`, `$$` specially in the replacement
   string, so the minified zod bundle's `$\`` sequences corrupted the HTML.
   **Fix: use a replacement *function* `() => bridgeScriptTag`, and store the
   generated HTML as base64.** Lesson burned in: *test the actual artifact in a
   real browser, don't reason about the protocol.*

3. **Card click did nothing** — a widget-initiated `callTool` only returns data
   to the *same* widget; it can't mount a *new* one. **Fix: navigation clicks
   use `sendFollowUp`** so the agent calls the next tool and mounts the next
   widget.

4. **Verbose query → 0 results** — ServiceNow `sysparm_text` is a literal match,
   so "I need to order a new laptop." found nothing. **Fix:
   `buildSearchTermCandidates()`** tries verbatim → punctuation-stripped →
   stopwords-stripped keywords → longest keyword, returns the first non-empty.

5. **Wrong field types in the order form** — every field rendered as a plain
   text box. `normalizeVariableType()` returns `friendly_type` first
   (`check_box`, `container_start`, `multi_line_text`), but the widget mapper
   only knew string names + numeric `2`. **Fix: `toWidgetFieldType()` mirrors
   the Adaptive Card classifier** — `container_start`/label → section header,
   `check_box` → checkbox, `multi_line_text` → textarea, plus number/date/email.
   Verified empirically against 14 real catalog items
   (`test/widgetFieldExploration.test.ts`, `test/fixtures/catalogItems.json`).

6. **Submit "did nothing"** — confirmed via App Insights that `place_order`
   never reached the backend; the `sendFollowUp`-only submit relied on the model
   deciding to call the tool, and it didn't. **Fix: submit calls
   `place_order` directly via `callTool`** (reliable + traceable), renders the
   confirmation in place, and falls back to `sendFollowUp` only if `callTool`
   is gated. A `settled` guard ensures the order is placed exactly once.

7. **"View in ServiceNow" link errored** — two causes: (a) the sandboxed widget
   iframe can't navigate via a plain `<a target="_blank">`; (b) the
   `nav_to.do?uri=sc_request.do?sys_id=` URL has a nested unencoded `?`.
   **Fix:** added `openExternal()` to the bridge
   (`window.openai.openExternal` → `app.openLink` → `window.open` fallback) and
   switched to the clean direct record URL `…/sc_request.do?sys_id=<id>`.

8. **Backend telemetry** — App Insights + Log Analytics were already wired
   (`appi-yj453fjwuhph4`, AppId `2985a951-eef7-4587-8ff1-edf043211e08`). Added
   the MCP method/tool name to the request-completion log
   (`summarizeMcpBody()` → e.g. `tools/call:place_order`, PII-safe). Query:
   `az monitor app-insights query --app <AppId> --analytics-query "traces | where timestamp > ago(1h) | project timestamp, message | order by timestamp desc"`.

## The last task — per-user identity / "Opened by" (auth)

ServiceNow stamped **"Opened by" = System Administrator** because the server
authenticates with the `admin` integration account (password grant); ServiceNow
stamps `opened_by`/`sys_created_by` with **whoever authenticates the REST call**.
("Requested for" is correct because `placeOrder` explicitly sets
`sysparm_requested_for` from the M365 caller's Entra `upn`/`oid`.)

### Solution shipped (2026-06-15) — patch the ownership fields

We verified live against `dev310193` that **PATCHing `opened_by` on the created
`sc_request` sticks** (no business rule re-stamps it). So `placeOrder` now, after
`order_now`, resolves the **caller's** `sys_user` sys_id and patches
`opened_by` + `requested_by` (the ordering user) alongside `requested_for` (the
beneficiary) — on both the `sc_request` and its `sc_req_item` rows. Gated by
`SERVICENOW_ATTRIBUTE_OWNERSHIP_TO_CALLER` (default **on**; set `false` if the
integration user lacks write access to `opened_by`). Code:
`src/services/servicenowClient.ts` (`resolveCallerSysId`,
`patchRequestAttribution`, `patchRequestItemsAttribution`), `src/config.ts`;
test `test/placeOrderAttribution.test.ts`. This makes "Opened by" the real user
**without** ServiceNow OIDC trust or Entra reconfiguration — the record is still
authenticated by the integration user under the hood, but every visible
ownership field shows the requester.

### Deeper option (still available) — Entra OBO for true per-user ACLs

For the REST call itself to run **as the end user** (so ServiceNow ACLs apply
per user, not the integration user's), use Entra On-Behalf-Of. This is
**documented and supported**:

- **MCP Apps** in M365 Copilot: *"Authentication — OAuth 2.1 and Microsoft Entra
  SSO are supported."* (also confirms `openExternal` → `openLink` is supported).
- **`api-plugin-authentication`**: the exact Entra-SSO-for-MCP recipe, including
  the killer line: *"If your MCP server uses the on-behalf-of flow … return a
  401 Unauthorized to cause the agent to prompt the user to sign in to grant
  consent."* — exactly our case.
- **`advanced-custom-connector-on-behalf-of`**: *"Create a service app
  registration for your custom API or Model Context Protocol (MCP) server"* +
  *"Enable on-behalf-of login: true"*.
- **Cowork**: *"Cowork brokers all widget→server traffic through an
  authenticated, per-session channel. User credentials are never exposed to the
  iframe — Cowork attaches the appropriate auth on the widget's behalf."* → so
  switching to Entra SSO **does not break the widgets** in M365 or Cowork; auth
  is channel-level and the widget contract is unchanged.

**OBO code is already implemented and tested (gated off):**

- `src/utils/entraAuthMiddleware.ts` captures `res.locals.callerAccessToken`.
- `src/requestContext.ts` carries it through.
- `src/services/oboTokenService.ts` — complete MSAL `acquireTokenOnBehalfOf`
  with per-user cache + single-flight (has unit tests).
- `src/services/servicenowClient.ts` interceptor already prefers OBO when
  `isOboEnabled()`, falling back to the integration user.
- `src/config.ts` reads `ENTRA_OBO_ENABLED` + `ENTRA_OBO_DOWNSTREAM_SCOPE`.

So enabling OBO is **configuration**, gated behind two app settings (currently
off). The only suggested code tweak is mapping the OBO "consent required"
failure to an HTTP **401** so Copilot shows the sign-in prompt.

**Remaining real dependencies / risks for OBO (not code):**
1. ServiceNow must trust **Entra as an OIDC provider** (admin + governance).
2. Entra users must map deterministically to a `sys_user` (email/UPN).
3. Per-user ACLs then apply — `admin` currently bypasses them, so real users
   need catalog-ordering rights. **Pilot in a test ServiceNow instance first.**

Runbook: [`docs/AUTH_ENTRA_OBO_OKTA.md`](docs/AUTH_ENTRA_OBO_OKTA.md). Status:
**"Opened by" fix shipped**; OBO researched and ready but not enabled.

## Lessons worth keeping

- **Test the real artifact in a real browser**, not the protocol in your head.
  Every hard bug here was found by loading the actual generated widget HTML in
  Chrome with a faked `window.openai`.
- When inlining a large bundle via `.replace`, **always use a function
  replacement** — `$`-sequences silently corrupt a replacement string.
- **Navigation** clicks use `sendFollowUp` (agent mounts the next widget);
  **actions** (place_order, update_order) use `callTool` (reliable + traceable),
  with `sendFollowUp` as a fallback. Never both — guard against double-submit.
- **External links** must go through the host bridge `openExternal`; the
  sandbox blocks direct navigation.
- ServiceNow `sysparm_text` is literal — strip stopwords for natural-language
  queries; `normalizeVariableType` returns `friendly_type` first, so map those.

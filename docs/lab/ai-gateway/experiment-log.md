# AI Gateway governance lab: experiment log

## Scope and evidence rules

Phase 0 was read-only. The user then approved running all phases end to end
(budget at most USD 20, Entra apps, ServiceNow OIDC trust and M365 gateway
consent included), stopping only for blockers. No runtime keys or user tokens
are written to evidence; caller tokens are recorded as claim shapes only. All
timestamps are UTC, date 2026-10-15.

The existing sibling checkout is on an unrelated maintenance branch. This lab
uses an isolated, detached worktree of `origin/main` at
`48647e1`; the lab implementation branch is deferred until Phase 1.

## Initial discovery (not preregistered experiments)

Observed 2026-10-15T08:17:00Z through 08:21:00Z:

- Azure CLI account matches the requested tenant, subscription, and admin UPN.
  This verifies sign-in context, not the Global Administrator role.
- Subscription is enabled, named Visual Studio Enterprise Subscription.
- Existing azd environment: `snowmcpwidg-dev`; no `snowmcp-gwlab` in the existing
  checkout. No existing environment was selected or changed.
- Provider registration: Web registered; ApiManagement, CognitiveServices,
  KeyVault, Storage, and OperationalInsights not registered.
- The repository's 2026-10-05 handover says runtime identity migration is
  incomplete. Live configuration must be checked before adopting this as fact.
- Playwright MCP could not initialize because its configured Chrome executable
  is absent. VS Code integrated browser successfully opened the public gateway
  landing page. This is a local tooling issue, not a gateway documentation defect.

## Preregistered Phase 0 checks

Predictions below were written before running these checks. Discovery above is
explicitly separate so retrospective observations are not presented as predictions.

### P0-DOC: public documentation accessibility and contract

- Prediction: the ten cited Microsoft Learn URLs and gateway portal are public
  and reachable. Documentation describes API-key runtime auth but does not prove
  caller bearer-token passthrough. Documentation reachability alone will not
  validate the end-to-end procedure.
- Steps: GET each cited URL; retain status, final URL and title, not cookies or
  raw headers. Read the gateway overview, quickstart, asset management, Agent 365
  and threat protection articles. Capture browser screenshots of discrepancies.
- Expected: HTTP 200 documentation; a sign-in entry point on the gateway portal.
- Observed (2026-10-15T08:21Z-08:35Z): nine URLs initially returned 200;
  the classic MCP article initially returned 404, then returned 200 in
  PowerShell, browser and Learn fetch. The quickstart specifies management API
  `2026-05-01-preview`; the threat protection PATCH uses `2025-09-01-preview`.
  Backend caller-token forwarding remains undocumented/unproven. The public
  portal loaded; after interactive browser sign-in and reload, onboarding
  exposed the correct subscription. Region defaults to East US 2; resource-group
  controls are directly in the dialog. Microsoft 365 Agents > Settings >
  Gateways exists; Azure is not connected and consent is unchecked. No consent
  or Create action was submitted by the assistant.
- Evidence: initial HTTP results (local: `evidence/documentation-links.json`),
  recheck (local: `evidence/documentation-recheck.json`),
  quickstart version (local: `screenshots/quickstart-api-version.png`),
  threat version (local: `screenshots/threat-policy-api-version-suffix.png`),
  gateway form (local: `screenshots/gateway-create-preflight.png`),
  gateway admin panel (local: `screenshots/m365-gateways-not-connected.png`).
  Complete procedure and runtime outcomes are still untested.
- Verdict: partial.

### P0-SN: ServiceNow wake and integration readiness

- Prediction: the configured developer instance may be hibernating. Even if the
  integration readiness script passes, it cannot prove per-user OBO or ACLs,
  because it uses the integration identity's password-grant token.
- Steps: inspect only allowlisted non-secret local configuration; require exact
  instance match before running the repository's unchanged
  `npm run preflight:readiness`. GET the instance login page. No demo seed,
  approvals, incidents, setup scripts or cleanup.
- Expected: reachable login and successful IT/KB probes if instance/credentials
  remain active. Optional HR failures are recorded separately.
- Observed (2026-10-15T08:21Z-08:24Z): login 200; readiness command exit 0.
  Catalog/incident 200 with one row each; Knowledge article/category tables
  200 with zero rows each. HR case/profile 400 Invalid table. The script's
  IT/KB summary says PASS, but article visibility and delegated ACLs are not
  established. No business records were created.
- Evidence: sanitized results (local: `evidence/preflight-results.json`),
  [interpretation](runbooks/00-preflight.md#5-servicenow-readiness).
  ServiceNow record number/created-by/opened-by: not applicable to these reads.
- Verdict: partial.

### P0-AZ: deployment and identity prerequisites

- Prediction: the fresh subscription lacks providers and model quota; existing
  runtime configuration may still belong to the retired tenant. Administrative
  sign-in alone does not establish Azure RBAC or Agent 365 licensing.
- Steps: read subscription resources, provider metadata, Sweden Central model
  catalog/usage, role assignments and tenant SKU/role information if permitted.
  Inspect only non-secret tenant/audience values from existing local settings.
- Expected: explicit blockers rather than automatic provider registration,
  role grants, resource creation or trust modification.
- Observed (2026-10-15T08:21Z-08:35Z): Azure CLI context matches; Owner and
  active Global Administrator confirmed. Agent 365 plans and Agent Tools
  service principal exist. The independent azd session is a different account.
  Most required providers are unregistered; usage API returns [] (quota
  unverified, not zero). Model catalog lists small chat candidates but no model
  account exists. Existing local runtime settings belong to the retired tenant;
  both old app IDs are absent from Contoso's app-registration list. Local auth
  bypass is enabled; these settings must not be copied. Current Bicep adds
  two private endpoints and two DNS zones, omitted by older repo cost prose.
  Private endpoint meter is USD 0.01/hour each. Gateway pricing is unpublished.
- Evidence: sanitized results (local: `evidence/preflight-results.json`),
  retail meters (local: `evidence/network-retail-prices.json`),
  pricing docs (local: `screenshots/preview-pricing-unpublished.png`),
  [complete preflight report](runbooks/00-preflight.md).
- Verdict: partial.

## Runtime experiments

Lab topology: Function `func-<token>` (Flex Consumption, Sweden Central,
lab Entra apps `snowmcp-gwlab-*`, OBO to ServiceNow `<servicenow-instance>` via an OIDC
provider), AI Gateway `snowmcp-gwlab-aigw` (`Microsoft.ApiManagement/aigateways`,
Sweden Central, ARM API `2026-09-01-preview`), MCP server `servicenow` with
backend = Function `/mcp`. Harness: `scripts/lab/ai-gateway/run-experiments.mjs`.
Backend view: `LAB_REQUEST_DIAGNOSTICS=true` traces in App Insights
`appi-<token>`. IDs below follow the spec; where the lab's evidence label
differs it is noted.

### Baseline: direct path (Phase 2)

- Prediction: with the lab Entra apps and the ServiceNow OIDC trust in place, a
  delegated `access_as_user` token reaches the Function, OBO succeeds and the
  record is created as the signed-in user, not the integration user.
- Observed 09:07-09:28: `tools/list` 200, 27 tools. No bearer -> 401. First
  user calls returned `isError` until the stale Key Vault OBO secret was fixed
  (`azd provision --no-state`) and the ServiceNow OIDC provider/entity were
  created. Then `report_incident` created **`<incident-1>`** with
  `opened_by = the lab user`, `sys_created_by = <admin-upn>`,
  integration user not used.
- Evidence: attribution (local: `evidence/attribution-direct-baseline.json`),
  `evidence/runs/*direct-baseline*.json`,
  OIDC entity (local: `screenshots/11-servicenow-oidc-entity-gwlab.png`).
- Verdict: **pass** - per-user attribution works on the direct path.

### Gateway setup (Phase 3, portal)

- Observed 09:30-09:34: gateway created in the AI Gateway portal in about
  1 minute (UI states 8-10 minutes). MCP server wizard:
  backend auth choices None / API key (header or query) / OAuth 2.0 / managed
  identity. The tools step offers **Allow all tools** or a **name pattern** plus
  a **blocked tools** list; there is no "static list of allowed tools" as the
  docs require for Agent 365 tool-level control. API key creation has no owner
  field. Entra ID access tab exists but is undocumented.
- Evidence: screenshots 12-29.

### A1: caller sends `api-key` + user `Authorization`, backend auth None

- Prediction: the gateway forwards the caller's `Authorization` so OBO works.
- Observed 09:35: with key + bearer, gateway returns **400** on `initialize`
  (B1/B2/B3 runs with bearer have `gatewayCount: 0`, B3 gateway 400). Key only:
  `tools/list` 200, 27 tools (`list-gateway-A1`). No key: 401 (`A1-nokey`).
- Verdict: **fail** - the two credentials cannot be combined.

### A2 (lab label `A2-keyonly`): key-only call to an OBO tool

- Observed 09:37: `tools/call search_catalog_items` -> 200
  `isError: "Federated tool invocation failed with status 401."` Backend sees no
  bearer and rejects. Spec A2 (managed identity backend auth) and A3 (OAuth 2.0
  gateway-held connection) were **not run**: both send a single gateway-owned
  identity, so by construction they cannot produce per-user ServiceNow records
  (identity collapse); the Function correctly rejects app-only tokens.

### A4 (lab label `A3-entra-caller-auth`): Entra token instead of api-key

- Prediction: Entra caller auth will authenticate at the gateway; the token's
  audience is the gateway, so even if forwarded it is unusable for OBO.
- Observed 09:40-09:43: RBAC "AI Gateway Tools User" assigned to the user at
  scope `/workspaces/default/toolServers/servicenow`. The token scope
  `https://azure-api.net/aigateway/Data.All` is **only** shown in the portal
  ("Continue in code" > Azure CLI). `initialize` 200 (serverInfo "Azure API
  Management"), `tools/call` 200 with `isError` "Federated tool invocation
  failed with status 401". Backend diagnostics: `present_bearer=false`,
  `present_x_forwarded_for=true`, `identity_established=false`.
- Evidence: A3-entra-caller-auth.txt (local: `evidence/runs/A3-entra-caller-auth.txt`),
  screenshots 30-35.
- Verdict: **fail for OBO** - the gateway strips the caller `Authorization`
  header. Per-server RBAC works for caller authorization.

### B1-B3: MCP Apps fidelity

- B1 (09:36, key only): same 27 names, no namespacing, descriptions and
  `inputSchema` equal; **`annotations` and `_meta` (incl. `ui` resource
  binding) stripped** on every tool.
- B2: `resources/list`, `resources/read`, `resources/templates/list`,
  `prompts/list` -> **400 "Method not supported"**; `ping` 200. The 9 `ui://`
  widget resources (text/html;profile=mcp-app) are unreachable via the gateway.
- B3: direct `tools/call` returns `structuredContent`; gateway call fails on
  identity (see A2), so structured content passthrough could not be proven for
  OBO tools.
- B4: no renaming, so no tool-reference breakage; widgets break anyway because
  `_meta.ui` and `resources/*` are missing.
- Evidence: `runs/*B1*`, `runs/*B2*`, `runs/*B3*`,
  method support (local: `evidence/runs/gateway-method-support.txt`).
- Verdict: **MCP Apps widgets do not survive the gateway.**

### C1 (lab: gateway tool block) and C3 (spec numbering)

- Prediction: a blocked tool is denied with `ToolNotAvailable` within minutes
  and remains listed.
- Observed: `report_incident` added to Blocked tools in the gateway portal,
  saved 09:45:22Z; first poll sample at 09:46:03Z was already denied
  (propagation **at most 41 s**). Denial: HTTP 200, `isError`,
  "Tool 'report_incident' is blocked by the gateway. Do not retry this tool.",
  `_meta["com.microsoft.azure.ai.gateway/denial"] = {code: ToolNotAvailable,
  correlationId}`. `tools/list` **still advertises** the blocked tool. Other
  tools unaffected. (`approve_order_approval` was not used; `report_incident` is
  a cheaper write without demo approvals.)
- Evidence: denial (local: `evidence/runs/C1-tool-block-denial.txt`),
  `runs/*C1-block-propagation.json`, `runs/*list-gateway-C1-blocked.json`,
  toolServer ARM (local: `evidence/toolserver-servicenow-after-block.json`),
  screenshots 36-39.
- Verdict: **pass**, matches documentation.

### C4: policies on the MCP server

- Observed 09:50-09:58: policy types usable on MCP servers: IP filter,
  **Agent 365 tool threat protection**, Request rate limit (content safety and
  token limit apply to models only). Rate limit 5 calls / 60 s per caller
  identity: burst of 12 parallel calls -> 9 x 200, 3 x 429
  (`retry-after: 6`, "Rate limit is exceeded. Try again in 6 seconds."). A
  15 s poll loop never hit 429.
- Evidence: `runs/*burst-gateway-C3-ratelimit.json`, screenshots 40-44.
- Verdict: **pass, approximate** enforcement (distributed counter).
- Not run: content safety (model-only), token limit (no model deployed, to
  stay within budget), C5 (no model on the gateway).

### C1 (spec): Agent 365 discovery in the Microsoft 365 admin center

- Prediction: after consent `servicenow` appears under Agents > Tools with
  publisher "AI Gateway" within a few minutes.
- Observed: banner "AI gateway servers aren't shown because consent hasn't
  been granted". Agents > Settings > Gateways: consent checkbox first, then a
  switch "Azure API Management service and Azure AI Gateway" -> Connected at
  09:53:30Z (a LiteLLM gateway option also exists). This created the role
  assignment **"A365 Gateway Policy Operator"** (docs: "A365 MCP Gateway Policy
  Operator") at the tenant root management group for service principal
  `maven-prod` (appId `9b975845-388f-4429-889e-eab1ef63949c`).
  Tools API `/admin/api/agentssettings/agenttools` reports
  `aiGatewayStatus: "Ready"` but all 354 entries are `source: Catalog`; nothing
  discovered at 10:01, 10:11, 10:16, 10:20 (27 min after consent).
- Root-cause analysis 10:12: the consent role grants only
  `Microsoft.ApiManagement/service/{read, apis/read, apis/write,
  workspaces/toolServers/read, workspaces/toolServers/write}`. The AI Gateway
  tier is a different resource type, `Microsoft.ApiManagement/aigateways`, whose
  operations (`aigateways/read`, `aigateways/workspaces/toolServers/*`) are not
  in the role. The subscription contains no `Microsoft.ApiManagement/service`.
  Diagnostic at 10:15:23Z: custom role with the `aigateways` equivalents
  assigned to `maven-prod` on the gateway only; still not discovered at 10:20.
- Evidence: consent-role gap (local: `evidence/m365-discovery-gap-consent-role.json`),
  screenshots 45-51 and 53.
- Verdict: **blocked** - spec C2 (server block from M365, 403
  `AccessBlockedByGateway`) and M365 tool-level block could not be run.

### D1: bypass

- Prediction: a valid user token calling the Function directly is not governed.
- Observed 10:20: via gateway `report_incident` -> ToolNotAvailable; at the
  same time direct with user bearer -> **`<incident-2>`** created as the lab user.
- Evidence: D1-bypass.txt (local: `evidence/runs/D1-bypass.txt`).
- Verdict: **bypass confirmed.** D2 (repo M365 agent) is the same path and was
  not separately exercised.

### D3: close the bypass with `REQUIRE_GATEWAY_HEADER`

- Prediction: direct calls get 403; gateway calls pass the shared header, but
  OBO tools still fail because no user identity arrives.
- Observed 10:09: gateway backend auth set to header `X-Gateway-Key` (value from
  Key Vault secret `lab-gateway-shared-secret`). Direct without/with bearer ->
  **403** "Requests must arrive through the governed gateway."; gateway with key
  -> `tools/list` 200 (27). Reverted to `false` at 10:19 so the direct OBO path
  keeps working.
- Finding: the ARM `PUT` on the toolServer **echoes header credential values in
  plaintext** in the response (`GET` masks them as `null`). The first value was
  printed in a terminal and rotated immediately.
- Evidence: D3 (local: `evidence/runs/D3-backend-locked-to-gateway.txt`),
  `runs/*D3-*.json`, screenshot 52.
- Verdict: **closes the bypass, but only together with losing per-user OBO.**
  D4 (network isolation) not run: same identity trade-off, extra cost.

### Not run

E1-E3 (consumers), F1-F4 (observability, Defender hunting, BYO MCP, threat
protection), A5 (classic APIM v2 comparison). See [findings](findings.md) for
why and the recommended next tests.

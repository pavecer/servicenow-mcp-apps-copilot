# Phase 0: preflight results and approval boundary

Investigation date: 2026-10-15 UTC. Scope: local documentation/evidence and
read-only service checks. No deployment or tenant/governance changes performed.

## 1. Confirmed scope

- Target: the the lab tenant tenant, admin account and Azure subscription explicitly
  supplied by the user. Azure CLI account IDs match all three.
- Subscription display name: Visual Studio Enterprise Subscription; enabled.
- Azure RBAC: the signed-in account has Owner at subscription scope.
- Microsoft Graph confirms active Global Administrator and Power Platform
  Administrator membership.
- Region: Sweden Central, present in the subscription location list and the
  AI Gateway preview documentation.
- Intended lab azd environment: `snowmcp-gwlab`, not created.
- The existing checkout has only `snowmcpwidg-dev`; the isolated worktree has
  no azd environments. Neither was selected or modified.
- Intended tags: `purpose=mcp-gateway-lab`, owner from the verified account,
  `expires=2026-11-14`. Expiry tags do not automatically delete resources.
- ServiceNow target: the configured developer instance exactly matches the
  instance specified in the lab prompt.

An existing sibling checkout was found on an unrelated dependency-maintenance
branch. To avoid altering it, this workspace now contains a separate detached
worktree of `origin/main`, commit
`48647e17562492650b2dad18f234e70be9a7494c`.
Only the dependency manifests and changelog differed between that sibling
checkout and this baseline; the inspected auth/readiness source matched.
Create `lab/ai-gateway-governance` in this worktree at Phase 1, not in the
existing checkout. No commits, push, or PR have been made.

## 2. How authentication, OBO and caller mapping actually work

Code is authoritative where older repository prose disagrees.

1. Azure Functions exposes `/mcp` with an anonymous platform binding. This does
   **not** mean tool execution is anonymous: the Express layer gates
   `tools/call` with Entra authentication. Discovery (`initialize`, `tools/list`,
   widget resources), GET readiness, DELETE and OPTIONS are intentionally
   anonymous for the existing Copilot discovery experience.
2. The Entra middleware requires a bearer token for protected requests. When
   auth is enabled, missing tenant/client configuration returns 503; missing or
   invalid credentials return 401. Validation checks the signature against
   Entra JWKS, expiry/not-before, issuer/tenant and accepted API audiences.
   Both the application's GUID and `api://<client-id>` are accepted by default.
3. Only after validation does the middleware place the caller `oid`,
   `preferred_username`/`upn`, and raw bearer into request-scoped context.
   Header-supplied identity is not used as a substitute for validated claims.
4. The ServiceNow client's authentication order is: explicit per-request
   ServiceNow access token, then MSAL OBO exchange of the inbound Entra token,
   then integration-user credentials if fallback is allowed.
   OBO uses the configured downstream scope, an in-memory caller-oid cache,
   and a single-flight exchange guard.
5. `SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN=true` disables integration fallback.
   Some operations also require caller identity independently. The lab must
   set the global requirement explicitly, so a missing/failed OBO exchange
   never becomes a success under the integration identity.
6. Configured caller values (normally UPN) are matched against ServiceNow
   `sys_user.email,user_name` for requested-for/ownership resolution. The
   ServiceNow OIDC trust must independently validate the downstream Entra
   token and map its user claim. Patching `opened_by` is **not proof** of
   per-user authorization; record `sys_created_by`, effective token source
   and caller ACL behavior as well.
7. Structured logging uses the existing redacting logger. The Functions wrapper
   carries its invocation log sink through request context into App Insights.
   Future lab diagnostics must record header presence, never header values.

Relevant source:
[request handling](../../../../src/app.ts),
[Entra middleware](../../../../src/utils/entraAuthMiddleware.ts),
[validator](../../../../src/services/entraTokenValidator.ts),
[OBO exchange](../../../../src/services/oboTokenService.ts),
[ServiceNow client](../../../../src/services/servicenowClient.ts),
[logger](../../../../src/utils/logger.ts).

### A2 prediction caveat

The validator does not explicitly require a delegated scope or reject
`idtyp=app`. A correctly signed app-only token for an accepted API audience may
pass the initial JWT check. It cannot establish a delegated end-user OBO path.
Do not predict an automatic edge 401 for managed identity; measure JWT acceptance
separately from OBO and tool failure, with integration fallback disabled.
No managed-identity runtime test has been run.

### Current identity configuration blocks deployment

The existing local settings still reference the retired runtime tenant and old
inbound/downstream application IDs. Querying those two application IDs in
Contoso returned no app registrations. The local settings also have
`ENTRA_AUTH_DISABLED=true` and do not set the strict caller-token requirement.
These settings were only inspected through an allowlist, never changed or
copied into the lab. No secrets were printed.

The ServiceNow OIDC trust records were not inspected directly; current trust
must be verified in Phase 2. Existing configuration and repository migration
notes are not proof that ServiceNow already trusts Contoso.

**Required isolated lab values:** Entra auth enabled, only the intended tenant
trusted, OBO enabled with newly verified Contoso applications, caller token
required, unauthenticated DCR disabled, PII logging disabled. Do not repair the
old deployment as a shortcut.

## 3. Local tooling and authentication

| Check | Observed | Decision |
|---|---|---|
| Node | 24.15.0 | Satisfies local >=20; Azure Bicep still pins runtime 20 |
| npm | 11.12.1 | Present |
| Azure CLI | 2.85.0 | Correct target user/tenant/subscription |
| azd | 1.34.0 | Installed; authentication is wrong |
| PowerShell | 7.6.6 | Present |
| Functions Core Tools | 4.12.1 | Present |
| .NET SDK | 10.0.402 only | SDK 8 not installed; optional CLI not validated |
| .NET runtime | 8.0.32 and 10.0.13 | .NET 8 runtime exists |
| Playwright MCP | Configured Chrome absent | Do not install another browser just for preflight |
| VS Code integrated browser | Working | Used for public docs and authenticated portal inspection |

**Important:** `azd auth login --check-status --tenant-id <target-tenant>` reports
an account in a different tenant. Azure CLI sign-in does not fix azd sign-in.
Before Phase 2, interactively run the documented
`azd auth login --tenant-id <target-tenant>` and independently recheck it.
No azd login or account switch was performed during this investigation.

## 4. Read-only Azure prerequisites

| Provider | Registration |
|---|---|
| Microsoft.Web | Registered |
| Microsoft.ApiManagement | NotRegistered |
| Microsoft.CognitiveServices | NotRegistered |
| Microsoft.KeyVault | NotRegistered |
| Microsoft.Storage | NotRegistered |
| Microsoft.OperationalInsights | NotRegistered |
| Microsoft.Insights | NotRegistered |
| Microsoft.Network | NotRegistered |

No providers were registered. The authenticated gateway creation dialog says it
will register ApiManagement automatically when creating a gateway; that action
is not approved yet. Other providers still require pre-deployment attention.

Resource inventory found only an unrelated existing bot deployment and its
identity/plan/site. It was not changed. No Foundry/OpenAI account exists in this
subscription.

The documented `az cognitiveservices model list --location swedencentral`
command returned these candidates:

| Model | Version | Lifecycle | Relevant SKUs |
|---|---|---|---|
| gpt-4o-mini | 2024-07-18 | Deprecating | Standard, DataZoneStandard, GlobalStandard |
| gpt-4.1-nano | 2025-04-14 | Legacy | Standard, DataZoneStandard, GlobalStandard |
| gpt-5-nano | 2025-08-07 | GenerallyAvailable | DataZoneStandard, GlobalStandard |
| gpt-5.4-nano | 2026-03-17 | GenerallyAvailable | GlobalStandard |

The subscription usage endpoint returned an empty array with exit code zero.
That is **unverified quota**, not zero quota and not proof of capacity. Recheck
after approved provider registration. No model is selected as "cheapest" until
quota, current pricing and the intended data boundary are verified.
DataZoneStandard is an EU processing candidate; locating a GlobalStandard
deployment in Sweden does not by itself guarantee EU-only inference.

Provider metadata returned no `toolServers` entries for ApiManagement.
Do not invent a preview ARM deployment from the prompt's example path.

## 5. ServiceNow readiness

The login page returned HTTP 200. The unchanged repository command
`npm run preflight:readiness` ran in the existing checkout, after asserting the
configured instance matched the permitted developer instance exactly.
It obtained an integration-user OAuth token in memory and issued only table/API
GETs. No demo seed/cleanup or business-record mutation was performed.

| Probe | HTTP | Rows | Interpretation |
|---|---|---|---|
| Catalog items | 200 | 1 | Integration read works |
| Incident table | 200 | 1 | Integration read works |
| Knowledge articles table | 200 | 0 | Endpoint accessible, useful content unproven |
| Knowledge categories | 200 | 0 | Endpoint accessible, no visible categories |
| HR case table | 400 | 0 | Invalid table; HRSD absent/unavailable |
| HR profile table | 400 | 0 | Invalid table; HRSD absent/unavailable |

Command exit: 0; its IT/KB summary is PASS and HR is FAIL. Its KB criterion is
HTTP success, not article visibility or per-user Knowledge API authorization.
Do not enable HRSD or install anything to satisfy this unrelated optional probe.
Per-user OBO, demo-persona mapping, approval ownership and the direct lab baseline
remain untested.

## 6. Agent 365 and live portal checks

Microsoft Graph confirms enabled Agent 365 plans, including AGENT_365_TOOLS,
and the expected Agent Tools service principal. The admin center home page also
shows Agent 365 licensing. This confirms entitlement/provisioning, not successful
gateway governance or per-user license assignment.

The integrated browser initially needed interactive sign-in. The gateway page
remained at "Signing in ..." until a reload after browser authentication.
It then reached onboarding and displayed the correct subscription in the create
dialog. No Create action was submitted by the assistant.

The onboarding dialog defaults to **East US 2**, so explicitly choose Sweden
Central before any approved creation. Resource-group fields are visible directly
in the current dialog, rather than only under Advanced as the quickstart says.
The proposed gateway/resource group names are generated UI defaults, not created
resource names.

In the Microsoft 365 admin center, Agents expands to Overview, All agents,
Agent map, Deleted agents, Shadow AI, Tools and Settings. Opening Settings >
Gateways shows **Gateways (preview)**. The Microsoft Azure row says
**Connected: No**. Its consent checkbox is unchecked, and the Azure API
Management/Azure AI Gateway switch is disabled until that prerequisite is met.
No checkbox, switch or consent action was changed.
Evidence: gateway admin panel (local: `screenshots/m365-gateways-not-connected.png`).
The earlier sign-in screenshot captures an intermediate registration/loading
page, not a permanent authentication failure; authenticated navigation later
succeeded.

Manual confirmation path: **Agents > Settings > Gateways**; the Microsoft Azure
toggle/consent belongs to Phase 4, after a working gateway and the required
approval. Do not confuse Agent 365 licensing with this consent.

## 7. Public documentation validation and differences

The ten URLs in the prompt were tested. Nine returned HTTP 200 initially.
The classic existing-MCP article initially returned 404, but a subsequent
PowerShell request, integrated-browser navigation and Microsoft Learn fetch
all succeeded. Record this as **transient/inconsistent retrieval**, not a
permanently broken documentation URL.

| Finding | Evidence | Consequence |
|---|---|---|
| Quickstart specifies `2026-05-01-preview`; threat protection PATCH example uses `2025-09-01-preview` | Quickstart screenshot (local: `screenshots/quickstart-api-version.png`), threat example (local: `screenshots/threat-policy-api-version-suffix.png`) | Documented API-version discrepancy; not a proven runtime failure. Use portal/runbook until the exact operation contract is verified |
| Threat protection needs a delegated token issued for the gateway, but does not replace existing runtime keys/backend auth | [Threat article](https://learn.microsoft.com/en-us/azure/api-management/ai-gateway-policy-tool-threat) | A4 must distinguish an additional evaluation token from replacing the api-key. Do not infer keyless access |
| Backend OAuth is an interactive authorization of the gateway; portal status is self-reported | [Asset management](https://learn.microsoft.com/en-us/azure/api-management/ai-gateway-manage-models-tools) | Token passthrough and per-user attribution remain experiments, not documented guarantees |
| Gateway preview pricing has not been announced | Pricing screenshot (local: `screenshots/preview-pricing-unpublished.png`) | No guaranteed all-in budget; ask before creation |
| Onboarding defaults to East US 2 and directly exposes resource group | Live creation dialog (local: `screenshots/gateway-create-preflight.png`) | Override region, use only the isolated lab group; minor UI/documentation drift |
| M365 Gateways page exists; Azure is disconnected and its switch is disabled behind an unchecked consent checkbox | Live admin panel (local: `screenshots/m365-gateways-not-connected.png`) | Document the checkbox prerequisite; leave consent for Phase 4 |
| Classic article transient 404 recovered to 200 | HTTP evidence (local: `evidence/documentation-links.json`), recheck (local: `evidence/documentation-recheck.json`), browser (local: `screenshots/classic-apim-doc-browser.png`) | Retry and preserve both observations |

Confirmed in public docs, not runtime-tested: backend namespacing, gateway-scoped
keys, static allowed-tools requirement for Agent 365 tool blocking, 403 server
block, HTTP 200 JSON-RPC tool denial, no automatic routing through a gateway.

Local repo prose also contains older counts and auth descriptions (23 tools,
five/eight widgets, all POSTs authenticated, older cost assumptions). The live
source inventory is 27 tools and nine widgets; keep it unchanged. Both requested
block targets and all three read-path tools are present in the canonical
registry. No unrelated documentation or runtime behavior was changed.

## 8. Cheap-by-default cost assessment

The current Bicep is more substantial than the old README cost headline:
it creates a VNet, two private endpoints, two private DNS zones, private storage,
Key Vault, Flex Consumption and monitoring. Security must not be weakened merely
to make the budget headline true.

Verified retail networking meters:

- Standard Private Endpoint, global consumption meter: USD 0.01/hour each.
- Two endpoints: USD 0.02/hour, USD 0.48/day, USD 3.36/week,
  USD 14.60 at 730 hours, excluding processed data.
- Private Zone retail tiers include USD 0.50 and USD 0.10 per zone; use
  approximately USD 1/month for these two zones at the initial tier, plus DNS
  queries. Reconfirm billing tier and proration before provisioning.

Thus **approximately USD 15.60/month of networking alone**, before Function
executions, storage, Key Vault operations, App Insights ingestion, model tokens,
Content Safety and gateway charges. This is not an all-in quote. Meter evidence:
network-retail-prices.json (local: `evidence/network-retail-prices.json`).

Recommended lab shape, subject to approval:

1. Keep required private storage/Key Vault controls and reuse the existing Bicep.
2. Run a short lab and tear it down promptly; do not leave it for 30 days merely
   because the expiry tag says so.
3. One consumption chat deployment, no provisioned throughput, with low token
   ceilings and bounded model/tool loops. No extra Foundry agent service.
4. Content Safety only for its experiment, with verified minimal billing tier.
5. Short/low-volume redacted telemetry; no full prompt/header/body logging.
6. No classic APIM comparison instance, additional private gateway networking,
   paid licenses or optional consumers without a separate decision.
7. Choose an explicit USD/EUR spending target and duration before Phase 2.
   Cost Management budgets are alerts, not hard spending caps. Rate/token
   limits and teardown reduce risk but cannot guarantee a final bill.

## 9. Next steps and phase stop

Phase 0 has produced only the local report, experiment log, HTTP/pricing evidence
and screenshots. No lab endpoint exists yet; no runtime identity, governance,
bypass or MCP Apps verdict is claimed. Build/tests were not run because this
phase changed only documentation and generated evidence.

Before Phase 1: the user writes `continue`. Phase 1 will create the lab branch,
default-off diagnostics/header guard, bounded in-memory-token harness, unit tests
and remaining runbooks. It will not deploy.

Before Phase 2:

- Correct and verify the independent azd account.
- Confirm the lab cost target and lifetime, including unpublished gateway pricing.
- Obtain approval for provider registration and any billable resources.
- Prepare isolated Contoso app registrations and ServiceNow trust/user mappings
  under runbook 01; never reuse retired-tenant secrets/app IDs.
- Before **every** Azure write, run `az account show` and require the exact
  user-confirmed tenant and subscription. azd must also use the new lab environment.

Tenant consent, trust changes and optional consumer setup remain separate gated
steps. The user's browser-automation permission does not remove the explicit
phase stops in the lab prompt.

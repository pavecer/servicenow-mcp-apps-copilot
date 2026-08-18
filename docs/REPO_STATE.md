# Repository State

Last updated: 2026-08-18

This file is the tracked handover for future agents and cloud Copilot sessions.
It records the latest verified runtime state, active deployment assumptions, and
the shortest path to resume work safely.

For a point-in-time audit of the agentic development approach itself (agents,
skills, workflows, and the human-approval gate), see
[AGENTIC_WORKFLOW_REVIEW.md](AGENTIC_WORKFLOW_REVIEW.md). It records what was
already sound, two dangling-reference fixes applied directly, and four
maintainer decisions (model-pin policy, CodeQL documentation, PR-template
cleanup, container-deploy secret handling) resolved and applied on 2026-08-17.

## Current verified state

- Repo: `servicenow-mcp-apps-copilot`; public baseline is branch `main`, while
  the active local candidate is on `feat/knowledge-retrieval`.
- Surface: MCP Apps only.
- Public inventory: 23 tools, 8 widgets. The test-only deployment currently
  exposes the Knowledge candidate with 27 tools and 9 widgets.
- Primary deployed endpoint:
  `https://func-yj453fjwuhph4.azurewebsites.net/mcp`
- Primary Azure resource group: `rg-snowmcpwidg-dev`
- Current ServiceNow development instance:
  `https://dev351709.service-now.com`
- Current integration identity: `mcp_integration`

## Knowledge widget side-by-side (fullscreen) investigation — PR #73

Branch `copilot/feature-knowledge-widget-side-by-side-display`,
[issue #72](https://github.com/pavecer/servicenow-mcp-apps-copilot/issues/72) /
[PR #73](https://github.com/pavecer/servicenow-mcp-apps-copilot/pull/73). Adds
an additive `window.mcpHost.requestDisplayMode()` bridge capability and an
**Expand** action on the Knowledge article-detail widget only. No tool/widget
lockstep changes. Read this section fully before touching this feature again —
it records three failed live-test rounds and the exact evidence, so the same
debugging loop is not repeated.

**Round 1 (SHA `d97c9dbd8`) FAILED:** Expand stuck on "Opening..." forever.
No timeout existed on the bridge call yet.

**Round 2 (SHA `c482e5d5`) FAILED despite adding a 5s timeout.** Root cause:
`@modelcontextprotocol/ext-apps`' `App.requestDisplayMode` calls
`this._assertInitialized(...)` via the comma operator **before returning
anything**, so it can throw synchronously. `Promise.resolve(hostMethod(args))`
does not catch a throw that happens while evaluating `hostMethod(args)` itself
— the throw happens before `Promise.resolve` ever runs, so a promise-based
timeout never gets a chance to fire. Confirmed by decompiling the actual
minified bundle served by the deployed candidate at each round (not just
trusting deploy logs) — round 1 and round 2's bundles were checked directly
via `resources/read` against the live endpoint.

**Round 3 (SHA `067209d258346a40cb717600303930324955a3ee`) fixed the hang.**
Added `callSafely()` in `host-bridge.ts`, which invokes the host SDK call
inside a thunk executed via `try/catch`, converting any synchronous throw into
a rejected promise before the timeout wrapper runs. Verified live by
decompiling the deployed bundle: `requestDisplayMode` now calls
`l(m(()=>p.requestDisplayMode({mode:_})),pg,...)` — the thunk-wrapped pattern.
Human tested in the M365 developer agent (`ServiceNow Assistantdev`, KB0005012):
Expand no longer hangs; it resets cleanly to "Expand" and shows "This host
cannot expand the article view right now." within a few seconds. This is a
structurally correct, graceful-degradation outcome per the acceptance
criteria — **but not yet the success path** (the article never actually
expands to fullscreen/side-by-side).

**Open question — why does the actual request get rejected?** Microsoft's own
[MCP Apps support matrix for Copilot](https://learn.microsoft.com/microsoft-365/copilot/extensibility/plugin-mcp-apps#supported-mcp-apps-capabilities-in-copilot)
states:
- `app.requestDisplayMode({ mode })` → **✅ (full screen only)** — so this
  should be able to succeed in principle, meaning the rejection observed live
  is a specific, real error, not "the feature doesn't exist here."
- `app.getHostContext()?.availableDisplayModes` → **❌ not supported.** Copilot
  does not populate this field via the MCP Apps `App` path. The Expand button
  rendering at all in live testing therefore most likely came through the
  OpenAI-shaped `displayMode` object fallback
  (`getOpenAiDisplayModeContext()` in `host-bridge.ts`, which reads
  `window.openai.displayMode` as an object carrying `availableDisplayModes`),
  not through `app.getHostContext()`. Do not assume `availableDisplayModes`
  from the MCP `App` path is populated by Copilot; the OpenAI-shaped path is
  currently the only one observed to work here.
- This request/response happens **entirely client-side**, inside the browser
  between the widget iframe and the Copilot host via `postMessage`. It never
  reaches this repo's Azure Function backend, so **Application Insights cannot
  show it** — there is no server-side telemetry option for this class of bug.

**Diagnostic build (SHA `f4558a00241be64a0ecf004491c2b75e77c8d3d8`)** added a
`console.warn` in the Expand click handler's `.catch()` logging the actual
rejection reason (this class of request is invisible to Application Insights
— see above). The human ran it in a fresh chat and reported the exact console
output.

**Round 4 (SHA `fa29d3800ac7abb341aae8550cef1353ced09e51`) found and fixed the
real root cause — it was our own bug, not a Copilot host limitation.** The
captured browser console trace was:
```
TypeError: Cannot read properties of undefined (reading '_assertInitialized')
    at requestDisplayMode (VM8 about:srcdoc:103:10668)
```
`App.requestDisplayMode` does `this._assertInitialized(...)` as its first
statement. The bridge's `app` branch had extracted the method into a detached
local variable (`const request = app.requestDisplayMode; ... request({mode})`)
instead of calling it as `app.requestDisplayMode({mode})` — a classic
lost-`this` bug: calling a detached method reference makes `this` become
`undefined` inside it. `callSafely()` (round 3) correctly caught the resulting
throw and turned it into a clean rejection — that part worked exactly as
designed — but the *reason* for the rejection was this bug, not the host
declining a supported request.

**Fix:** call `requestDisplayMode` as a proper method on the `App` instance
(preserving `this`), not through a detached reference. Added a regression test
whose mock `requestDisplayMode` implementation actually depends on `this`
(captures it and asserts it equals the `app` instance) — a plain `vi.fn()`
mock does not reference `this` at all, which is exactly why this bug slipped
through rounds 2 and 3 undetected. Verified live: decompiled the redeployed
bundle and confirmed the call site changed from the detached `request({mode:_})`
pattern to a proper method call, `z.requestDisplayMode({mode:_})` where
`z` is the `App` instance.

**Status: awaiting the human's fresh-chat re-test of SHA `fa29d380`.** Expected
outcomes this time: either the article actually expands to fullscreen/side-by-
side, or — if it still can't — the console should show a *different*,
legitimate rejection reason from Copilot itself, not the same `_assertInitialized`
`TypeError`. If the same TypeError reappears, the redeploy did not take effect;
do not reinterpret it as a new finding.

## Human-validated order-detail release

- The order-detail MCP App redesign was deployed from commit `aad13a1` to
  `snowmcpwidg-dev` and the developer/test M365 app. It adds a prominent
  lifecycle panel and next step, Approval → Queued → Underway → Complete
  progress, responsive light/dark layouts, and accessible
  approval/error/busy states.
- The backend now derives `can_decide` from the current ServiceNow caller,
  enforces requestor/approver ownership on detail and update paths, rejects
  malformed non-32-hex ServiceNow `sys_id` values, serializes same-instance
  concurrent decisions for one approval, and keeps mutation success truthful
  when only the detail refresh fails.
- Validation on 2026-08-10: `npm run build && npm test` passed with 35 test
  files and 299 tests; live validation passed all 23 tools; storage public
  access was restored to `Disabled`; and no temporary policy exemption
  remained. The user then tested the deployed MCP App in the test tenant and
  explicitly confirmed that it works as intended.
- The validated code was published through PR #45 as commit `a2986f3` after the
  earlier premature merge was fully reverted. Do not bypass the
  human-validation gate for future behavioral changes.

## Release governance

- Release governance was merged through PR #47 as commit `ad465e2` after
  maintainer review, CI, and CodeQL validation.
- The project version is reconciled to the existing M365 baseline `1.1.6`
  across npm, the lockfile, and the app manifest. `CHANGELOG.md` now has an
  explicit `1.1.6` historical baseline and a clean `Unreleased` queue.
- PRs must select a release impact, PR kind, and truthful validation state.
  CI validates new changelog-note provenance, queued impact markers, changed
  surfaces, canonical version parity, and actual SemVer deltas for release PRs.
- `release:plan` and `release:prepare` preview and create synchronized releases;
  annotated `vX.Y.Z` tags on current `main` create GitHub Releases only after a
  read-only build/test job succeeds. Microsoft 365 catalog publication remains
  separate and manually approved.
- Final local validation: 36 test files / 313 tests pass; 14 focused governance
  tests pass; `release:check`
  reports `1.1.6`; a Minor preview reports required type `minor` and next
  version `1.2.0`; editor diagnostics are clean; focused reviewer verdict is
  APPROVE.
- The first CodeQL run found three parsing/escaping alerts; these were fixed
  before merge with linear parsing and hostile-input tests.

## Active Knowledge retrieval branch

- Branch `feat/knowledge-retrieval` adds four tools and one shared MCP App,
  moving the local and test-deployed inventory to 27 tools / 9 widgets. Public
  `main` remains 23 / 8.
- Implemented locally: deterministic native-score/lexical ranking, one-call
  Knowledge API search, one-call article detail, executable-block stripping,
  attempt/history state, third-attempt incident offer, explicit-consent incident
  creation, standardized KB-not-helpful incident description, and agent intent
  routing.
- The configured integration identity sees zero Knowledge rows; delegated demo
  admin access sees demo articles. Alex/OBO article visibility must still be
  proven through the test-tenant experience.
- Delegated admin probe after deployment: dedicated `sn_km_api` returns 400
  (endpoint unavailable), while caller-scoped `kb_knowledge` returns rows. An
  opt-in caller-scoped Table API fallback is implemented; enable it only in the
  demo environment, then validate Alex/OBO visibility before approval.
- Durable implementation checklist and validation matrix:
  [KNOWLEDGE_RETRIEVAL_PLAN.md](KNOWLEDGE_RETRIEVAL_PLAN.md).
- The latest local native-write slice passes 7 focused files / 130 tests and
  TypeScript/widget build. It adds strict caller-scoped native feedback,
  accessible two-stage feedback UX, and truthful best-effort task links. Full
  candidate validation passes 41 files / 395 tests; backend and MCP Apps
  reviewers APPROVE. Initial commands, narrow dark feedback form, saved outcome,
  gated fallback, and attempt-three escalation visuals passed.
- Local media-handoff follow-up counts omitted images across the full bounded
  article and retrieves at most 20 caller-visible attachment summaries
  (filename/type/size) with no IDs, URLs, or bytes. Image-only desktop light and
  attachment-only narrow dark visual states passed; attachment metadata failure
  is nonfatal.
- Minor release preparation synchronized npm/M365/changelog at `1.2.0`.
  Runtime `b363012` plus package-guidance fix `1164751` is deployed only to
  `snowmcpwidg-dev`; live validation reports 27 tools. The existing developer app
  passed 61 package checks and was updated under title
  `T_7083fecd-9cd0-e94d-285b-0e25bfc2a169` without catalog publication.
- The deployed ranked list shows the top three compact previews with visible
  bottom actions, labeled metadata, category-preserving narrow layout, and
  numeric HTML entity decoding. Live search returned five results with no
  numeric entity literals in title/snippet/category/base fields.
- Selected article detail now preserves ServiceNow source headings, paragraphs,
  nested ordered/unordered lists, emphasis, code/preformatted text, blockquotes,
  and breaks through a bounded attribute-free document model. Plain text derives
  from the same sanitized tree, and shortened previews are explicit.
- Live KB0005001 detail exposes document v1 with 2 major headings, 10 subsection
  headings, 14 nested lists, 40 items, depth 5, and no truncation. VPN, cookie,
  and password source structures were also verified read-only.
- Live media verification: KB0000003 reports 3 omitted images; KB0000018 reports
  one caller-visible PNG attachment (`300px-Windows_Vista.png`, 77,404 bytes).
  Both expose the canonical article link and no direct media URL, attachment ID,
  download URL, or file bytes.
- Human media-handoff validation completed on 2026-08-11: the user tested the
  deployed image and attachment states and confirmed that both worked as
  described. This approves the media UX in runtime `cdf62b7`.
- Enterprise policy blocks external npm downloads. No dependency or lockfile was
  added; the parser is a bounded state machine with hostile/malformed tests and
  does not render raw ServiceNow HTML.
- Human visual validation completed on 2026-08-11: the user opened the deployed
  Workstation Security Standard article and confirmed that the source-structured
  view works much better and is easier to read. This approves the formatting
  checkpoint originally validated at runtime commit `0dcfe4b`; the same
  structured renderer is retained in media-aware runtime `cdf62b7`.
- The local candidate now writes native `kb_feedback` with exact `yes`/`no`,
  caller user, original query, and optional reason (`1` incomplete, `2`
  incorrect, `3` unclear, `4` other). It verifies active/published/non-expired
  caller visibility before writing. The widget discloses persistence, prevents
  contradictory concurrent writes, and requires an explicit continuation.
- After a consented incident POST, the local candidate visibility-checks up to
  20 attempted articles and best-effort inserts `m2m_kb_task` links. Complete or
  partial linking failure never falsifies incident success; attempted history
  remains in `incident.description` and the confirmation reports diagnostics.
- Live delegated-admin proof created one KB0005001 `kb_feedback` row
  (`useful=no`, reason `3`, caller populated), caller-attributed incident
  `INC0010015`, and one `m2m_kb_task` link. Tool diagnostics were 1 requested / 1
  linked / 0 failed. Cleanup deleted link, feedback, and incident with HTTP 204;
  zero marker-owned feedback/incident rows remained afterward.
- Live delegated-admin checks returned five ranked results for password reset,
  opened `KB0005012` with content and a source link, and confirmed attempt 3
  excludes the tried article and offers an incident without creating one. The
  demo fallback setting is enabled, storage public access is `Disabled`, and no
  temporary exemption remains.
- No public push or PR has occurred. Next: deploy the exact 27-tool candidate to
  `snowmcpwidg-dev`, verify live native
  records as admin/Alex, then finish the three-attempt and consented-incident
  human journey before opening a Version release PR.

## Operational checkpoint

- As of 2026-08-11, Function App `func-yj453fjwuhph4` is running and the Azure
  subscription is enabled. The test endpoint exposes all 27 candidate tools;
  public `main` remains at 23 tools.
- Local ServiceNow validation is passing with current `local.settings.json`
  values (`npm run sn:local -- validate`).
- Deployed Function App has been migrated to `dev351709` and validated live.
- Entra CLI consent issue that previously blocked authenticated live tests is
  resolved.
- OBO is restored and enabled again on the deployed Function App.
- Step 1 manager approval actions are deployed: `approve_order_approval` and
  `reject_order_approval` both render the order-detail widget.
- The live test endpoint exposes all 27 tools, including the four Knowledge
  tools and both approval actions.
- Developer M365 agent package `1.2.0` was validated and applied to existing app
  `0d52a642-334e-4835-94b6-f6acc349569d`; OAuth registration was preserved. The
  organizationally published baseline remains `1.1.6`.
- `npm run release:auto -- --environment snowmcpwidg-dev` is the verified
  automation path through the human M365 Copilot prompt-test boundary.
- Tenant policy `MCAPSGovDeployPolicies / StorageAccount_PublicNetwork_Modify`
  forces deployment storage public access off. Release automation creates a
  narrow temporary exemption only for that rule/account, removes it after
  deployment, and restores public access to `Disabled`.
- The Function App is integrated with `vnet-yj453fjwuhph4` and the deployment
  storage Blob endpoint is private (`pep-styj453fjwuhph4-blob`, Approved), so
  the app remains healthy after storage public access is disabled.
- Repeatable approval demo data is available through `npm run demo:seed`,
  `demo:verify`, and `demo:cleanup`; records are marker-owned and idempotent.
- Current pending demo fixtures on `dev351709`:
  - Alex action: `REQ0010003` (`b9444f5597220310a1cd3b90f053afc3`), approval
    `da44439997220310a1cd3b90f053af99`
  - admin action: `REQ0010004` (`1244439997220310a1cd3b90f053aff4`), approval
    `e644839997220310a1cd3b90f053af7f`
  - Alex/manager narrative: `REQ0010005`
    (`ba44839997220310a1cd3b90f053affc`), admin approval
    `4344079997220310a1cd3b90f053af1f`
- The deployed admin approval action was exercised successfully, then all three
  fixtures were reset to request/approval state `requested`.
- Agent package `1.1.6` was formally submitted to the test tenant organizational
  catalog with `atk publish` on 2026-08-06; all 61 package checks passed. Teams
  Admin Center approval remains required before `Last published` is expected to
  populate.
- The Admin Center `Entra agent ID` field is expected to be blank: this
  declarative Agents Toolkit app uses an OAuth application but has no explicitly
  associated Entra Agent ID. Do not substitute the OAuth client ID.
- The submitted ZIP contains 5,202 characters of resolved instructions. A blank
  Instructions panel is registry metadata ingestion/display, not missing package
  content.
- Publisher is Pavel Vecer while owner/creator is David Vecer; reassign the
  registry owner to the enduring owner or owning group during admin approval.
- Agent 365 CLI `1.1.165-preview` is installed and the complete 23-tool external
  MCP registration passes a no-mutation dry run. No real tool registration was
  submitted because an existing registry entry could not be safely ruled out.
- Release automation accepts `--agent-environment` independently from the azd
  `--environment`; it defaults to `dev`, while production must use a separately
  configured `prod` Agents Toolkit environment/app ID.
- Post-approval screenshots on 2026-08-06 confirm a second organizational
  registry record for `ServiceNow Assistantdev` v1.1.5. It shows Publisher type
  `Your org`, Created 6 August 2026, Last used `Never`, and blank Last published,
  Owner/Created by, and Entra agent ID. Its Data & tools view shows the
  RemoteMCPServer summary but not the expanded 23-operation list shown on the
  developer record.
- The failed `1.1.5` org runtime retained the action summary but omitted the
  pinned operation projection. Version `1.1.6` uses dynamic discovery instead:
  the package has `functions: []` and `run_for_functions: ["*"]`, and the live
  authenticated MCP `tools/list` response supplies all 23 tools and MCP Apps
  metadata.
- Published organizational agent still can't call tools although its package
  and live endpoint are healthy. The earlier diagnosis that Agent 365 Tools
  registration was required was incorrect.
- Submitted external server `ext_ServiceNowMCP` with all 23 tools on 2026-08-06.
  Agent 365 CLI `.default` handling failed to add the downstream permission, so
  the generated RemoteProxy was repaired with delegated `access_as_user`, a
  service principal, and an `AllPrincipals` consent grant. Future templates use
  the named scope.
- Tool approval is still pending. CLI approval failed with Unauthorized because
  the Agent 365 signed-in identity isn't AI Administrator or Global
  Administrator. An appropriately privileged admin must approve it under
  **Agents > Tools > Requests**, then the published agent must be reinstalled
  and tested in a new chat after propagation.
- The admin subsequently approved `ext_ServiceNowMCP`. The A365Proxy service
  principal has `Tools.ListInvoke.All`; RemoteProxy has tenant-wide delegated
  `access_as_user`; the live endpoint exposes 23 tools. This didn't enable the
  declarative agent. Official docs state Agent 365 BYO MCP preview supports
  Copilot Studio and coding clients, not Microsoft 365 Declarative Agents.
- Correct investigation target: native `RemoteMCPServer` plus
  `OAuthPluginVault` resolution for the published organizational package.
- Full HAR `debug/m365-published-agent-full.har` captured the failing published
  turn on 2026-08-06 from `12:22:21Z` through `12:22:29Z`. The organizational
  runtime is title `T_c7d7f997-2c2b-3d39-d317-9f2d8cf26387`, Teams app
  `ea189b84-1e69-41b0-94f0-d12a74ae7fbd`, package version `1.1.5`.
- The HAR proves that the correct organizational title was selected end to end.
  Its bootstrap record is acquired, has `isAutoInvokeDisabled=false`, and
  includes `action_1` with `RemoteMCPServer`, `OAuthPluginVault`, and the expected
  auth reference. No authentication card, action execution event, or explicit
  runtime error appeared in the non-developer-mode turn.
- Application Insights had zero requests, traces, and exceptions during the
  failing turn window, while it recorded successful `/mcp` requests at `11:40Z`.
  The action therefore stopped before dispatch to the Function; browser HAR
  absence alone would not prove this because MCP invocation is server-side.
- Do not assume the different organizational Teams app ID invalidates the auth
  config. The installed Agents Toolkit `oauth/register` driver defaults
  `applicableToApps` to `AnyApp` when this project omits that property; its
  required `appId` input is used only when `SpecificApp` is selected. A later
  Teams developer portal edit could still change the effective restriction.
- Updated developer-mode HAR captured the explicit
  `search_catalog_items` prompt at `12:40:33Z`. Client telemetry says
  `Developer flag enabled`, but the turn emitted no `DeveloperLogs`,
  `TriggerPlugin`, `AuthError`, or execution message. `PlugInInfo` contained only
  built-in `BingWebSearch`; `DiscoverMCPServers` succeeded with
  `TotalDiscoveredServers: 0`; the selected org conversation had `plugins: []`.
- The same turn completed with `AuthBlockEncountered=false`,
  `ClientBlockEncountered=false`, and `ServiceBlockEncountered=false`, and
  Application Insights again recorded no Function traffic. Screenshots then
  confirmed the org agent is assigned to Alex and its bundled **ServiceNow
  Assistant** action is present. The separate Agent 365 `ext_ServiceNowMCP`
  registry entry is unrelated.
- Grounded repair: switched the declarative agent action from pinned operations
  to the current documented dynamic-discovery pattern, bumped to `1.1.6`, passed
  build plus 32 files / 260 tests, validated 23 live tools, passed all 61 Toolkit
  package checks, updated the developer title, and submitted the org package.
  Admin approval of `1.1.6`, propagation, re-add, and a fresh org-agent chat are
  now the remaining human boundary.
- OAuth lifecycle defect fixed after the `1.1.6` test: `m365agents.yml` now uses
  the actual suffixed OAuth variables and reconciles the vault registration with
  `oauth/update`; release automation no longer removes those actions. The live
  token-store record was already `AnyApp`; Toolkit updated its audience from
  `AnyTenant` to `HomeTenant`. This change did not create another catalog
  submission.
- Immediate test boundary: Alex must clear the organizational agent connection
  under **Chat settings > Agents**, reopen the **Published by your org** copy,
  complete first-use sign-in, and send one explicit catalog prompt in a new chat.
  Empty Functions before sign-in is consistent with Microsoft's documented
  authenticated dynamic-discovery behavior.
- Application Insights for the admin `1.1.6` test proved the agent itself was
  working: Copilot initialized MCP, listed tools, selected
  `search_catalog_items`, and called `/mcp`. The displayed HTTP 401 was
  downstream. OBO failed with `AADSTS7000215` because the Function was pinned to
  an invalid historical Key Vault secret version; ServiceNow password fallback
  was also pinned to stale credentials and returned `access_denied`.
- Infrastructure recovery completed on 2026-08-06: validated local/azd Entra and
  ServiceNow credentials, forced fresh Key Vault versions, changed Function app
  settings to versionless secret references, and added approved private endpoint
  `pep-kv-yj453fjwuhph4-vault` plus linked private DNS zone
  `privatelink.vaultcore.azure.net`. Key Vault public access is `Disabled` and no
  temporary exemption remains.
- Post-recovery live delegated validation passes: OBO exchange passed, catalog
  list/detail returned HTTP 200, and `search_catalog_items("laptop")` returned
  five items. The deployed backend is ready for admin and Alex Copilot retests;
  no agent republish is required.
- Selecting **Uninstall** on the published org agent removed its organizational
  registry projection entirely in this tenant; only the developer record
  remained as `Not available`, even with filters cleared. Recovery first checks
  Registry **Status > Available**; when no **Your org** record exists, resubmit
  the same package and approve it again. Version `1.1.5` was resubmitted on
  2026-08-06 and passed all 61 checks. Do not use `atk install`, which creates
  another developer copy.

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
- On 2026-08-06, release-config auditing found that absent local OBO values had
  reprovisioned the Function with OBO disabled and an invalid Entra client
  secret. The active M365 OAuth credential was synchronized to ignored local
  settings, azd, and Key Vault; `release:auto` now preserves OBO values from
  local/azd configuration. Live `validate_servicenow_config` again reports
  `authModeUsed=obo` with exchange and catalog checks passing.
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
- For a test-tenant release, follow [RELEASE_PLAN.md](RELEASE_PLAN.md) and keep
  npm/M365 versions synchronized, run `npm run release:auto -- --environment
  snowmcpwidg-dev`, test the developer copy, then use `npm run release:publish
  -- --environment snowmcpwidg-dev` to submit only after separate publication
  approval; Teams Admin Center approval follows the submission.
- Read [AGENT_365_PUBLISHING.md](AGENT_365_PUBLISHING.md) before interpreting
  `Last published`, Entra Agent ID, Instructions, Environment, or tool-registry
  metadata in Microsoft 365 admin center.
- If a future task changes verified environment state, update this file in the
  same change so the state remains visible to repo-scoped and cloud agents.

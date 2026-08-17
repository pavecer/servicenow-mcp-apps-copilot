# Agentic development workflow review

Date: 2026-08-17
Scope: validate the end-to-end Codespaces / cloud-Copilot development approach
— agents, skills, GitHub Actions workflows, dependency/security automation, and
the single human-approval gate — against best practice, and record what should
change.

This review does not change runtime behavior. It records findings, fixes a
small number of low-risk documentation/consistency defects directly, and
tracks the four decision points the maintainer reviewed and resolved (see
[Resolved decisions](#resolved-decisions)).

## Summary verdict

The overall design is sound and unusually rigorous for a solo-maintainer
project:

- One human approval gate, bound to a full 40-character SHA, with separate
  "validation" and "merge authorization" records
  ([HUMAN_APPROVAL.md](HUMAN_APPROVAL.md)) — prevents the common failure mode
  of an agent inferring approval from vague chat text.
- Clear identity/tenant boundaries (Azure management vs. MCP runtime/OBO vs.
  M365 test tenant vs. ServiceNow) documented in
  [CODESPACES.md](CODESPACES.md) and enforced by keeping them as separate
  env-var groups.
- Secretless CI/CD: `deploy.yml` uses GitHub OIDC federation (no stored Azure
  secret), only runs against an exact, immutable commit SHA, and is inert until
  `AZURE_ENV_NAME` is configured.
- Hard isolation between the untrusted hosted Copilot coding agent
  (`copilot-setup-steps.yml`, no cloud secrets) and the privileged Codespace
  agent that can reach Azure/ServiceNow/M365 — documented and intentional.
- Release governance (`RELEASE_PLAN.md`) enforces exactly one release-impact
  marker per PR, synchronized SemVer across npm/manifest, and a scripted
  `release:check`/`release:pr-check` gate wired into `ci.yml`.
- Specialist delegation is scoped correctly: `mcp-apps-ui` owns widgets only,
  `deploy-mcp-server`/`deploy-mcp-container` own Azure deployment only,
  `release-communications` is explicitly excluded from the dev-loop agent and
  gated on an already-published GitHub Release.
- `docs/REPO_STATE.md` gives every new agent/session a single, dense resume
  point instead of requiring full repo archaeology.

Findings below are refinements to an already-strong system, not a redesign.

## Findings and fixes applied in this change

| # | Finding | Fix applied |
| - | --- | --- |
| 1 | `.github/skills/mcp-apps-ui/SKILL.md` and `.github/agents/mcp-apps-ui.chatmode.md` both instruct agents to consult `/memories/repo/widget-and-tool-invariants.md` for the exact lockstep checklist, but that file never existed. Any agent following that instruction hit a dead reference. | Created `/memories/repo/widget-and-tool-invariants.md`, mirroring the authoritative 8-point list in `AGENTS.md` §"Critical invariants". |
| 2 | `SKILL.md`'s own numbered lockstep list (§6) was a 7-item subset of `AGENTS.md`'s 8-item canonical list — it omitted `src/ui/widgets.ts` `WIDGETS` registry and `scripts/agent365-mcp-registration.template.json` as explicit numbered steps. An agent that only loaded the skill (not `AGENTS.md`) could miss those two files. | Updated the numbered list in `SKILL.md` to match `AGENTS.md` exactly (9 items, including the `content`-payload rule). |

## Resolved decisions

The maintainer reviewed and resolved these four items on 2026-08-17.

### 1. Inconsistent / stale model pins across specialist chatmodes — unpinned

`grep` results before the fix:

| File | `model:` |
| --- | --- |
| `.github/agents/deploy-mcp-server.chatmode.md` | `Claude Sonnet 4` |
| `.github/agents/deploy-mcp-container.chatmode.md` | `Claude Sonnet 4` |
| `.github/agents/copilot-ready-release.chatmode.md` | `Claude Sonnet 4` |
| `.github/agents/mcp-apps-ui.chatmode.md` | `Claude Sonnet 4.5` |
| `.github/agents/cloud-development.agent.md` | *(no pin — inherits session model)* |
| `.github/agents/release-communications.agent.md` | *(no pin — inherits session model)* |

**Decision:** unpin all specialist chatmodes. **Applied:** removed the
`model:` frontmatter line from all four specialist chatmode files
(`deploy-mcp-server`, `deploy-mcp-container`, `copilot-ready-release`,
`mcp-apps-ui`). Every agent in this repo now inherits whatever model the
user/session has selected, matching the two orchestrator agents, and removes
the maintenance burden of tracking model-name deprecations across six files.

### 2. CodeQL is a documented merge gate with no in-repo workflow — documented

**Decision:** CodeQL is enabled directly through GitHub's repository settings
(**Settings → Code security → Code scanning → default setup**), not a
committed workflow file. **Applied:**
- Added an **Automated Security Scanning** section to
  [SECURITY.md](../SECURITY.md#automated-security-scanning) stating explicitly
  that CodeQL, secret scanning/push protection, and dependency updates are
  configured in repo Settings and via `dependabot.yml` /
  `dependency-health.yml` respectively, and that this must be re-verified if
  the repository is ever forked or transferred.
- Cross-referenced that section from `RELEASE_PLAN.md`'s maintainer checklist
  so "CodeQL is green" now says where to look instead of implying a workflow
  file exists.
- Deliberately did **not** add a `.github/workflows/codeql.yml`: GitHub
  rejects running both default setup and a custom CodeQL workflow for the same
  language, so adding one while default setup is active would have broken
  scanning rather than clarified it.

### 3. Stale one-time PR-template option — removed

**Decision:** the `1.0.0 → 1.1.6` reconciliation is closed (merged as PR #47),
so remove the option rather than keep documenting it as historical.
**Applied:**
- Removed **Version baseline alignment** from `.github/PULL_REQUEST_TEMPLATE.md`.
- Removed the `isBaselineAlignment` branch, its dedicated `fail()` messages,
  and the option from both `selectedOptions()` calls in
  `scripts/dev/release-governance.mjs`.
- Removed the corresponding checkbox line and the
  `"allows only the one-time version baseline alignment"` test from
  `test/releaseGovernance.test.ts`.
- Updated `docs/RELEASE_PLAN.md` to describe the kind as closed/historical
  instead of a currently-selectable option.
- Verified: `npm run build`, `npx vitest run test/releaseGovernance.test.ts
  test/cloudDevelopment.test.ts` (20/20 passed), and the full suite
  (412/413 passed; the one failure, `placeOrderAttribution.test.ts`, is an
  unrelated pre-existing timeout that passes in isolation and touches none of
  the changed files).

### 4. Optional container-deploy path allows secrets on the command line — fixed

`.github/agents/deploy-mcp-container.chatmode.md` rule 4 previously said: *"Use
Azure Container Apps secrets for secret values. Do not place secrets directly
in command history unless the user explicitly accepts that tradeoff."* The
worked example in Phase 5 then passed `--secrets
servicenow-client-secret=<value> ...` inline, which lands in shell history and
process listings regardless of the disclaimer.

**Applied:**
- Rule 4 is now unconditional: the agent must never type a real secret value
  into a command or ask the user to paste one into chat.
- Phase 5's worked example now has the user `export` the three secret values
  into their own shell first, then references those shell variables
  (`"$SERVICENOW_CLIENT_SECRET"`, etc.) in `--secrets` instead of a literal
  value. Shell history records the variable reference as typed, not the
  resolved secret.
- Documented the residual risk honestly: the resolved value is still briefly
  visible to anything reading the live process list while the command
  executes, and pointed to Key Vault references
  (`keyvaultref:<uri>,identityref:<id>`) as the stronger production
  alternative, with the verified syntax and caveat (a user-assigned identity
  is required at `create` time; `az containerapp secret set` with
  `identityref:system` works after creation) from
  [Manage secrets in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/manage-secrets#reference-secret-from-key-vault).
- Verified via Microsoft Learn docs search before writing the CLI syntax, to
  avoid hallucinating flags that don't exist (there is no generic `--secrets
  @file` shorthand in the Azure CLI).

## Things verified as already correct (no action)

- `debug/*.har` files present on disk are **not** tracked by git (`git
  ls-files debug/` returns nothing) and `debug/` is `.gitignore`d — the
  explicit "never commit HAR files" rule in `SECURITY.md` is actually being
  honored, not just documented.
- `dependency-health.yml` (weekly `npm audit --audit-level=high`) plus
  `dependabot.yml` (grouped weekly npm/GitHub Actions/Docker updates with
  major-version carve-outs for `@azure/*`/`typescript`/`@types/node`) is a
  reasonable, low-noise dependency-health cadence for a solo-maintainer repo.
- `release.yml` verifies the pushed tag is an annotated tag pointing at the
  current tip of `main` before publishing — prevents tagging a stale or
  off-branch commit as a release.
- The hosted Copilot coding agent path (`copilot-setup-steps.yml`) is
  correctly isolated from cloud credentials, and `test/cloudDevelopment.test.ts`
  encodes the cross-file contract (skill/agent/instructions/PR-template/
  workflow wording) as an executable test, so future edits to any of those
  files get caught by CI instead of drifting silently.

## Suggested next steps

All four decision points from this review are resolved. Periodically re-run
this review (or a narrower version of it) after adding a new agent/skill/
workflow, since the main risk in this system is silent drift between the
several places that describe the same contract (`AGENTS.md`, skill files,
chatmode files, PR template, and `test/cloudDevelopment.test.ts`).

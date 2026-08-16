---
name: cloud-development
description: >-
  Run the end-to-end agentic development workflow for this repository in GitHub
  Codespaces: configure cloud access, implement changes, delegate MCP Apps UI or
  Azure work, validate ServiceNow and Microsoft 365 test environments, prepare
  PR evidence, and stop at one final human PR approval gate. USE WHEN: setting
  up Codespaces, making cross-cutting changes, preparing a PR, validating a
  release candidate, testing in the ServiceNow instance or M365 test tenant, or
  asking whether a change is ready to merge. DO NOT USE FOR: post-release
  announcements or production/catalog publication.
argument-hint: Describe the change or candidate to prepare for final PR approval
---

# Agentic cloud development

Use this workflow to carry a change from request to an approval-ready pull
request. Keep all work in the Codespace and existing test infrastructure.

## Environments

- **Development workstation:** GitHub Codespaces, configured by
  `.devcontainer/devcontainer.json` and `docs/CODESPACES.md`.
- **ServiceNow test environment:** the configured `SERVICENOW_INSTANCE_URL`.
  Never infer or use production access.
- **Microsoft 365 test environment:** the `dev` Agents Toolkit environment and
  existing developer agent. Use the licensed account in
  `TEAMS_APP_TENANT_ID`.
- **Azure test runtime:** the configured `AZD_ENV_NAME` and
  `AZURE_RESOURCE_GROUP`.

Azure management (`AZURE_*`) and runtime/M365 identity (`ENTRA_*`,
`TEAMS_APP_TENANT_ID`) may use different tenants. Validate both; never replace
one with the other.

## Workflow

### 1. Establish the workspace

1. Read `AGENTS.md` and `docs/REPO_STATE.md`.
2. Run `npm run cloud:check` in Codespaces.
3. Inspect `git status`; preserve unrelated user changes.
4. Confirm the issue/request, current branch, and exact candidate SHA.

### 2. Implement autonomously

1. Find the owning code path and a focused falsifying check.
2. Delegate widget work to `mcp-apps-ui` and Azure deployment repair to
   `deploy-mcp-server` when applicable.
3. Make the smallest coherent change and run focused validation immediately.
4. Continue until the requested behavior and relevant tests are complete.

Do not pause for routine approvals inside the test environments. Mutating tests
must use marker-owned/idempotent fixtures and clean them up. Never mutate
unrelated ServiceNow records.

### 3. Validate the exact candidate

Classify the candidate before choosing a deployment path:

- **No `m365-agent/` or OAuth registration/configuration change:** deploy the
  exact SHA through the OIDC-backed `.github/workflows/deploy.yml` on `main`
  once its one-time Azure federation setup exists. Do not run `atk provision`;
  the existing agent uses the stable endpoint and dynamic MCP discovery.
- **M365 package/OAuth change:** build and validate the package autonomously,
  then mark delegated M365 provisioning as part of the final human gate. Never
  persist a human password, browser token, device-code token, or refresh token.
- **ServiceNow validation:** use the integration identity for autonomous API
  checks; reserve per-user OBO and ACL proof for the listed human personas.

Run, at minimum:

```bash
npm run build
npm test
npm run release:check
npm run preflight:readiness
```

For a user-facing or deployed change, run:

```bash
npm run release:auto -- --environment snowmcpwidg-dev
```

Use `release:auto` only when delegated M365 authentication is already present
or the candidate legitimately changes the M365 package. For package-neutral
changes, prefer the Azure OIDC deployment workflow plus live MCP validation.
Dispatch it with `gh workflow run deploy.yml --ref main -f
candidate_ref=<full-commit-sha>`; never dispatch an untrusted candidate's copy of
the deployment workflow or use a moving branch name as deployment evidence.

Record the deployed commit SHA, endpoint health, live tool validation, M365
package validation, storage-network restoration, and test fixture cleanup. Do
not claim click-through success from API/unit tests.

### 4. Prepare two-environment evidence

Before requesting human approval, add a reproducible **Human test plan** to the
PR. Never ask the approver to infer what to test. The plan must identify the
test agent/environment, personas, fixture preconditions, exact prompts and
clicks, expected tool/widget and visible states, corresponding ServiceNow
record/ACL checks, and cleanup. Mark the result `PENDING` until the human runs
it; change it to `PASS` only from the human's reported observations.

ServiceNow evidence must state:

- instance label, not credentials;
- scenario and test persona(s);
- expected records/state/attribution/ACL result;
- cleanup result for marker-owned records;
- known unavailable capabilities, such as HRSD when its tables are absent.

Microsoft 365 evidence must state:

- developer agent/environment and exact deployed SHA;
- prompts used and expected tool/widget;
- loading, success, error/recovery, and light/dark or narrow states when relevant;
- observed ServiceNow side effect or read result;
- no secrets, access tokens, tenant IDs, user PII, HAR files, or private URLs.

### 5. Open or update the pull request

Agents may push the branch and create/update a **draft PR** before click-through.
Populate the repository PR template, release impact, changelog note, automated
results, exact SHA, and pending click-through checklist. Keep the PR draft until
all automated and agent-owned work is finished.

### 6. Single human gate

Request one final human action:

1. Follow the PR's prepared Human test plan exactly in the Microsoft 365 test
  tenant; record deviations or failures instead of improvising around them.
2. Confirm the listed effects, caller attribution, and ACL behavior in the
  ServiceNow test environment, then run the listed cleanup.
3. Set the Human result to `PASS` with concise observed evidence and submit the
  final approval: an approving review from an independent reviewer, or an
  explicit merge instruction from the sole maintainer. Any failed step keeps
  the PR unapproved and returns it to the agent for repair.

After approval, do not push another commit. Any new push invalidates the Human
result and independent review, if present, and requires the final gate again.
Agents may merge only when CI, conversations, repository checks, and the
applicable approval record are complete.

## Hard stops

- Never deploy to production or publish to the organizational catalog as part of
  this workflow.
- Never grant tenant admin consent, approve Agent 365 tools, or bypass branch
  protection.
- Never describe an automated API test as human click-through evidence.
- Never make a Codespaces port public while local Entra auth is disabled.
- Never fabricate an independent review or treat an author's self-review as one.

## Evidence format

Use this concise block in the PR:

```markdown
### Human test plan
- Test tenant / agent: `<developer or organizational agent>`
- Test persona(s): `<roles/personas>`
- Preconditions / fixtures: `<safe setup>`
- Manual steps and expected results:
  1. `<prompt/click>` → `<expected tool, widget, visible state>`
- ServiceNow verification: `<record, attribution, ACL expectations>`
- Cleanup: `<cleanup/reset procedure>`
- Human result: PENDING

### Candidate evidence
- Exact SHA: `<sha>`
- Build/tests/release check: PASS
- Azure test deployment and live tools: PASS
- ServiceNow test environment: PASS/PENDING - `<scenario and observed result>`
- M365 test tenant click-through: PASS/PENDING - `<agent, prompts, widget result>`
- Fixture cleanup and storage security restoration: PASS
- Final approving review: PENDING/PASS
```

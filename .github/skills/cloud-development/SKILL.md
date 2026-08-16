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

Record the deployed commit SHA, endpoint health, live tool validation, M365
package validation, storage-network restoration, and test fixture cleanup. Do
not claim click-through success from API/unit tests.

### 4. Prepare two-environment evidence

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

1. Run the prepared click-through scenarios in the Microsoft 365 test tenant.
2. Confirm their expected effects in the ServiceNow test environment.
3. Add or confirm the evidence in the PR and submit one approving PR review.

After approval, do not push another commit. Branch protection dismisses stale
reviews; any new push requires the final gate again. Agents may merge only when
the required review, CI, conversations, and repository checks are green and the
user has explicitly asked for merge automation.

## Hard stops

- Never deploy to production or publish to the organizational catalog as part of
  this workflow.
- Never grant tenant admin consent, approve Agent 365 tools, or bypass branch
  protection.
- Never describe an automated API test as human click-through evidence.
- Never make a Codespaces port public while local Entra auth is disabled.
- Never approve a PR using the same identity that authored it.

## Evidence format

Use this concise block in the PR:

```markdown
### Candidate evidence
- Exact SHA: `<sha>`
- Build/tests/release check: PASS
- Azure test deployment and live tools: PASS
- ServiceNow test environment: PASS/PENDING - `<scenario and observed result>`
- M365 test tenant click-through: PASS/PENDING - `<agent, prompts, widget result>`
- Fixture cleanup and storage security restoration: PASS
- Final approving review: PENDING/PASS
```

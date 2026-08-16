# GitHub Codespaces development

This repository can use a Codespace as its primary development workstation. The
Azure Function remains deployed in Azure; the Codespace supplies the editor,
build/test toolchain, local Functions host, Azure and Microsoft 365 CLIs, and
controlled access to the ServiceNow test instance.

## What the container installs

The dev container pins Node.js 20 and installs:

- Azure CLI and Azure Developer CLI (`azd`)
- Azure Functions Core Tools 4
- PowerShell 7 and GitHub CLI
- Azurite for local Functions storage
- Microsoft 365 Agents Toolkit CLI and VS Code extension

Ports 7071 and 10000-10002 are forwarded privately for the Functions host and
Azurite. Do not make port 7071 public while `ENTRA_AUTH_DISABLED=true`.

## Identity boundaries

Keep these identities separate:

| Context | Variables | Purpose |
| --- | --- | --- |
| Azure management | `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | Access to the configured test resource group, deployment, monitoring, policy, and Key Vault metadata |
| MCP runtime / OBO | `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` | Inbound MCP OAuth and downstream ServiceNow OBO exchange |
| Microsoft 365 test tenant | `TEAMS_APP_TENANT_ID` plus the `TEAMS_*`, `M365_*`, and `MCP_DA_*` values | Existing developer agent, OAuth vault registration, sideload, and test-tenant publication |
| ServiceNow test instance | `SERVICENOW_*` | Direct local API development against the configured test instance |

The Azure management tenant can differ from the runtime/Microsoft 365 test
tenant. Never replace one with the other to make a login check pass.

## One-time secret migration

Codespaces does not receive ignored workstation files such as
`local.settings.json`, `.azure/`, or `m365-agent/env/.env.dev*`. Migrate their
values to repository-scoped Codespaces secrets from the configured workstation.
The command is dry-run-only unless `-Apply` is supplied:

```powershell
pwsh -File .devcontainer/scripts/set-codespaces-secrets.ps1
pwsh -File .devcontainer/scripts/set-codespaces-secrets.ps1 -Apply
```

The script reads the existing ignored files and active `azd` environment, checks
that all required runtime, Azure, and M365 values exist, and invokes `gh secret
set --app codespaces`. It prints names and status only, never values.

Codespaces secrets are injected as environment variables. On create and restart,
`.devcontainer/scripts/configure-codespaces.mjs` writes private, ignored copies of:

- `local.settings.json`
- `m365-agent/env/.env.dev`
- `m365-agent/env/.env.dev.user`

Rotate the ServiceNow and Entra client secrets if the old workstation is no
longer trusted. Existing Codespaces must be restarted after secret changes.

## Create and authenticate the Codespace

Create the Codespace from the intended branch. The post-create step installs
dependencies and tools, materializes ignored configuration, and builds the repo.
Then authenticate interactively; browser/device credentials are not stored in
GitHub secrets:

```bash
az login --tenant "$AZURE_TENANT_ID"
az account set --subscription "$AZURE_SUBSCRIPTION_ID"
azd auth login --tenant-id "$AZURE_TENANT_ID" --use-device-code

export ATK_CLI_SKILL=true
atk auth login m365
atk auth list
```

The M365 login must use the licensed test-tenant developer account. Azure login
must use an identity that can read and deploy to `AZURE_RESOURCE_GROUP`. Privileged
Agent 365 or tenant-admin approval remains a human/admin operation; Codespaces
does not bypass those roles.

The Codespace can reach the public Azure Function and ServiceNow test instance,
and it can provision/update the M365 developer agent after interactive sign-in.
It cannot impersonate the final human MCP Apps conversation or bypass tenant
Conditional Access, consent, licensing, or admin policy. `release:auto` stops at
that boundary by design.

## Authentication and autonomy matrix

| Work | Autonomous after setup | Supported authentication |
| --- | --- | --- |
| Build, unit tests, package validation | Yes | No cloud identity required |
| Azure code deployment | Yes | GitHub Actions OIDC (preferred), or a dedicated Azure service principal/certificate |
| ServiceNow integration API checks | Yes | Repository-scoped Codespaces secrets for the test integration identity |
| ServiceNow per-user OBO/ACL proof | No | Final human test personas supply delegated identity |
| M365 package build and schema validation | Yes | No M365 login required |
| M365 developer-agent/OAuth-vault provision or update | No | Delegated licensed M365 test account through `atk auth login m365` |
| M365 Copilot conversation and MCP Apps click-through | No | Final human test in the licensed test tenant |

The repository's `.github/workflows/deploy.yml` is already prepared for
secretless Azure deployment through GitHub OIDC, but remains inert until a
maintainer completes the one-time `azd pipeline config --provider github`
bootstrap in the correct Azure tenant/subscription. That command creates the
federated credential and configures `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`, `AZURE_ENV_NAME`, and `AZURE_LOCATION`. After bootstrap,
an agent can dispatch the workflow for a candidate branch without an interactive
Azure login or a stored Azure client secret.

The bootstrap values live in GitHub repository settings, not tracked env files.
Secret values remain encrypted Actions/Codespaces secrets; tenant, subscription,
location, environment, and resource-group identifiers are non-secret GitHub
variables. The workflow itself is intentionally visible and auditable in the
repository, while credentials are never committed.

Deploy an exact candidate without trusting its workflow definition:

```bash
gh workflow run deploy.yml \
  --repo pavecer/servicenow-mcp-apps-copilot \
  --ref main \
  -f candidate_ref=<40-character-commit-sha>
```

Always dispatch the workflow definition from `main`. It checks out the supplied
candidate SHA only after validating that it is immutable, while the OIDC token
remains bound to the trusted `main` workflow. The job creates a bounded source
checkout, reconciles the existing test infrastructure with `azd provision`,
deploys Function code with `azd deploy`, and validates the live MCP tool surface.
Runtime ServiceNow and Entra values are stored only as encrypted Actions secrets
or non-secret GitHub variables and are passed only to provision/deploy steps.
The deployment identity is scoped to the test resource group plus deployment
storage; it has no subscription-wide assignment. This workflow never provisions
or publishes the M365 agent package.

Do not store a human M365 password, browser cache, device-code token, or refresh
token to simulate app-only M365 support. The current `atk auth login m365`
command has no service-principal mode, and Microsoft Graph's Teams app catalog
publish/update APIs do not support application permissions. Keep delegated M365
provisioning at the human boundary when a package change actually requires it.

Most runtime, tool-schema, and widget changes do not require M365 package
provisioning: the existing agent points to the stable Azure endpoint and uses
dynamic MCP tool discovery. Deploy those candidates through the Azure OIDC
workflow, run live MCP and ServiceNow checks autonomously, and reserve M365 login
for changes under `m365-agent/` or OAuth registration/configuration.

## Validate the cloud workstation

```bash
npm run cloud:check
npm run preflight:readiness
npm run build
npm test
```

`cloud:check` verifies the required CLIs, ignored configuration files, GitHub
authentication, exact Azure management tenant/subscription, resource-group
access, and the deployed `/health` endpoint. The ServiceNow preflight performs
read-only probes for catalog, incident, Knowledge, and HR tables.

Current test-instance scope: catalog, incident, and Knowledge APIs are available.
HR Service Delivery is not installed (`sn_hr_core_case` and
`sn_hr_core_profile` return `Invalid table`), so HR development remains blocked
until that ServiceNow capability is enabled and ACLs are granted.

## Daily workflow

```bash
npm run build
npm test
npm run sn:local -- validate
npm run start:dev
```

Use the deployed Azure endpoint for Microsoft 365 Copilot tests. A private
Codespaces forwarded port is not reachable by the Microsoft 365 service. To
publish a candidate through the existing human test boundary:

```bash
npm run release:auto -- --environment snowmcpwidg-dev
```

This builds and tests, deploys the Function candidate, validates live tools, and
updates the existing developer agent. It intentionally stops before the human
Copilot conversation. Organizational catalog publication remains a separate,
approval-gated `release:publish` operation.

## Agentic pull request workflow

Use the workspace **Cloud Development** agent or load the `cloud-development`
skill for end-to-end work. Agents own implementation, specialist delegation,
tests, exact-commit Azure deployment, ServiceNow verification, M365 prompt
preparation, and draft PR evidence. The only human development gate follows the
prepared MCP Apps click-through in the Microsoft 365 test tenant and confirmation
of its expected records or read results in the ServiceNow test environment.

Every user-facing PR must contain a completed **Human test plan** before review.
The agent writes exact prompts/clicks and expected widget states, identifies the
test personas and fixtures, lists ServiceNow record/attribution/ACL checks, and
provides cleanup steps. The approver follows that script and records `PASS` or
the failed step in the PR. An independent collaborator submits an approving
review; in a sole-maintainer repository, the maintainer's explicit merge
instruction after recording `PASS` is the approval record.

Branch protection must require the `Build and test` status check and resolved
conversations. Require one approving review when an independent reviewer is
available. GitHub cannot accept an author's approval of their own PR, so a
sole-maintainer repository instead keeps the review count at zero and relies on
the recorded Human result plus explicit merge instruction. A push after either
form of approval invalidates the evidence and requires the final gate again.

GitHub's hosted Copilot coding agent uses
`.github/workflows/copilot-setup-steps.yml` to pin Node 20, install locked
dependencies, build the repository, and validate this contract. The hosted
agent intentionally has no `copilot` environment secrets, so it can implement
and test untrusted issue/PR work but cannot reach Azure, ServiceNow, or the M365
tenant. Hand live candidate validation to the **Cloud Development** agent in a
Codespace. Do not duplicate Codespaces credentials into Actions or Copilot
secrets merely to remove that isolation boundary.

## Security model

- No credentials are committed to the image, devcontainer, or repository.
- Local development credentials exist only as Codespaces secrets and ephemeral,
  ignored files inside the Codespace.
- Deployed Function secrets remain in Azure Key Vault and are resolved through
  the Function system-assigned managed identity.
- The Key Vault and deployment storage private endpoints are for the deployed
  Function. Codespace development does not require direct Key Vault secret read
  access.
- Delete stale Codespaces after use and rotate any credential suspected of
  exposure.

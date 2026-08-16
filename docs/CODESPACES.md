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
preparation, and draft PR evidence. The only human development gate is one
approving PR review after the prepared MCP Apps click-through succeeds in the
Microsoft 365 test tenant and its expected records or read results are confirmed
in the ServiceNow test environment.

Branch protection should require the `Build and test` status check, resolved
conversations, stale-review dismissal, and exactly one approving review. A push
after approval invalidates the evidence and requires the final gate again.

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

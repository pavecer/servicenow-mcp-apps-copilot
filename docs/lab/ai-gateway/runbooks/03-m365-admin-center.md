# Runbook 03: Microsoft 365 admin center (Agent 365 gateway consent)

Executed 2026-10-15 as Global Administrator.

## 1. Consent

1. `https://admin.cloud.microsoft` > Agents > Tools shows "AI gateway servers
   aren't shown because consent hasn't been granted"
   (45 (local: `screenshots/45-m365-agents-tools-consent-banner.png`)).
2. Agents > **Settings** > **Gateways (preview)**
   (46 (local: `screenshots/46-m365-gateways-panel.png`)).
3. Tick the consent checkbox. It then locks
   (47 (local: `screenshots/47-m365-gateways-consent-ticked.png`)).
4. A switch **Azure API Management service and Azure AI Gateway** appears; set
   it to Connected (48 (local: `screenshots/48-m365-gateways-azure-connected.png`)).

Effect: role assignment **A365 Gateway Policy Operator** at the tenant root
management group for service principal `maven-prod`
(appId `9b975845-388f-4429-889e-eab1ef63949c`). Verify:

```powershell
az role assignment list --all --assignee 9b975845-388f-4429-889e-eab1ef63949c -o table
az role definition list --name "A365 Gateway Policy Operator" --query "[0].permissions"
```

## 2. Discovery

Agents > Tools, search the server name, or filter Publisher = AI Gateway. In
the lab, nothing appeared within 27+ minutes
(53 (local: `screenshots/53-m365-tools-not-discovered-after-27min.png`)). The
consent role contains only `Microsoft.ApiManagement/service/*` actions, while
the AI Gateway tier resource is `Microsoft.ApiManagement/aigateways`.

Diagnostic used in the lab (optional, remove afterwards via 99-teardown): a
custom role `Lab A365 AI Gateway Policy Operator (aigateways)` with
`aigateways/read` and `aigateways/workspaces/toolServers/{read,write}`
assigned to `maven-prod` on the gateway only.

## 3. Not reached

Server block / unblock from M365 (expected gateway 403 `AccessBlockedByGateway`)
and tool-level control. Repeat when discovery works:

```powershell
node scripts/lab/ai-gateway/run-experiments.mjs --scenario poll --target gateway --no-bearer --poll 15 --timeout 900 --label C2-server-block
```

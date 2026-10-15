#Requires -Version 7
<#
.SYNOPSIS
  Tears down the AI Gateway governance lab (azd env `snowmcp-gwlab` only).

.DESCRIPTION
  Dry run by default: prints what would be removed. Pass -Confirm to act.
  Never touches any other azd environment, resource group or the dev M365 package.

  Automated (with -Confirm):
    1. Tenant/subscription guard.
    2. Deletes the lab AI Gateway (keys, MCP server, policies, RBAC go with it).
    3. Removes the lab diagnostic custom role (aigateways operator) and its assignment.
    4. `azd down --purge --force` for `snowmcp-gwlab`.
    5. Optional -RemoveEntraApps: deletes the three snowmcp-gwlab-* app registrations.
    6. Optional -RemoveTenantConsentRole: removes the "A365 Gateway Policy Operator"
       assignment at the tenant root management group (requires elevated access).

  Manual reminders are printed at the end (M365 admin center, ServiceNow OIDC entries).
#>
param(
  [Parameter(Mandatory = $true)][string]$TenantId,
  [Parameter(Mandatory = $true)][string]$SubscriptionId,
  [string]$AzdEnvironment = 'snowmcp-gwlab',
  [string]$ResourceGroup = 'rg-snowmcp-gwlab',
  [string]$GatewayName = 'snowmcp-gwlab-aigw',
  [switch]$RemoveEntraApps,
  [switch]$RemoveTenantConsentRole,
  [switch]$Confirm
)

$ErrorActionPreference = 'Stop'
$labRoleName = 'Lab A365 AI Gateway Policy Operator (aigateways)'
$a365AppId = '9b975845-388f-4429-889e-eab1ef63949c'
$labApps = @('snowmcp-gwlab-harness', 'snowmcp-gwlab-server', 'snowmcp-gwlab-snow-api')

function Step([string]$text, [scriptblock]$action) {
  if ($Confirm) { Write-Host "-> $text"; & $action } else { Write-Host "[dry-run] $text" }
}

$account = az account show -o json | ConvertFrom-Json
if ($account.tenantId -ne $TenantId -or $account.id -ne $SubscriptionId) {
  throw "Tenant guard: az is on tenant $($account.tenantId) / subscription $($account.id); expected $TenantId / $SubscriptionId."
}

$rgScope = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup"
$gatewayId = "$rgScope/providers/Microsoft.ApiManagement/aigateways/$GatewayName"

Step "Delete AI Gateway $GatewayName (API keys, MCP server 'servicenow', policies and RBAC are deleted with it)" {
  az resource delete --ids $gatewayId --api-version 2026-09-01-preview | Out-Null
}

Step "Remove custom role '$labRoleName' (assignment + definition)" {
  $sp = az ad sp show --id $a365AppId -o json | ConvertFrom-Json
  az role assignment delete --assignee $sp.id --role $labRoleName --scope $gatewayId 2>$null
  az role definition delete --name $labRoleName --scope $rgScope 2>$null
}

Step "azd down --purge --force for environment '$AzdEnvironment' only" {
  azd down -e $AzdEnvironment --purge --force --no-prompt
}

if ($RemoveEntraApps) {
  foreach ($name in $labApps) {
    Step "Delete Entra app registration '$name'" {
      $app = az ad app list --display-name $name -o json | ConvertFrom-Json | Select-Object -First 1
      if ($app) { az ad app delete --id $app.appId }
    }
  }
}

if ($RemoveTenantConsentRole) {
  Step "Remove 'A365 Gateway Policy Operator' assignment at tenant root management group" {
    $sp = az ad sp show --id $a365AppId -o json | ConvertFrom-Json
    az role assignment delete --assignee $sp.id --role 'A365 Gateway Policy Operator' `
      --scope "/providers/Microsoft.Management/managementGroups/$TenantId"
  }
}

Write-Host ''
Write-Host 'Manual steps (not automated):'
Write-Host '  - M365 admin center > Agents > Settings > Gateways: switch "Azure API Management service and Azure AI Gateway" to not connected.'
if (-not $RemoveTenantConsentRole) {
  Write-Host '  - Remove the tenant-level "A365 Gateway Policy Operator" assignment (or rerun with -RemoveTenantConsentRole).'
}
Write-Host '  - ServiceNow instance: remove the lab OIDC provider/entity created in runbook 01 (snowmcp-gwlab).'
Write-Host '  - Rotate the ServiceNow admin password if it was shared outside a password manager during the lab.'
Write-Host '  - npm run demo:cleanup only if npm run demo:seed was run against the lab.'
if (-not $Confirm) { Write-Host ''; Write-Host 'Dry run only. Re-run with -Confirm to execute.' }

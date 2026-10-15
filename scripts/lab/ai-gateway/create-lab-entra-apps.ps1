#requires -Version 7
<#
.SYNOPSIS
  LAB ONLY: creates the three Entra app registrations used by the AI gateway
  governance lab (docs/lab/ai-gateway/runbooks/01-lab-environment.md).

  - snowmcp-gwlab-server   inbound API (aud of user tokens), scope access_as_user
  - snowmcp-gwlab-snow-api downstream audience ServiceNow trusts, scope ServiceNow.Use
  - snowmcp-gwlab-harness  public client for device-code sign-in by the lab harness

  Idempotent: re-running reuses apps found by display name. Prints only IDs.
  The server app client secret is written to the azd env (never echoed).
  Requires AZD_CONFIG_DIR / azd env 'snowmcp-gwlab' to exist.
#>
param(
  [Parameter(Mandatory = $true)][string]$TenantId,
  [string]$AzdEnvironment = 'snowmcp-gwlab'
)
$ErrorActionPreference = 'Stop'

$account = az account show -o json | ConvertFrom-Json
if ($account.tenantId -ne $TenantId) { throw "Tenant guard: signed in to $($account.tenantId), expected $TenantId" }

function Invoke-Graph([string]$method, [string]$url, $body) {
  $file = New-TemporaryFile
  try {
    if ($null -ne $body) {
      $body | ConvertTo-Json -Depth 10 | Set-Content $file
      az rest --method $method --url $url --body "@$file" --headers 'Content-Type=application/json' -o json | ConvertFrom-Json
    } else {
      az rest --method $method --url $url -o json | ConvertFrom-Json
    }
  } finally { Remove-Item $file -ErrorAction SilentlyContinue }
}

function Get-OrCreateApp([string]$name, [hashtable]$extra) {
  $existing = az ad app list --display-name $name --query '[0]' -o json | ConvertFrom-Json
  if ($existing) { return $existing }
  $body = @{ displayName = $name; signInAudience = 'AzureADMyOrg'; tags = @('purpose:mcp-gateway-lab') } + $extra
  Invoke-Graph POST 'https://graph.microsoft.com/v1.0/applications' $body
}

function Ensure-Sp([string]$appId) {
  $sp = az ad sp list --filter "appId eq '$appId'" --query '[0]' -o json | ConvertFrom-Json
  if (-not $sp) { $sp = az ad sp create --id $appId -o json | ConvertFrom-Json }
  return $sp
}

function Ensure-Grant([string]$clientSpId, [string]$resourceSpId, [string]$scope) {
  $grant = Invoke-Graph GET "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?`$filter=clientId eq '$clientSpId' and resourceId eq '$resourceSpId'" $null
  if ($grant.value.Count -gt 0) { return }
  Invoke-Graph POST 'https://graph.microsoft.com/v1.0/oauth2PermissionGrants' @{ clientId = $clientSpId; consentType = 'AllPrincipals'; resourceId = $resourceSpId; scope = $scope } | Out-Null
}

function New-Scope([string]$value, [string]$text) {
  @{ id = [guid]::NewGuid().ToString(); value = $value; type = 'User'; isEnabled = $true
     adminConsentDisplayName = $text; adminConsentDescription = "Lab: $text"
     userConsentDisplayName = $text; userConsentDescription = "Lab: $text" }
}

# 1. Downstream ServiceNow audience
$snow = Get-OrCreateApp 'snowmcp-gwlab-snow-api' @{ api = @{ requestedAccessTokenVersion = 2; oauth2PermissionScopes = @(New-Scope 'ServiceNow.Use' 'Use ServiceNow as the signed-in user') } }
if (-not $snow.identifierUris -or $snow.identifierUris.Count -eq 0) { Invoke-Graph PATCH "https://graph.microsoft.com/v1.0/applications/$($snow.id)" @{ identifierUris = @("api://$($snow.appId)") } | Out-Null }
$snow = az ad app show --id $snow.appId -o json | ConvertFrom-Json
$snowScopeId = ($snow.api.oauth2PermissionScopes | Where-Object value -eq 'ServiceNow.Use').id

# 2. Inbound server API
$server = Get-OrCreateApp 'snowmcp-gwlab-server' @{
  api = @{ requestedAccessTokenVersion = 2; oauth2PermissionScopes = @(New-Scope 'access_as_user' 'Access the ServiceNow MCP lab server') }
  requiredResourceAccess = @(@{ resourceAppId = $snow.appId; resourceAccess = @(@{ id = $snowScopeId; type = 'Scope' }) })
}
if (-not $server.identifierUris -or $server.identifierUris.Count -eq 0) { Invoke-Graph PATCH "https://graph.microsoft.com/v1.0/applications/$($server.id)" @{ identifierUris = @("api://$($server.appId)") } | Out-Null }
$server = az ad app show --id $server.appId -o json | ConvertFrom-Json
$serverScopeId = ($server.api.oauth2PermissionScopes | Where-Object value -eq 'access_as_user').id

# Lab harness convenience: let the signed-in Azure CLI user get a delegated
# token for access_as_user without device code (az account get-access-token).
$azCliAppId = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'
if (-not ($server.api.preAuthorizedApplications | Where-Object appId -eq $azCliAppId)) {
  Invoke-Graph PATCH "https://graph.microsoft.com/v1.0/applications/$($server.id)" @{ api = @{ preAuthorizedApplications = @(@{ appId = $azCliAppId; delegatedPermissionIds = @($serverScopeId) }) } } | Out-Null
}

# 3. Harness public client (device code)
$harness = Get-OrCreateApp 'snowmcp-gwlab-harness' @{
  isFallbackPublicClient = $true
  publicClient = @{ redirectUris = @('http://localhost') }
  requiredResourceAccess = @(@{ resourceAppId = $server.appId; resourceAccess = @(@{ id = $serverScopeId; type = 'Scope' }) })
}

$snowSp = Ensure-Sp $snow.appId
$serverSp = Ensure-Sp $server.appId
$harnessSp = Ensure-Sp $harness.appId
Ensure-Grant $serverSp.id $snowSp.id 'ServiceNow.Use'
Ensure-Grant $harnessSp.id $serverSp.id 'access_as_user'

# Client secret for OBO, written straight into the azd env (never printed).
$hasSecret = @(az ad app credential list --id $server.appId -o json | ConvertFrom-Json).Count -gt 0
if (-not $hasSecret) {
  $secret = az ad app credential reset --id $server.appId --append --display-name 'gwlab-obo' --years 1 --query password -o tsv
  azd env set ENTRA_CLIENT_SECRET $secret -e $AzdEnvironment | Out-Null
  Remove-Variable secret
}

azd env set ENTRA_TENANT_ID $TenantId -e $AzdEnvironment | Out-Null
azd env set ENTRA_CLIENT_ID $server.appId -e $AzdEnvironment | Out-Null
azd env set ENTRA_OBO_DOWNSTREAM_SCOPE "api://$($snow.appId)/ServiceNow.Use" -e $AzdEnvironment | Out-Null
azd env set ENTRA_OAUTH_SCOPES "api://$($server.appId)/access_as_user openid profile offline_access" -e $AzdEnvironment | Out-Null
azd env set LAB_HARNESS_CLIENT_ID $harness.appId -e $AzdEnvironment | Out-Null

[pscustomobject]@{ serverAppId = $server.appId; snowApiAppId = $snow.appId; harnessAppId = $harness.appId } | Format-List

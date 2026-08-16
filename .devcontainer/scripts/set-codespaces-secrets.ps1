param(
  [string]$Repository = "pavecer/servicenow-mcp-apps-copilot",
  [switch]$Apply
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$settingsPath = Join-Path $repoRoot "local.settings.json"
$m365EnvPath = Join-Path $repoRoot "m365-agent/env/.env.dev"
$m365UserEnvPath = Join-Path $repoRoot "m365-agent/env/.env.dev.user"

function Read-DotEnv {
  param([string]$Path)

  $values = @{}
  if (-not (Test-Path $Path)) {
    return $values
  }

  foreach ($line in Get-Content $Path) {
    if ($line -match '^([A-Z0-9_]+)=(.*)$') {
      $values[$Matches[1]] = $Matches[2]
    }
  }
  return $values
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI (gh) is required."
}
if (-not (Test-Path $settingsPath)) {
  throw "local.settings.json is required as the source for runtime settings."
}

$runtime = (Get-Content $settingsPath -Raw | ConvertFrom-Json).Values
$m365 = Read-DotEnv -Path $m365EnvPath
$m365User = Read-DotEnv -Path $m365UserEnvPath
$azdKeys = @(
  "AZURE_SUBSCRIPTION_ID",
  "AZURE_TENANT_ID",
  "AZURE_LOCATION",
  "AZURE_RESOURCE_GROUP",
  "FUNCTION_APP_NAME",
  "MCP_ENDPOINT_URL",
  "KEY_VAULT_NAME"
)

$values = @{}
foreach ($property in $runtime.PSObject.Properties) {
  if (-not [string]::IsNullOrWhiteSpace([string]$property.Value)) {
    $values[$property.Name] = [string]$property.Value
  }
}
foreach ($entry in $m365.GetEnumerator()) {
  if (-not [string]::IsNullOrWhiteSpace([string]$entry.Value)) {
    $values[$entry.Key] = [string]$entry.Value
  }
}
foreach ($entry in $m365User.GetEnumerator()) {
  if (-not [string]::IsNullOrWhiteSpace([string]$entry.Value)) {
    $values[$entry.Key] = [string]$entry.Value
  }
}
foreach ($key in $azdKeys) {
  $value = (& azd env get-value $key 2>$null).Trim()
  if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($value)) {
    $values[$key] = $value
  }
}
$values["AZD_ENV_NAME"] = "snowmcpwidg-dev"

$required = @(
  "SERVICENOW_INSTANCE_URL",
  "SERVICENOW_CLIENT_ID",
  "SERVICENOW_CLIENT_SECRET",
  "SERVICENOW_USERNAME",
  "SERVICENOW_PASSWORD",
  "ENTRA_TENANT_ID",
  "ENTRA_CLIENT_ID",
  "ENTRA_CLIENT_SECRET",
  "ENTRA_OBO_DOWNSTREAM_SCOPE",
  "AZURE_SUBSCRIPTION_ID",
  "AZURE_TENANT_ID",
  "AZURE_RESOURCE_GROUP",
  "MCP_ENDPOINT_URL",
  "TEAMS_APP_ID",
  "TEAMS_APP_TENANT_ID",
  "MCP_DA_OAUTH_CLIENT_ID_FUNCYJ453F",
  "MCP_DA_OAUTH_SCOPE_FUNCYJ453F",
  "MCP_DA_AUTH_ID_FUNCYJ453F",
  "SECRET_MCP_DA_OAUTH_CLIENT_SECRET_FUNCYJ453F",
  "M365_TITLE_ID",
  "M365_APP_ID",
  "MCP_SERVER_URL",
  "MCP_SERVER_HOST"
)
$missing = @($required | Where-Object { -not $values.ContainsKey($_) })
if ($missing.Count -gt 0) {
  throw "Cannot configure Codespaces; missing source values: $($missing -join ', ')"
}

Write-Host "Codespaces secrets ready for $Repository ($($values.Count) values)."
if (-not $Apply.IsPresent) {
  Write-Host "Dry run only. Re-run with -Apply to upload them as repository-scoped Codespaces secrets."
  exit 0
}

foreach ($entry in $values.GetEnumerator() | Sort-Object Key) {
  $entry.Value | gh secret set $entry.Key --app codespaces --repo $Repository
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to set Codespaces secret $($entry.Key)."
  }
  Write-Host "Set $($entry.Key)."
}

Write-Host "Codespaces secrets configured. Existing Codespaces must be restarted to receive updated values."

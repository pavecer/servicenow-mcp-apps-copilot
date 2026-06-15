param(
  [string]$EnvironmentName,
  [string]$Location = "westeurope",
  [string]$SubscriptionId,
  [string]$ServiceNowInstanceUrl,
  [string]$ServiceNowClientId,
  [string]$ServiceNowClientSecret,
  [string]$ServiceNowUsername,
  [string]$ServiceNowPassword,
  [string]$ServiceNowOAuthTokenPath = "/oauth_token.do",
  [string]$EntraTenantId,
  [string]$EntraClientId,
  [string]$EntraClientSecret,
  [string]$EntraAudience,
  [switch]$SkipSmokeTest
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Require-Command {
  param([Parameter(Mandatory = $true)][string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found in PATH."
  }
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][ScriptBlock]$Script,
    [Parameter(Mandatory = $true)][string]$Description
  )

  Write-Host "==> $Description"
  & $Script
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE."
  }
}

function Read-RequiredValue {
  param(
    [Parameter(Mandatory = $true)][string]$Prompt,
    [string]$CurrentValue
  )

  if ([string]::IsNullOrWhiteSpace($CurrentValue)) {
    $CurrentValue = Read-Host $Prompt
  }

  if ([string]::IsNullOrWhiteSpace($CurrentValue)) {
    throw "$Prompt is required."
  }

  return $CurrentValue
}

function Read-SecretValue {
  param(
    [Parameter(Mandatory = $true)][string]$Prompt,
    [string]$CurrentValue
  )

  if (-not [string]::IsNullOrWhiteSpace($CurrentValue)) {
    return $CurrentValue
  }

  $secure = Read-Host $Prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  }
  finally {
    if ($bstr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }
}

function Mask-SecretForDisplay {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return "(empty)"
  }

  if ($Value.Length -le 8) {
    return "********"
  }

  return $Value.Substring(0, 4) + "..." + $Value.Substring($Value.Length - 4)
}

Require-Command -Name "az"
Require-Command -Name "azd"
Require-Command -Name "node"

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
  $EnvironmentName = Read-RequiredValue -Prompt "Enter azd environment name" -CurrentValue $EnvironmentName
  $ServiceNowInstanceUrl = Read-RequiredValue -Prompt "Enter ServiceNow instance URL (https://...service-now.com)" -CurrentValue $ServiceNowInstanceUrl
  $ServiceNowClientId = Read-RequiredValue -Prompt "Enter ServiceNow OAuth client ID" -CurrentValue $ServiceNowClientId
  $ServiceNowClientSecret = Read-SecretValue -Prompt "Enter ServiceNow OAuth client secret" -CurrentValue $ServiceNowClientSecret

  $uriCandidate = $null
  if (-not [Uri]::TryCreate($ServiceNowInstanceUrl, [UriKind]::Absolute, [ref]$uriCandidate)) {
    throw "ServiceNow instance URL is not a valid absolute URL."
  }

  if ($uriCandidate.Scheme -ne "https") {
    throw "ServiceNow instance URL must use https."
  }

  Write-Host "==> Verifying Azure login"
  az account show --output none 2>$null
  if ($LASTEXITCODE -ne 0) {
    Invoke-Checked -Description "Azure CLI login" -Script { az login }
  }

  if (-not [string]::IsNullOrWhiteSpace($SubscriptionId)) {
    Invoke-Checked -Description "Set Azure subscription" -Script {
      az account set --subscription $SubscriptionId
    }
  }

  Write-Host "==> Ensuring azd environment '$EnvironmentName'"
  azd env new $EnvironmentName --no-prompt 2>$null
  if ($LASTEXITCODE -ne 0) {
    Invoke-Checked -Description "Select existing azd environment" -Script {
      azd env select $EnvironmentName
    }
  }

  Invoke-Checked -Description "Set azd environment variable AZURE_LOCATION" -Script {
    azd env set AZURE_LOCATION $Location
  }

  if (-not [string]::IsNullOrWhiteSpace($SubscriptionId)) {
    Invoke-Checked -Description "Set azd environment variable AZURE_SUBSCRIPTION_ID" -Script {
      azd env set AZURE_SUBSCRIPTION_ID $SubscriptionId
    }
  }

  Invoke-Checked -Description "Set ServiceNow environment variables" -Script {
    azd env set SERVICENOW_INSTANCE_URL $ServiceNowInstanceUrl
    azd env set SERVICENOW_CLIENT_ID $ServiceNowClientId
    azd env set SERVICENOW_CLIENT_SECRET $ServiceNowClientSecret
    azd env set SERVICENOW_OAUTH_TOKEN_PATH $ServiceNowOAuthTokenPath
    if (-not [string]::IsNullOrWhiteSpace($ServiceNowUsername)) {
      azd env set SERVICENOW_USERNAME $ServiceNowUsername
    }
    if (-not [string]::IsNullOrWhiteSpace($ServiceNowPassword)) {
      azd env set SERVICENOW_PASSWORD $ServiceNowPassword
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($EntraTenantId)) {
    $EntraClientId   = Read-RequiredValue -Prompt "Enter Entra application (client) ID" -CurrentValue $EntraClientId
    $EntraClientSecret = Read-SecretValue -Prompt "Enter Entra client secret" -CurrentValue $EntraClientSecret

    Invoke-Checked -Description "Set Entra environment variables" -Script {
      azd env set ENTRA_TENANT_ID $EntraTenantId
      azd env set ENTRA_CLIENT_ID $EntraClientId
      azd env set ENTRA_CLIENT_SECRET $EntraClientSecret
      if (-not [string]::IsNullOrWhiteSpace($EntraAudience)) {
        azd env set ENTRA_AUDIENCE $EntraAudience
      }
    }
  }

  Invoke-Checked -Description "Install npm dependencies" -Script {
    npm install
  }

  Invoke-Checked -Description "Build TypeScript project" -Script {
    npm run build
  }

  Invoke-Checked -Description "Provision and deploy with azd" -Script {
    azd up --no-prompt
  }

  $endpointUrl = (azd env get-value MCP_ENDPOINT_URL).Trim()
  $functionAppName = (azd env get-value FUNCTION_APP_NAME).Trim()
  $resourceGroup = (azd env get-value AZURE_RESOURCE_GROUP).Trim()

  $functionKeysJson = az functionapp function keys list --resource-group $resourceGroup --name $functionAppName --function-name servicenow-mcp --output json
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to fetch function keys for the deployed MCP endpoint."
  }

  $functionKeys = $functionKeysJson | ConvertFrom-Json
  $defaultFunctionKey = $functionKeys.default

  if ([string]::IsNullOrWhiteSpace($endpointUrl) -or [string]::IsNullOrWhiteSpace($defaultFunctionKey)) {
    throw "Deployment succeeded but MCP endpoint URL or function key is missing."
  }

  Write-Host ""
  Write-Host "Deployment complete."
  Write-Host "MCP Endpoint URL : $endpointUrl"
  Write-Host "Function Key     : $(Mask-SecretForDisplay -Value $defaultFunctionKey)"
  Write-Host ""

  if (-not [string]::IsNullOrWhiteSpace($EntraTenantId)) {
    Write-Host "Copilot Studio setup (OAuth 2.0 - Dynamic discovery):"
    Write-Host "- MCP URL         = $endpointUrl"
    Write-Host "- Authentication  = OAuth 2.0"
    Write-Host "- Type            = Dynamic discovery"
    Write-Host ""
    Write-Host "  The wizard reads /.well-known/openid-configuration automatically."
    Write-Host "  Click 'Create' to register and complete the setup."
  } else {
    Write-Host "Copilot Studio setup (API key - Entra auth not configured):"
    Write-Host "- MCP URL         = $endpointUrl"
    Write-Host "- Authentication  = API key"
    Write-Host "- Header name     = x-functions-key"
    Write-Host "- Header value    = $(Mask-SecretForDisplay -Value $defaultFunctionKey)"
    Write-Host "  (Use the full key from Azure Function App -> Function keys; do not share it in logs.)"
  }

  if (-not $SkipSmokeTest.IsPresent) {
    Write-Host ""
    Write-Host "==> Running smoke test"
    $env:MCP_ENDPOINT_URL = $endpointUrl
    $env:FUNCTION_KEY = $defaultFunctionKey
    if (-not $env:SEARCH_QUERY) {
      $env:SEARCH_QUERY = "laptop"
    }
    if (-not $env:ORDER_VARIABLES_JSON) {
      $env:ORDER_VARIABLES_JSON = "{}"
    }

    Invoke-Checked -Description "Run MCP smoke test" -Script {
      node scripts/smoke-test.mjs
    }
  }
}
finally {
  Pop-Location
}

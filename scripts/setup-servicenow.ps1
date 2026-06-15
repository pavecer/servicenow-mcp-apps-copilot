<#
.SYNOPSIS
    Automates ServiceNow configuration for the MCP server.
.DESCRIPTION
    Creates the OAuth App Registry entry, integration user, and role assignments
    in ServiceNow via the REST API. Requires admin credentials.
.EXAMPLE
    pwsh -File setup-servicenow.ps1 `
      -InstanceUrl https://myinstance.service-now.com `
      -AdminUser admin `
      -AdminPassword <admin-password> `
      -IntegrationUserPassword <strong-password>
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$InstanceUrl,

    [Parameter(Mandatory = $true)]
    [string]$AdminUser,

    [Parameter(Mandatory = $true)]
    [string]$AdminPassword,

    [string]$OAuthAppName = "MCP Server",
    [string]$IntegrationUserId = "mcp_integration",
    [string]$IntegrationUserFirstName = "MCP",
    [string]$IntegrationUserLastName = "Integration",
    [string]$IntegrationUserPassword = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

$baseUrl = $InstanceUrl.TrimEnd("/")
$authHeader = "Basic " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${AdminUser}:${AdminPassword}"))

function Invoke-SnApi {
    param(
        [string]$Method,
        [string]$Path,
        [object]$Body = $null
    )

    $uri = "$baseUrl$Path"
    $params = @{
        Method  = $Method
        Uri     = $uri
        Headers = @{
            Authorization = $authHeader
            Accept        = "application/json"
            "Content-Type" = "application/json"
        }
    }

    if ($Body) {
        $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
    }

    $response = Invoke-RestMethod @params
    return $response
}

function Write-Step { param([string]$Msg) Write-Host "`n==> $Msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Msg) Write-Host "    OK: $Msg" -ForegroundColor Green }
function Write-Info { param([string]$Msg) Write-Host "    $Msg" -ForegroundColor Gray }
function Mask-Secret {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return "(empty)"
    }

    if ($Value.Length -le 8) {
        return "********"
    }

    return $Value.Substring(0, 4) + "..." + $Value.Substring($Value.Length - 4)
}

# ---------------------------------------------------------------------------
# Validate connectivity
# ---------------------------------------------------------------------------

Write-Step "Validating connectivity to $baseUrl"
try {
    Invoke-SnApi -Method GET -Path "/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id" | Out-Null
    Write-Ok "Connected successfully"
} catch {
    throw "Cannot reach ServiceNow API. Check instance URL and admin credentials. Error: $_"
}

# ---------------------------------------------------------------------------
# Step 1: Create OAuth App Registry entry
# ---------------------------------------------------------------------------

Write-Step "Step 1: Creating OAuth App Registry entry '$OAuthAppName'"

# Check if already exists
$existing = Invoke-SnApi -Method GET -Path "/api/now/table/oauth_entity?name=$([uri]::EscapeDataString($OAuthAppName))&sysparm_limit=1"

if ($existing.result.Count -gt 0) {
    $oauthRecord = $existing.result[0]
    Write-Info "OAuth app '$OAuthAppName' already exists (sys_id: $($oauthRecord.sys_id))"
} else {
    $oauthBody = @{
        name                = $OAuthAppName
        type                = "oauth2"
        default_grant_type  = "password"
        active              = $true
        refresh_token_lifespan = 8640000   # 100 days
        access_token_lifespan  = 1800      # 30 minutes
    }

    $created = Invoke-SnApi -Method POST -Path "/api/now/table/oauth_entity" -Body $oauthBody
    $oauthRecord = $created.result
    Write-Ok "OAuth app created (sys_id: $($oauthRecord.sys_id))"
}

# Retrieve the full record to get client_id and client_secret
$fullRecord = Invoke-SnApi -Method GET -Path "/api/now/table/oauth_entity/$($oauthRecord.sys_id)?sysparm_fields=client_id,client_secret,name"
$clientId = $fullRecord.result.client_id
$clientSecret = $fullRecord.result.client_secret

if ([string]::IsNullOrEmpty($clientId)) {
    throw "Could not retrieve Client ID from OAuth app record. Check admin permissions on oauth_entity table."
}

Write-Ok "Client ID: $clientId"
if ([string]::IsNullOrEmpty($clientSecret)) {
    Write-Host "    NOTE: Client Secret is masked in the API response. Retrieve it from the UI:" -ForegroundColor Yellow
    Write-Host "    System OAuth > Application Registry > $OAuthAppName > Client Secret (click lock icon)" -ForegroundColor Yellow
} else {
    Write-Ok "Client Secret retrieved: $(Mask-Secret -Value $clientSecret)"
}

# ---------------------------------------------------------------------------
# Step 2: Create integration user
# ---------------------------------------------------------------------------

Write-Step "Step 2: Creating integration user '$IntegrationUserId'"

if ([string]::IsNullOrEmpty($IntegrationUserPassword)) {
    $secure = Read-Host "Enter password for integration user '$IntegrationUserId'" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $IntegrationUserPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) } }
}

$existingUser = Invoke-SnApi -Method GET -Path "/api/now/table/sys_user?user_name=$([uri]::EscapeDataString($IntegrationUserId))&sysparm_limit=1&sysparm_fields=sys_id,user_name"

if ($existingUser.result.Count -gt 0) {
    $userSysId = $existingUser.result[0].sys_id
    Write-Info "User '$IntegrationUserId' already exists (sys_id: $userSysId)"
} else {
    $userBody = @{
        user_name              = $IntegrationUserId
        first_name             = $IntegrationUserFirstName
        last_name              = $IntegrationUserLastName
        active                 = $true
        password               = $IntegrationUserPassword
        password_needs_reset   = $false
    }

    $createdUser = Invoke-SnApi -Method POST -Path "/api/now/table/sys_user" -Body $userBody
    $userSysId = $createdUser.result.sys_id
    Write-Ok "User created (sys_id: $userSysId)"
}

# ---------------------------------------------------------------------------
# Step 3: Assign roles
# ---------------------------------------------------------------------------

Write-Step "Step 3: Assigning roles to '$IntegrationUserId'"

$requiredRoles = @("catalog", "itil")

foreach ($roleName in $requiredRoles) {
    # Find role sys_id
    $roleResult = Invoke-SnApi -Method GET -Path "/api/now/table/sys_user_role?name=$roleName&sysparm_limit=1&sysparm_fields=sys_id"
    if ($roleResult.result.Count -eq 0) {
        Write-Host "    WARNING: Role '$roleName' not found in sys_user_role table. Skipping." -ForegroundColor Yellow
        continue
    }
    $roleSysId = $roleResult.result[0].sys_id

    # Check if already assigned
    $existingAssignment = Invoke-SnApi -Method GET -Path "/api/now/table/sys_user_has_role?user=$userSysId&role=$roleSysId&sysparm_limit=1&sysparm_fields=sys_id"
    if ($existingAssignment.result.Count -gt 0) {
        Write-Info "Role '$roleName' already assigned"
        continue
    }

    # Assign
    $assignBody = @{
        user  = $userSysId
        role  = $roleSysId
        state = "active"
    }
    Invoke-SnApi -Method POST -Path "/api/now/table/sys_user_has_role" -Body $assignBody | Out-Null
    Write-Ok "Role '$roleName' assigned"
}

# ---------------------------------------------------------------------------
# Step 4: Validate OAuth token acquisition
# ---------------------------------------------------------------------------

Write-Step "Step 4: Validating OAuth token acquisition"

if (-not [string]::IsNullOrEmpty($clientSecret)) {
    try {
        $tokenParams = "grant_type=password&client_id=$clientId&client_secret=$([uri]::EscapeDataString($clientSecret))&username=$([uri]::EscapeDataString($IntegrationUserId))&password=$([uri]::EscapeDataString($IntegrationUserPassword))"
        $tokenResponse = Invoke-RestMethod -Method POST -Uri "$baseUrl/oauth_token.do" -Body $tokenParams -ContentType "application/x-www-form-urlencoded"
        if ($tokenResponse.access_token) {
            Write-Ok "OAuth token acquired successfully"
        }
    } catch {
        Write-Host "    WARNING: Could not validate OAuth token: $_" -ForegroundColor Yellow
        Write-Host "    This may be expected if client_secret was masked. Test manually after setup." -ForegroundColor Yellow
    }
} else {
    Write-Info "Skipping token validation (client_secret masked in API response)"
}

# ---------------------------------------------------------------------------
# Output summary
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host " ServiceNow Setup Complete" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Copy these values into your deployment script:" -ForegroundColor Cyan
Write-Host ""
Write-Host "  -ServiceNowInstanceUrl  `"$baseUrl`""
Write-Host "  -ServiceNowClientId     `"$clientId`""
if (-not [string]::IsNullOrEmpty($clientSecret)) {
    Write-Host "  -ServiceNowClientSecret `"$(Mask-Secret -Value $clientSecret)`""
    Write-Host "    (Use secure secret transfer to pass the full value; do not paste into shared logs.)"
} else {
    Write-Host "  -ServiceNowClientSecret `"<retrieve from UI: System OAuth > Application Registry > $OAuthAppName>`""
}
Write-Host "  -ServiceNowUsername     `"$IntegrationUserId`""
Write-Host "  -ServiceNowPassword     `"<the password you set>`""
Write-Host ""
Write-Host "Next step: run scripts/deploy-azure.ps1 or 'npm run deploy:azure'" -ForegroundColor Cyan

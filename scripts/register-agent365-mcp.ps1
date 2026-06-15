<#
.SYNOPSIS
    Registers this MCP server with Microsoft Agent 365 as a BYO (Bring-Your-Own)
    MCP server using the EntraOAuth authentication type.

.DESCRIPTION
    1. Verifies the Agent 365 CLI ('a365') is installed and at the required
       version (>= 1.1.165-preview).
    2. Verifies the Agent 365 service principal
       (appId ea9ffc3e-8a23-4a7d-836d-234d7c7565c1) is provisioned in the
       current tenant.
    3. Renders scripts/agent365-mcp-registration.json from the .template.json
       file with the values you pass in (or are prompted for).
    4. Calls 'a365 develop-mcp register-external-mcp-server -f <file>'.

    See docs/AGENT_365_BYO_MCP.md for the end-to-end guide and admin approval
    steps that follow this script.

.PARAMETER ServerName
    Internal MCP server name. MUST start with 'ext_' and be at most 20 characters
    (Agent 365 CLI constraint), e.g. 'ext_ServiceNowMCP'. This is the identifier
    used in agent manifests; the user-facing display name comes from publisher
    metadata + tool descriptions.

.PARAMETER PublisherName
    Your organization's display name (publisher column in the registry).

.PARAMETER TenantId
    Optional Entra tenant ID for the new app registration. Defaults to the
    current 'az login' tenant when omitted.

.PARAMETER McpEndpointUrl
    Public HTTPS URL of the deployed MCP endpoint, e.g.
    https://<funcapp>.azurewebsites.net/mcp.

.PARAMETER EntraClientId
    The Entra app registration client ID configured on the deployed MCP server
    (ENTRA_CLIENT_ID). Used to build the EntraOAuth remote scope
    api://<EntraClientId>/.default.

.PARAMETER Description
    Optional override for the description text submitted to Agent 365.

.PARAMETER SkipServicePrincipalCheck
    Skip the 'az ad sp show' verification step (use when running outside Azure
    CLI or against a tenant where you already know the SP is provisioned).

.PARAMETER WhatIf
    Render the registration JSON but do not call the Agent 365 CLI.

.EXAMPLE
    pwsh -File scripts/register-agent365-mcp.ps1 `
      -ServerName "ext_ServiceNowMCP" `
      -PublisherName "Contoso IT" `
      -McpEndpointUrl "https://snow-mcp.azurewebsites.net/mcp" `
      -EntraClientId "11111111-2222-3333-4444-555555555555" `
      -TenantId "22222222-3333-4444-5555-666666666666"
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ServerName = "ext_ServiceNowMCP",
    [string]$PublisherName,
    [string]$McpEndpointUrl,
    [string]$EntraClientId,
    [string]$TenantId,
    [string]$Description = "ServiceNow Service Catalog: search items, fill forms, place and manage orders.",
    [switch]$SkipServicePrincipalCheck
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# -----------------------------------------------------------------------------
# Constants
# -----------------------------------------------------------------------------
$Agent365AppId = "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1"
$RequiredCliVersion = [version]"1.1.165"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$TemplatePath = Join-Path $PSScriptRoot "agent365-mcp-registration.template.json"
$ResolvedPath = Join-Path $PSScriptRoot "agent365-mcp-registration.json"

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
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
    return $CurrentValue.Trim()
}

function Test-Command {
    param([Parameter(Mandatory = $true)][string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Assert-A365Cli {
    if (-not (Test-Command "a365")) {
        throw "Agent 365 CLI ('a365') was not found in PATH. Install it as a .NET global tool: dotnet tool install --global Microsoft.Agents.A365.DevTools.Cli (see https://learn.microsoft.com/en-us/microsoft-agent-365/developer/agent-365-cli#install-the-agent-365-cli)"
    }

    $rawVersion = (& a365 --version 2>$null) -join " "
    if (-not $rawVersion) {
        Write-Warning "Could not determine Agent 365 CLI version. Required: >= $RequiredCliVersion-preview."
        return
    }

    # The CLI prints something like "1.1.165-preview" or "a365 1.1.165-preview".
    $match = [regex]::Match($rawVersion, "(\d+)\.(\d+)\.(\d+)")
    if (-not $match.Success) {
        Write-Warning "Could not parse Agent 365 CLI version from '$rawVersion'. Continuing."
        return
    }
    $detected = [version]("$($match.Groups[1].Value).$($match.Groups[2].Value).$($match.Groups[3].Value)")
    if ($detected -lt $RequiredCliVersion) {
        throw "Agent 365 CLI version $detected is below the required $RequiredCliVersion-preview. Please update."
    }
    Write-Host "==> Agent 365 CLI version $detected detected (>= $RequiredCliVersion required)."
}

function Assert-Agent365ServicePrincipal {
    if ($SkipServicePrincipalCheck) {
        Write-Host "==> Skipping Agent 365 service principal check (per -SkipServicePrincipalCheck)."
        return
    }
    if (-not (Test-Command "az")) {
        Write-Warning "Azure CLI ('az') not found; cannot verify Agent 365 service principal. Pass -SkipServicePrincipalCheck to silence this warning."
        return
    }

    Write-Host "==> Verifying Agent 365 service principal (appId $Agent365AppId)..."
    $sp = & az ad sp show --id $Agent365AppId --only-show-errors 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $sp) {
        throw @"
Agent 365 service principal not found in the current tenant.
Provision it before registering a BYO MCP server. See:
  https://learn.microsoft.com/en-us/microsoft-agent-365/developer/tooling#set-up-service-principal
"@
    }
    Write-Host "==> Agent 365 service principal is provisioned."
}

function Test-ServerName {
    param([Parameter(Mandatory = $true)][string]$Name)
    if ($Name -notmatch '^ext_') {
        throw "Server name '$Name' must start with 'ext_' (Agent 365 CLI constraint)."
    }
    if ($Name.Length -gt 20) {
        throw "Server name '$Name' is $($Name.Length) characters; the limit is 20."
    }
}

function Test-Description {
    param([Parameter(Mandatory = $true)][string]$Text)
    if ($Text.Length -gt 80) {
        throw "Description is $($Text.Length) characters; the Agent 365 limit is 80. Shorten the -Description value (or the description field in scripts/agent365-mcp-registration.template.json)."
    }
}

function Test-ToolNames {
    param([Parameter(Mandatory = $true)][object]$Tools)
    foreach ($tool in $Tools) {
        $name = [string]$tool.name
        if ([string]::IsNullOrWhiteSpace($name)) {
            throw "A tool entry in the template is missing a 'name' field."
        }
        if ($name.Length -gt 30) {
            throw "Tool name '$name' is $($name.Length) characters; the Agent 365 limit is 30. Rename the tool in scripts/agent365-mcp-registration.template.json (and the corresponding registration in src/tools/)."
        }
    }
}

function New-RegistrationPayload {
    param(
        [Parameter(Mandatory = $true)][string]$ServerName,
        [Parameter(Mandatory = $true)][string]$PublisherName,
        [Parameter(Mandatory = $true)][string]$McpEndpointUrl,
        [Parameter(Mandatory = $true)][string]$EntraClientId,
        [Parameter(Mandatory = $true)][string]$Description,
        [string]$TenantId
    )

    if (-not (Test-Path $TemplatePath)) {
        throw "Registration template not found at $TemplatePath."
    }

    $template = Get-Content -Raw -Path $TemplatePath | ConvertFrom-Json
    Test-ToolNames -Tools $template.tools
    $template.serverName = $ServerName
    $template.publisherName = $PublisherName
    $template.serverUrl = $McpEndpointUrl
    $template.description = $Description
    $template.remoteScopes = "api://$EntraClientId/.default"
    if ($PSBoundParameters.ContainsKey('TenantId') -and -not [string]::IsNullOrWhiteSpace($TenantId)) {
        $template.tenantId = $TenantId
    } else {
        # Drop placeholder so CLI defaults to current az login tenant.
        if ($template.PSObject.Properties.Name -contains 'tenantId') {
            $template.PSObject.Properties.Remove('tenantId')
        }
    }
    # Drop the schema-comment line — it isn't part of the wire format.
    if ($template.PSObject.Properties.Name -contains '$schema-comment') {
        $template.PSObject.Properties.Remove('$schema-comment')
    }

    $json = $template | ConvertTo-Json -Depth 10
    Set-Content -Path $ResolvedPath -Value $json -Encoding utf8
    return $ResolvedPath
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
$ServerName     = Read-RequiredValue -Prompt "Server name (must start with 'ext_', max 20 chars)" -CurrentValue $ServerName
$PublisherName  = Read-RequiredValue -Prompt "Publisher (your organization)" -CurrentValue $PublisherName
$McpEndpointUrl = Read-RequiredValue -Prompt "MCP endpoint URL (https://.../mcp)" -CurrentValue $McpEndpointUrl
$EntraClientId  = Read-RequiredValue -Prompt "Entra ID client ID of the deployed MCP server" -CurrentValue $EntraClientId

Test-ServerName -Name $ServerName
Test-Description -Text $Description
if ($McpEndpointUrl -notmatch '^https://') {
    throw "MCP endpoint URL must be HTTPS. Got: $McpEndpointUrl"
}
if ($McpEndpointUrl -notmatch '/mcp/?$') {
    Write-Warning "MCP endpoint URL does not end in '/mcp'. Make sure your route is correct."
}

Assert-A365Cli
Assert-Agent365ServicePrincipal

$payloadArgs = @{
    ServerName     = $ServerName
    PublisherName  = $PublisherName
    McpEndpointUrl = $McpEndpointUrl
    EntraClientId  = $EntraClientId
    Description    = $Description
}
if (-not [string]::IsNullOrWhiteSpace($TenantId)) {
    $payloadArgs.TenantId = $TenantId
}
$payloadPath = New-RegistrationPayload @payloadArgs

Write-Host ""
Write-Host "==> Registration payload written to: $payloadPath"
Write-Host "    (this file is gitignored — do not commit tenant-specific values)"
Write-Host ""

if ($PSCmdlet.ShouldProcess($McpEndpointUrl, "a365 develop-mcp register-external-mcp-server")) {
    & a365 develop-mcp register-external-mcp-server -f $payloadPath
    if ($LASTEXITCODE -ne 0) {
        throw "Agent 365 CLI registration failed with exit code $LASTEXITCODE."
    }

    Write-Host ""
    Write-Host "==> Registration submitted."
    Write-Host "    Next: a Global admin or AI admin must approve the request in"
    Write-Host "    Microsoft 365 admin center > Agents > Tools > Requests."
    Write-Host "    See docs/AGENT_365_BYO_MCP.md (Step 5) for details."
}
else {
    Write-Host "==> Skipping CLI invocation (WhatIf). Inspect $payloadPath and re-run without -WhatIf."
}

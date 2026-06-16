targetScope = 'resourceGroup'

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

@minLength(1)
@maxLength(64)
@description('Name of the azd environment (used to generate unique resource names).')
param environmentName string

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('ServiceNow instance URL, e.g. https://your-instance.service-now.com')
param serviceNowInstanceUrl string

@description('ServiceNow OAuth client ID.')
param serviceNowClientId string

@description('ServiceNow OAuth client secret.')
@secure()
param serviceNowClientSecret string

@description('ServiceNow integration user username (for password grant).')
param serviceNowUsername string = ''

@description('ServiceNow integration user password (for password grant).')
@secure()
param serviceNowPassword string = ''

@description('Entra tenant ID for OAuth 2.0 authentication (optional).')
param entraTenantId string = ''

@description('Entra application client ID for OAuth 2.0 authentication (optional).')
param entraClientId string = ''

@description('Entra application client secret for DCR (optional).')
@secure()
param entraClientSecret string = ''

@description('Expected audience override in Entra tokens (optional; defaults to entraClientId).')
param entraAudience string = ''

@description('Comma-separated list of trusted Entra tenant IDs for cross-tenant token validation (optional).')
param entraTrustedTenantIds string = ''

@description('Allow tokens from any Entra tenant (true/false). Keep false for production unless explicitly required.')
@allowed([ 'true', 'false' ])
param entraAllowAnyTenant string = 'false'

@description('Disable Entra Bearer validation entirely (true/false). MUST be "false" in production.')
@allowed([ 'true', 'false' ])
param entraAuthDisabled string = 'false'

@description('Space-delimited Entra OAuth scopes advertised in OIDC discovery and DCR.')
param entraOauthScopes string = ''

@description('RFC 7591 initial access token required on POST /oauth/register. Stored in Key Vault when set.')
@secure()
param entraDcrRegistrationToken string = ''

@description('Allow unauthenticated Dynamic Client Registration (true/false). Keep "false" for production.')
@allowed([ 'true', 'false' ])
param entraDcrAllowUnauthenticated string = 'false'

@description('Comma-separated list of additional accepted audience values for Entra tokens.')
param entraAllowedAudiences string = ''

@description('Enable On-Behalf-Of (OBO) token exchange so the inbound user Entra token is swapped for a downstream token whose audience ServiceNow trusts (Pattern A). Default false preserves the existing integration-user grant path.')
@allowed([ 'true', 'false' ])
param entraOboEnabled string = 'false'

@description('Downstream scope requested in the OBO exchange (e.g. api://<server-app-id>/ServiceNow.Use). Required when entraOboEnabled is true.')
param entraOboDownstreamScope string = ''

@description('Comma-separated list of browser origins allowed for CORS-enabled endpoints.')
param corsAllowedOrigins string = ''

@description('Require x-servicenow-access-token from caller (true/false). Disables fallback to integration user.')
@allowed([ 'true', 'false' ])
param serviceNowRequireCallerAccessToken string = 'false'

@description('ServiceNow OAuth token endpoint path. Override only if your instance uses a non-standard path.')
param serviceNowOauthTokenPath string = '/oauth_token.do'

@description('ServiceNow OAuth grant strategy: auto, password, or client_credentials.')
@allowed([ 'auto', 'password', 'client_credentials' ])
param serviceNowOauthGrantType string = 'auto'

@description('ServiceNow OAuth client auth style: auto, request_body, or basic.')
@allowed([ 'auto', 'request_body', 'basic' ])
param serviceNowOauthClientAuthStyle string = 'auto'

@description('Comma-separated sys_user fields used to resolve requested_for from caller identity.')
param serviceNowRequestedForLookupFields string = 'email,user_name'

@description('Comma-separated caller-context fields used as candidates for requested_for resolution.')
param serviceNowRequestedForCallerFields string = 'callerUpn'

@description('When "true" (default) fall back to the raw caller value when sys_user lookup does not resolve.')
@allowed([ 'true', 'false' ])
param serviceNowRequestedForFallbackToCallerValue string = 'true'

@description('Emit requested_for diagnostics in tool responses (true/false). Use only for short-lived troubleshooting.')
@allowed([ 'true', 'false' ])
param serviceNowRequestedForDiagnostics string = 'false'

@description('Include caller PII in diagnostics (true/false). Requires serviceNowRequestedForDiagnostics=true.')
@allowed([ 'true', 'false' ])
param serviceNowRequestedForDiagnosticsIncludePii string = 'false'

@description('Minimum log level: debug, info, warn, or error.')
@allowed([ 'debug', 'info', 'warn', 'error' ])
param logLevel string = 'info'

@description('Include caller identity (oid, upn) in structured log entries (true/false).')
@allowed([ 'true', 'false' ])
param logIncludeCallerIdentity string = 'false'

@description('Include error stack traces in structured log entries (true/false).')
@allowed([ 'true', 'false' ])
param logIncludeErrorStack string = 'false'

@description('Enable SEP-1865 "MCP Apps" widget rendering for Microsoft 365 Copilot (true/false). Default false keeps the default (non-MCP-Apps) surface byte-identical. Flip to true once the Entra redirect URIs for M365 Copilot are added to the app registration.')
@allowed([ 'true', 'false' ])
param mcpAppsEnabled string = 'false'

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))
var tags = { 'azd-env-name': environmentName }
var keyVaultName = 'kv-${resourceToken}'

// ---------------------------------------------------------------------------
// Log Analytics Workspace
// ---------------------------------------------------------------------------

resource logWorkspace 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: 'log-${resourceToken}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ---------------------------------------------------------------------------
// Application Insights
// ---------------------------------------------------------------------------

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${resourceToken}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logWorkspace.id
  }
}

// ---------------------------------------------------------------------------
// Key Vault
// ---------------------------------------------------------------------------

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enabledForDeployment: false
    enabledForTemplateDeployment: false
    enabledForDiskEncryption: false
    publicNetworkAccess: 'Enabled'
  }
}

resource serviceNowClientSecretKeyVaultSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'servicenow-client-secret'
  properties: {
    value: serviceNowClientSecret
  }
}

resource serviceNowPasswordKeyVaultSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(serviceNowPassword)) {
  parent: keyVault
  name: 'servicenow-password'
  properties: {
    value: serviceNowPassword
  }
}

resource entraClientSecretKeyVaultSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(entraClientSecret)) {
  parent: keyVault
  name: 'entra-client-secret'
  properties: {
    value: entraClientSecret
  }
}

resource entraDcrRegistrationTokenKeyVaultSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(entraDcrRegistrationToken)) {
  parent: keyVault
  name: 'entra-dcr-registration-token'
  properties: {
    value: entraDcrRegistrationToken
  }
}

// ---------------------------------------------------------------------------
// Storage Account (used for function deployment packages)
// ---------------------------------------------------------------------------

resource storage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: 'st${resourceToken}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

// Container for deployment packages (required by Flex Consumption)
resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  name: '${storage.name}/default/deploymentpackages'
  properties: {
    publicAccess: 'None'
  }
}

// ---------------------------------------------------------------------------
// Flex Consumption Hosting Plan (FC1)
// ---------------------------------------------------------------------------

resource hostingPlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'asp-${resourceToken}'
  location: location
  tags: tags
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  kind: 'functionapp'
  properties: {
    reserved: true // Linux
  }
}

// ---------------------------------------------------------------------------
// Function App
// ---------------------------------------------------------------------------

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: 'func-${resourceToken}'
  location: location
  tags: union(tags, { 'azd-service-name': 'api' })
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: hostingPlan.id
    siteConfig: {
      // Platform-level CORS. The Azure Functions host intercepts OPTIONS
      // preflight requests BEFORE app code runs, so browser clients (e.g. the
      // Microsoft 365 Copilot widget-renderer iframe) must be allowlisted here
      // — app-level CORS_ALLOWED_ORIGINS cannot satisfy the preflight on its own.
      cors: {
        allowedOrigins: empty(corsAllowedOrigins) ? [] : split(corsAllowedOrigins, ',')
      }
      appSettings: [
        // Storage access via managed identity (Flex Consumption requirement)
        { name: 'AzureWebJobsStorage__accountName', value: storage.name }
        { name: 'AzureWebJobsStorage__blobServiceUri', value: storage.properties.primaryEndpoints.blob }
        { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
        // Application Insights
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        // ServiceNow configuration
        { name: 'SERVICENOW_INSTANCE_URL', value: serviceNowInstanceUrl }
        { name: 'SERVICENOW_CLIENT_ID', value: serviceNowClientId }
        {
          name: 'SERVICENOW_CLIENT_SECRET'
          value: '@Microsoft.KeyVault(SecretUri=${serviceNowClientSecretKeyVaultSecret.properties.secretUriWithVersion})'
        }
        { name: 'SERVICENOW_OAUTH_TOKEN_PATH', value: serviceNowOauthTokenPath }
        { name: 'SERVICENOW_OAUTH_GRANT_TYPE', value: serviceNowOauthGrantType }
        { name: 'SERVICENOW_OAUTH_CLIENT_AUTH_STYLE', value: serviceNowOauthClientAuthStyle }
        { name: 'SERVICENOW_USERNAME', value: serviceNowUsername }
        {
          name: 'SERVICENOW_PASSWORD'
          // Reference Key Vault when a password was provided; otherwise empty.
          value: empty(serviceNowPassword) ? '' : '@Microsoft.KeyVault(SecretUri=${serviceNowPasswordKeyVaultSecret!.properties.secretUriWithVersion})'
        }
        { name: 'SERVICENOW_REQUIRE_CALLER_ACCESS_TOKEN', value: serviceNowRequireCallerAccessToken }
        { name: 'SERVICENOW_REQUESTED_FOR_LOOKUP_FIELDS', value: serviceNowRequestedForLookupFields }
        { name: 'SERVICENOW_REQUESTED_FOR_CALLER_FIELDS', value: serviceNowRequestedForCallerFields }
        { name: 'SERVICENOW_REQUESTED_FOR_FALLBACK_TO_CALLER_VALUE', value: serviceNowRequestedForFallbackToCallerValue }
        { name: 'SERVICENOW_REQUESTED_FOR_DIAGNOSTICS', value: serviceNowRequestedForDiagnostics }
        { name: 'SERVICENOW_REQUESTED_FOR_DIAGNOSTICS_INCLUDE_PII', value: serviceNowRequestedForDiagnosticsIncludePii }
        // Entra ID OAuth 2.0 configuration (optional)
        { name: 'ENTRA_TENANT_ID', value: entraTenantId }
        { name: 'ENTRA_CLIENT_ID', value: entraClientId }
        {
          name: 'ENTRA_CLIENT_SECRET'
          value: empty(entraClientSecret) ? '' : '@Microsoft.KeyVault(SecretUri=${entraClientSecretKeyVaultSecret!.properties.secretUriWithVersion})'
        }
        { name: 'ENTRA_AUDIENCE', value: entraAudience }
        { name: 'ENTRA_ALLOWED_AUDIENCES', value: entraAllowedAudiences }
        { name: 'ENTRA_OAUTH_SCOPES', value: entraOauthScopes }
        { name: 'ENTRA_TRUSTED_TENANT_IDS', value: entraTrustedTenantIds }
        { name: 'ENTRA_ALLOW_ANY_TENANT', value: entraAllowAnyTenant }
        { name: 'ENTRA_AUTH_DISABLED', value: entraAuthDisabled }
        {
          name: 'ENTRA_DCR_REGISTRATION_TOKEN'
          value: empty(entraDcrRegistrationToken) ? '' : '@Microsoft.KeyVault(SecretUri=${entraDcrRegistrationTokenKeyVaultSecret!.properties.secretUriWithVersion})'
        }
        { name: 'ENTRA_DCR_ALLOW_UNAUTHENTICATED', value: entraDcrAllowUnauthenticated }
        { name: 'ENTRA_OBO_ENABLED', value: entraOboEnabled }
        { name: 'ENTRA_OBO_DOWNSTREAM_SCOPE', value: entraOboDownstreamScope }
        // CORS is configured at the platform level via siteConfig.cors above
        // (the Functions host handles OPTIONS preflight); no app setting needed.
        { name: 'LOG_LEVEL', value: logLevel }
        { name: 'LOG_INCLUDE_CALLER_IDENTITY', value: logIncludeCallerIdentity }
        { name: 'LOG_INCLUDE_ERROR_STACK', value: logIncludeErrorStack }
        // SEP-1865 MCP Apps widget rendering (Microsoft 365 Copilot). Default
        // "false" preserves the default (non-MCP-Apps) surface byte-identical.
        { name: 'MCP_APPS_ENABLED', value: mcpAppsEnabled }
      ]
    }
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}deploymentpackages'
          authentication: {
            type: 'SystemAssignedIdentity'
          }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 40
        instanceMemoryMB: 2048
      }
      runtime: {
        name: 'node'
        version: '20'
      }
    }
  }
  dependsOn: [deploymentContainer]
}

// ---------------------------------------------------------------------------
// RBAC: grant the function app's managed identity access to the storage blob
// (required for Flex Consumption deployment package access)
// ---------------------------------------------------------------------------

// Storage Blob Data Owner — needed to read/write deployment packages
resource functionAppStorageRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, functionApp.id, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'ba92f5b4-2d11-453d-a403-e96b0029c9fe' // Storage Blob Data Owner
    )
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Key Vault Secrets User - allows app to resolve Key Vault references in app settings
resource functionAppKeyVaultRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, functionApp.id, '4633458b-17de-408a-b874-0445c86b69e6')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4633458b-17de-408a-b874-0445c86b69e6' // Key Vault Secrets User
    )
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// Outputs (consumed by azd)
// ---------------------------------------------------------------------------

output AZURE_LOCATION string = location
output AZURE_TENANT_ID string = tenant().tenantId
output FUNCTION_APP_NAME string = functionApp.name
output FUNCTION_APP_HOSTNAME string = functionApp.properties.defaultHostName
output MCP_ENDPOINT_URL string = 'https://${functionApp.properties.defaultHostName}/mcp'
output KEY_VAULT_NAME string = keyVault.name

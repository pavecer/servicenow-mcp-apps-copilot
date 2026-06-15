# ESS ServiceNow Catalog Extension — Deployment Guide

A standalone Copilot Studio agent that adds ServiceNow Service Catalog ordering capability to any
Employee Self-Service (ESS) agent variant (IT, HR, or other). Deploy once, connect from multiple agents.

## Architecture

```
┌─────────────────────────────┐
│  ESS IT Agent (managed)     │ ──┐
└─────────────────────────────┘   │   connect as child agent
                                  ├──► ESS ServiceNow Catalog (this extension)
┌─────────────────────────────┐   │       │
│  ESS HR Agent (managed)     │ ──┘       └──► MCP ServiceNow Server (Azure Function)
└─────────────────────────────┘                     │
                                                    └──► ServiceNow Service Catalog API
```

## Files in This Extension

| File | Purpose |
|------|---------|
| `agent.mcs.yml` | Agent identity and AI instructions |
| `settings.mcs.yml` | Configuration (GenerativeActionsEnabled, schema name) |
| `connectionreferences.mcs.yml` | MCP connector reference (placeholder — filled after portal setup) |
| `actions/ESSServiceNowMCPServer.mcs.yml` | MCP action stub (placeholder — filled after portal setup) |
| `variables/ServiceNowSelectedItemSysId.mcs.yml` | Selected catalog item sys_id |
| `variables/ServiceNowSelectedItemName.mcs.yml` | Selected catalog item display name |
| `variables/ServiceNowFormJson.mcs.yml` | Order form schema (from get_catalog_item_form) |
| `variables/ServiceNowOrderValuesJson.mcs.yml` | Collected field values for submission |
| `variables/ServiceNowOrderRequestNumber.mcs.yml` | Confirmed order request number |
| `topics/ServiceNowCatalogConversationStart.mcs.yml` | Greeting + variable initialization |
| `topics/ServiceNowCatalogSearch.mcs.yml` | Search catalog + item selection |
| `topics/ServiceNowCatalogFormHandler.mcs.yml` | Get form + hybrid field collection |
| `topics/ServiceNowCatalogConfirmSubmit.mcs.yml` | Confirm + submit order |
| `topics/ServiceNowCatalogOnError.mcs.yml` | Error handling |

---

## Step-by-Step Deployment

### Step 1 — Prerequisites

- Power Platform environment with ESS IT or ESS HR already installed (managed)
- PAC CLI installed (`pac --version`)
- Copilot Studio VS Code extension installed (`ms-copilotstudio.vscode-copilotstudio`)
- Access to the Copilot Studio portal with admin/maker permissions
- The MCP ServiceNow server deployed and reachable (Azure Function URL)

### Step 2 — Create the New Agent in Copilot Studio Portal

1. Open [Copilot Studio](https://copilotstudio.microsoft.com)
2. Select the target environment
3. Click **Create** → **New agent**
4. Name it: **ESS ServiceNow Catalog**
5. Save (do not add topics/actions yet)

### Step 3 — Add the MCP Server Connection

Still in the Copilot Studio portal, for the new ESS ServiceNow Catalog agent:

1. Go to **Actions** in the left sidebar
2. Click **+ Add an action**
3. Search for the ServiceNow MCP server (it must be registered as an MCP connector in this environment)
4. If not available as a connector, register it first:
   - Go to Power Platform Admin Center → Connections → + New connection
   - Or use a custom connector referencing the MCP server endpoint
5. Configure the connection (provide URL + authentication)
6. Save the action

### Step 4 — Clone the Agent Locally

```powershell
# From the repo root
node <path>\manage-agent.bundle.js list-agents `
  --tenant-id <YOUR_TENANT_ID> `
  --environment-url https://<your-dataverse-org>.crm.dynamics.com

# Find the new agent ID, then clone it:
node <path>\manage-agent.bundle.js clone `
  --workspace copilot-studio\mcs-agents\ess-servicenow-catalog-live `
  --tenant-id <YOUR_TENANT_ID> `
  --environment-id <YOUR_POWER_PLATFORM_ENV_ID> `
  --environment-url https://<your-dataverse-org>.crm.dynamics.com `
  --agent-mgmt-url <regional powervamg URL from list-agents output> `
  --agent-id <NEW-AGENT-ID>
```

### Step 5 — Update Connection References

After cloning, the pulled `connectionreferences.mcs.yml` will contain the real connection reference.
Copy those values into this extension's `connectionreferences.mcs.yml` and `actions/ESSServiceNowMCPServer.mcs.yml`.

Search for `REPLACE_WITH_ACTUAL_GUID` in both files and replace with actual values.

### Step 6 — Copy and Push Extension Files

```powershell
# Copy extension topics, variables, actions into the live clone
$src = "copilot-studio\mcs-agents\ess-servicenow-catalog-extension\ESS ServiceNow Catalog"
$dst = "copilot-studio\mcs-agents\ess-servicenow-catalog-live\ESS ServiceNow Catalog"

Copy-Item "$src\topics\*" "$dst\topics\" -Force
Copy-Item "$src\variables\*" "$dst\variables\" -Force
# Do NOT overwrite connectionreferences.mcs.yml — it was updated in Step 5

# Push to environment
node <path>\manage-agent.bundle.js push `
  --workspace copilot-studio\mcs-agents\ess-servicenow-catalog-live `
  --tenant-id <YOUR_TENANT_ID> `
  --environment-id <YOUR_POWER_PLATFORM_ENV_ID> `
  --environment-url https://<your-dataverse-org>.crm.dynamics.com `
  --agent-mgmt-url <regional powervamg URL from list-agents output>
```

### Step 7 — Connect to ESS IT or ESS HR Agent

In Copilot Studio portal:

1. Open the **ESS IT** (or **ESS HR**) agent
2. Go to **Actions** → **+ Add an action** → **Add agent**
3. Select **ESS ServiceNow Catalog**
4. Save and publish

The ESS agent's generative orchestrator will automatically route catalog ordering requests to this child agent.

### Step 8 — Package as Power Platform Solution (Optional)

To make the extension a deployable named solution:

```powershell
# Create solution
pac solution create --name ESSServiceNowCatalog --publisher-name Contoso --publisher-prefix cnts

# Add the bot component (use the bot sys_id from pac copilot list)
pac solution add-reference --path . --projectPath .

# Export as unmanaged solution
pac solution export --path ESSServiceNowCatalog.zip --name ESSServiceNowCatalog --managed false

# Or export as managed (for production deployment)
pac solution export --path ESSServiceNowCatalog_managed.zip --name ESSServiceNowCatalog --managed true
```

---

## Redeploying to a Second ESS Agent (e.g., HR after IT)

The same extension YAML files work for any ESS variant.
Repeat Steps 2–7, but in Step 7 connect to the **ESS HR** agent instead.
The `ESS ServiceNow Catalog` agent is shared — it serves both ESS IT and ESS HR simultaneously.

## What Is NOT Modified by This Extension

- ✅ ESS IT managed solution — untouched
- ✅ ESS HR managed solution — untouched  
- ✅ All managed topics, variables, actions — untouched
- ✅ local.settings.json and MCP server source code — untouched

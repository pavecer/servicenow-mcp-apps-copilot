# Runbook 05: Copilot Studio consumer (E2, E3) - not executed (optional)

E2: add the gateway MCP endpoint as an MCP tool in a cloned sandbox agent
(API key auth). Expected from Track A: tools needing OBO return 401 errors.

E3: the Microsoft "ServiceNow" Power Platform connector is listed in M365
Agents > Tools (53 (local: `screenshots/53-m365-tools-not-discovered-after-27min.png`))
and reaches the instance without the gateway. Close it with a Power Platform
data policy that classifies the connector as Blocked for maker environments.

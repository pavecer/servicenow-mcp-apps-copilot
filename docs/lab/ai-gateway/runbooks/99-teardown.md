# Runbook 99: teardown

Script: [`scripts/lab/ai-gateway/teardown.ps1`](../../../../scripts/lab/ai-gateway/teardown.ps1).
Dry run by default; add `-Confirm` to act. It only touches `snowmcp-gwlab`.

```powershell
pwsh scripts/lab/ai-gateway/teardown.ps1 -TenantId <tenant-id> -SubscriptionId <subscription-id> # dry run
pwsh scripts/lab/ai-gateway/teardown.ps1 -TenantId <tenant-id> -SubscriptionId <subscription-id> -Confirm              # gateway, lab role, azd down --purge
pwsh scripts/lab/ai-gateway/teardown.ps1 -TenantId <tenant-id> -SubscriptionId <subscription-id> -Confirm -RemoveEntraApps -RemoveTenantConsentRole
```

Automated:

1. Tenant and subscription guard.
2. Delete AI Gateway `snowmcp-gwlab-aigw`, which removes API keys (`lab-harness`),
   MCP server, policies and gateway RBAC.
3. Remove the diagnostic custom role `Lab A365 AI Gateway Policy Operator (aigateways)`.
4. `azd down -e snowmcp-gwlab --purge --force`.
5. Optional: delete Entra apps `snowmcp-gwlab-{harness,server,snow-api}`.
6. Optional: remove the tenant-root "A365 Gateway Policy Operator" assignment
   (needs elevated access at the root management group).

Manual:

- M365 admin center > Agents > Settings > Gateways: disconnect Azure.
- ServiceNow <servicenow-instance>: delete the lab OIDC provider/entity from runbook 01,
  and optionally the lab incidents `<incident-1>` and `<incident-2>`.
- `npm run demo:cleanup` only if `demo:seed` was run (it was not in this lab).
- Rotate the ServiceNow admin password and confirm the `lab-harness` key is gone.
- No M365 lab agent, Copilot Studio agent or data policy was created.

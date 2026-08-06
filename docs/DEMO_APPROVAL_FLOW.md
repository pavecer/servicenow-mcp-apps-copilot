# Approval Demo Data and Prompts

This runbook creates a small, repeatable ServiceNow dataset for demonstrating
the order-detail approval actions in Microsoft 365 Copilot. It operates on the
ServiceNow instance configured in `local.settings.json` and never stores
credentials in the repository.

## Fixtures

The seed command creates or resets three marker-owned records:

| Key | Requested for | Approver | Purpose |
| --- | --- | --- | --- |
| `alex-action` | Alex Baker | Alex Baker | Lets the Alex account exercise Approve or Reject directly. |
| `admin-action` | admin | admin | Lets the admin account exercise Approve or Reject directly. |
| `alex-manager` | Alex Baker | admin | Shows the realistic employee-request/manager-approver relationship. |

The account-local fixtures intentionally use self-approval so both test
accounts can demonstrate the action without changing production role or ACL
design. The `alex-manager` fixture is the realistic manager narrative.

Each fixture consists of:

- one open `sc_request`
- one related `sc_req_item` using an active catalog item
- one `sysapproval_approver` row in `requested` state

Records contain a stable marker such as
`[MCP_APPS_DEMO:approval:alex-action]`. Rerunning the seed resets existing
fixtures to open/pending instead of creating duplicates.

## Prerequisites

1. Wake the ServiceNow Personal Developer Instance. A hibernating instance
   returns HTTP 502 and the command exits without changing data.
2. Confirm `local.settings.json` points to the intended development instance.
3. Ensure active ServiceNow users exist for `Alex Baker` and `admin` and their
   email addresses match the corresponding Entra sign-in identities used by
   OBO.
4. Sign in to Azure CLI with an Entra account that maps to a ServiceNow admin
   user. `demo:seed` and `demo:cleanup` acquire a delegated ServiceNow token via
   `ENTRA_OBO_DOWNSTREAM_SCOPE`; no ServiceNow admin password is stored.
5. Keep `ENTRA_OBO_ENABLED=true` and `ENTRA_OBO_DOWNSTREAM_SCOPE` in
   `local.settings.json` or the active azd environment. `demo:verify` remains
   read-only and uses the standard configured ServiceNow credentials.

Do not run the seed against production.

## Create or Reset

```bash
npm run demo:seed
```

The JSON output includes user mappings, request numbers/sys_ids, approval
sys_ids, the selected catalog item, and suggested prompts. Keep the output for
the manager-by-sys_id prompt.

## Verify

```bash
npm run demo:verify
```

Verification is read-only. Each fixture should report:

- one request in an open state
- at least one requested item
- one approval with state `requested` or `Requested`

## Demo in Microsoft 365 Copilot

Start a new chat with **ServiceNow Assistant** after selecting the appropriate
test account.

### Alex Baker

```text
Show my recent ServiceNow orders and open the demo laptop approval.
```

Open `Demo: Developer laptop approval for Alex Baker`. The order-detail widget
shows the pending approval and its Approve/Reject controls. Reject requires a
reason; Approve accepts an optional note.

### Admin

```text
Show my recent ServiceNow orders and open the demo executive laptop approval.
```

Open `Demo: Executive laptop approval for admin`, then exercise Approve or
Reject.

### Manager Narrative

Use the `alex-manager` request sys_id printed by `npm run demo:seed`:

```text
Open the ServiceNow order with sys_id <alex-manager request sysId> and show its pending approval.
```

This record has Alex Baker as the requester and admin as the approver. The
current tool surface opens an order by sys_id; a manager-inbox/list tool is not
yet part of this phase.

## Reset or Remove

After an approval has been decided, reset all fixtures to pending by rerunning:

```bash
npm run demo:seed
```

Remove only the marker-owned fixtures with:

```bash
npm run demo:cleanup
```

Cleanup deletes approvals first, then requested items, then requests. It does
not delete users, catalog items, or unrelated ServiceNow records.

## Troubleshooting

- **HTTP 502/503:** Wake the ServiceNow PDI and retry.
- **Alex Baker not found:** Confirm the active `sys_user` record is named Alex
  Baker and has the Entra account email.
- **403 on seed:** Confirm `az account show` is the mapped Entra admin account
   and that the ServiceNow inbound OIDC trust accepts the configured downstream
   scope.
- **Missing OBO scope:** Set `ENTRA_OBO_DOWNSTREAM_SCOPE` in
   `local.settings.json` or with `azd env set`.
- **Action fails in Copilot:** Verify the signed-in Entra identity maps to the
  expected ServiceNow `sys_user` and that the effective OBO user can update its
  assigned approval row.

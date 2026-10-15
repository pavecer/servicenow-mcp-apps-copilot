# Runbook 07: observability and Defender hunting (F1, F2) - not executed

F1, backend side (available now):

```kusto
traces
| where message has 'lab_request_diagnostics'
| project timestamp, message
| order by timestamp desc
```

Run with `az monitor app-insights query --app appi-<token> -g rg-snowmcp-gwlab`.
The gateway denial carries a `correlationId` in `_meta`; whether it reaches the
backend was not checked (blocked calls never reach it).

F2: Defender advanced hunting `CloudAppEvents | where ActionType == 'ExecuteToolByGateway'`
requires Defender for Cloud Apps / Agent 365 licensing and M365 discovery (blocked, see runbook 03).

# Phase 1 Validation: IT + HR + Knowledge Scope

This note validates the project plan against ServiceNow product capabilities in
HR Service Delivery (HRSD) and Knowledge management, then records local trace
results for the current development instance.

## Objective

Phase 1 focuses on a safe delivery baseline before adding new tools/widgets:

1. Readiness preflight for environment, auth, and ServiceNow surface checks.
2. Admin runbook hardening for tenant + ServiceNow setup and diagnostics.
3. Scope alignment to Microsoft 365 Copilot MCP Apps only.

## ServiceNow capability alignment

Based on ServiceNow public product pages:

- HRSD supports employee request handling, workflow routing, approvals, and
  lifecycle automation across hire-to-retire scenarios.
- Knowledge management supports article search, authoring workflows, quality
  optimization, feedback loops, ownership, analytics, and category structures.

These capabilities are compatible with this repository's target architecture:
MCP tools + rich UI widgets in Microsoft 365 Copilot.

## Local trace results (current dev instance)

Validated with direct API probes using current local credentials:

- `kb_knowledge`: HTTP 200 (reachable)
- `kb_category`: HTTP 200 (reachable)
- `sn_hr_core_case`: HTTP 400 `Invalid table sn_hr_core_case`
- `sn_hr_core_profile`: HTTP 400 `Invalid table sn_hr_core_profile`

Interpretation:

- Knowledge tables are reachable. The current configured integration identity
  returns zero visible article/category rows, while the demo admin UI contains
  demo content. This is a visibility distinction, not proof of missing data.
- Knowledge release remains gated on dedicated Knowledge API validation and an
  Alex/OBO check proving employee-visible articles and user criteria.
- HR scenarios are blocked in the current instance until HRSD core tables are
  enabled/provisioned and ACLs are granted for the integration identity.

## Phase 1 deliverables implemented

1. New readiness script: `scripts/dev/preflight-readiness.mjs`
2. New npm command: `npm run preflight:readiness`
3. README updates to include Phase 1 preflight execution and scope
4. Scope cleanup removing VS Code extension direction from roadmap language

## Run the preflight

```bash
npm run preflight:readiness
```

The command returns a JSON summary plus a human-readable status section for IT,
KB, and HR readiness.

## Next operational action for HR enablement

In the target ServiceNow instance intended for HR scenarios:

1. Enable/provision HRSD core data model (tables such as `sn_hr_core_case`).
2. Grant least-privilege API/table access needed for employee and manager HR
   case scenarios.
3. Re-run `npm run preflight:readiness` and confirm HR readiness is PASS.

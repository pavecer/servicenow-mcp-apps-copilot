# ServiceNow MCP Apps repository instructions

Read and follow the root [AGENTS.md](../AGENTS.md) before changing code. It is
the source of truth for repository structure, tool/widget lockstep invariants,
build commands, secrets, and release boundaries.

## Agentic cloud development

- Treat GitHub Codespaces as the primary development workstation. Follow
  [docs/CODESPACES.md](../docs/CODESPACES.md) and load the `cloud-development`
  skill for environment setup, end-to-end changes, PR preparation, validation,
  or release-candidate work.
- Work autonomously through discovery, implementation, focused tests, full
  build/tests, exact-commit test deployment, live validation, evidence capture,
  and draft PR creation/update.
- Use the project specialists when their domain applies:
  - `Cloud Development` owns end-to-end orchestration and PR evidence.
  - `mcp-apps-ui` owns widget UX and MCP Apps protocol wiring.
  - `copilot-ready-release` owns deployment through M365 prompt-test readiness.
  - `deploy-mcp-server` owns Azure Functions provisioning/deployment repair.
- Do not ask for routine confirmations while operating inside the agreed test
  environments. Never expose, print, commit, or copy secrets into chat.

## One human approval gate

The only development approval gate occurs after the exact candidate has passed
automated validation and human click-through in both test environments:

1. ServiceNow test instance: validate the expected records, caller attribution,
   ACL behavior, and cleanup for the changed scenario.
2. Microsoft 365 test tenant: validate the MCP Apps agent conversation and
   widget interaction against the deployed exact commit.

Agents prepare the prompts, deploy the candidate, collect non-secret evidence,
and update the PR. The human records `PASS` and explicitly authorizes merge. If
an independent reviewer exists, use one approving GitHub review as that record;
in a sole-maintainer repository, use the PR evidence plus an explicit merge
instruction. Any push after approval invalidates it and requires the same final
gate again.

Tenant admin consent, organizational catalog approval, production deployment,
and public communications are privileged operational actions outside this
single development gate. Do not perform them as an automatic consequence of PR
approval or merge.

---
description: Validate, deploy, and verify MCP server readiness up to M365 Copilot prompt testing (no post-chat E2E assertions).
tools: ["changes", "runCommands", "runTasks", "search", "problems"]
model: Claude Sonnet 4
---

# Copilot-Ready Release

Use this mode when the goal is automation only up to the point where a human can open Microsoft 365 Copilot and test prompts.

## Goal

Run the repo automation that performs:

1. Build
2. Tests
3. Azure infrastructure/configuration provisioning
4. Policy-aware Azure Functions deployment
5. Live MCP tool presence validation
6. Existing M365 agent package validation and update

Stop there and return a concise "ready for prompt test" outcome.

Before running, ensure `appPackage/manifest.json` has a new patch version when
tool names, schemas, annotations, or widget bindings changed.

Use `npm run release:auto -- --environment <env>` for developer provisioning.
Use `npm run release:publish -- --environment <env>` only for a version-bumped
organizational-catalog submission; it requires admin approval afterward.

## Command

```bash
npm run release:auto -- --environment snowmcpwidg-dev
```

## Expected output

- Build succeeded
- Tests passed
- Deploy succeeded
- Live tools validated, including Step 1 approval tools
- Existing tenant app updated without re-registering OAuth
- Temporary policy exemption removed and deployment storage secured
- Final endpoint URL to use in tenant testing

## Non-goals

- Do not run conversational M365 Copilot tests automatically
- Do not attempt browser automation in tenant chat
- Do not create a new OAuth connection during an existing app update

# AGENTS.md

Machine-readable guide for AI coding agents working in this repository. Humans
should read [README.md](README.md); this file is the fast path for agents.

## What this is

A stateless **Model Context Protocol (MCP) server** for the ServiceNow Service
Catalog, hosted on **Azure Functions** (Node.js 20, TypeScript). It delivers
catalog ordering (search → form → order → track, plus a cart) to **Microsoft 365
Copilot / Cowork** via **MCP Apps (SEP-1865)** interactive HTML widgets.

## Resume here first

- For tracked continuity and the latest verified operational state, read
  [docs/REPO_STATE.md](docs/REPO_STATE.md) before broader exploration.
- For per-user attribution and OBO specifics, read
  [docs/AUTH_ENTRA_OBO.md](docs/AUTH_ENTRA_OBO.md).
- For dev provisioning vs organizational publication, Agent 365 tool
  registration, Entra Agent ID, and admin metadata, read
  [docs/AGENT_365_PUBLISHING.md](docs/AGENT_365_PUBLISHING.md).

## Build / test / run

```bash
npm install            # install deps
npm run cloud:check    # verify Codespaces tools, identities, Azure access, and endpoint
npm run build          # build-widgets.mjs (regenerates generated/) THEN tsc
npm test               # vitest — full suite (exact-count manifest/widget tests)
npm run release:auto -- --environment snowmcpwidg-dev # deploy through M365 prompt-test readiness
npm run release:publish -- --environment snowmcpwidg-dev # submit catalog package for admin approval
npm run release:check   # verify canonical version/changelog consistency
npm run release:plan -- --type minor # preview next version + pending notes
npm run demo:seed       # create/reset Alex + admin approval demo records
npm run demo:verify     # inspect demo records without mutation
npm run demo:cleanup    # remove only marker-owned demo records
npx vitest run <file>  # run a single test file
npm start              # run the Functions host locally (func start)
```

- **Always run `npm run build` before `npm test`** after editing widget HTML:
  `src/ui/widgets/generated/` is gitignored and regenerated from
  `src/ui/widgets/src/*.html` by `scripts/dev/build-widgets.mjs`.
- Node 20+. Tests run in `@azure/functions` test mode (no live Azure/ServiceNow).

## Repository structure

```
src/
  app.ts                  Functions app entrypoint / route wiring
  config.ts               Env-driven config
  server.ts               MCP server + tool registration
  functions/              HTTP handlers (mcp, health, oidc, oauth/register)
  services/               ServiceNow client (catalog, orders, cart) + token mgr
  tools/                  MCP tools (one file per tool) + index.ts registry
  ui/
    widgets.ts            ui:// widget registry + registerWidgetResources()
    widgets/src/*.html    Self-contained widget HTML (inline CSS+JS) — SOURCE
    widgets/bridge/       host-bridge.ts (OpenAI + MCP Apps dual-mode bridge)
    widgets/generated/    Base64 widget modules (GITIGNORED, build output)
  utils/                  logger (secret redaction), Entra auth, prefill, etc.
  types/                  shared TypeScript types
test/                     vitest suites (manifest/widget/gating assert exact counts)
infra/                    Bicep (main.bicep) + parameters
m365-agent/               Declarative-agent package (manifest, ai-plugin, tools)
scripts/                  deploy/setup PowerShell + dev/ helper scripts
docs/                     Deep-dive docs (auth, MCP Apps, cost, container deploy)
.github/
  copilot-instructions.md      Always-on repository agent and single-gate policy
  agents/*.{agent,chatmode}.md Custom agents (cloud orchestration, release, deploy, UI)
  skills/                      Cloud development and MCP Apps UI workflows
```

- `release:auto` stops at the human test boundary: build, tests, policy-aware
  Azure deployment, live tool validation, and existing M365 agent package
  update. It does not automate a Copilot conversation.
- `release:publish` additionally submits a version-bumped package to the
  organizational catalog. Submission is not publication: Teams Admin Center
  approval is still required. Use `--agent-environment prod` for a separately
  configured production package. Never confuse the MCP OAuth app ID with an Entra
  Agent ID, and check for an existing Agent 365 MCP tool registration before
  submitting another one.
- Public releases follow [docs/RELEASE_PLAN.md](docs/RELEASE_PLAN.md). Every PR
  selects one release impact and human-validation state; user-facing behavior
  is prepared in a draft PR and receives one final human approval after
  Microsoft 365 click-through and ServiceNow test-environment verification.

## Agent portfolio

- **Cloud Development** plus `.github/skills/cloud-development/`: primary
  Codespaces workflow from implementation through exact-commit test deployment,
  two-environment evidence, and approval-ready draft PR.
- **mcp-apps-ui** plus `.github/skills/mcp-apps-ui/`: widget UX, host bridge,
  protocol metadata, visual states, and widget/tool lockstep.
- **copilot-ready-release**: build, tests, policy-aware Azure deployment, live
  tools, and existing M365 developer package update.
- **deploy-mcp-server**: Azure Functions provisioning and deployment repair.
- **deploy-mcp-container**: optional Container Apps deployment path only.

GitHub's hosted Copilot coding agent uses
`.github/workflows/copilot-setup-steps.yml` for Node 20, locked dependencies,
build output, and contract tests. It has no tenant secrets. Live ServiceNow,
Azure test deployment, and M365 work run from the Codespace agent after
`npm run cloud:check`.

## Critical invariants (violating these breaks cold start or tests)

1. **MCP Apps is the only surface.** Every widget-backed tool emits compact
   `structuredContent` plus a concise, neutral `content` summary, and widget
   resources + `_meta.ui` are always registered. Tool `content` must never carry
   verbose JSON blobs or Adaptive Card payloads (they make Copilot render a text
   fallback instead of mounting the widget).
2. **Tool/widget lockstep.** Adding or renaming a tool/widget requires updating
   ALL of these together or import-time guards / tests throw:
   - `src/tools/index.ts` tool-name sets + minimal tool definitions (drift guard)
   - the tool's Zod schema (must match the minimal manifest: same property names +
     required set; no `oneOf`/`anyOf`/`format`/negative bounds)
   - `registerTools()` registration
   - `src/ui/widgets.ts` `WIDGETS` registry (for widgets)
   - `test/toolManifest.test.ts` (exact tool-name list + count)
   - `test/widgetResources.test.ts` (exact `ui://` resource count)
   - `m365-agent/appPackage/ai-plugin.json` stays in dynamic discovery mode
     (`functions: []`, `run_for_functions: ["*"]`)
   - `scripts/agent365-mcp-registration.template.json` (exact tool inventory)
3. **No secrets in code.** Secrets come from env / Key Vault. `src/utils/logger.ts`
   redacts sensitive keys. Never commit `.env` or `local.settings.json`.

## MCP Apps widget conventions

- Widgets are **self-contained HTML** (inline CSS + vanilla JS IIFE); the host
  mounts them in a sandboxed iframe. Keep the `<!-- MCP_HOST_BRIDGE -->` marker.
- Consume only the `window.mcpHost` facade (`onData`, `getData`, `markRendered`,
  `callTool`, `sendFollowUp`, `openExternal`, `applyTheme`).
- Follow the **MCP Apps UI/UX skill** at
  [.github/skills/mcp-apps-ui/SKILL.md](.github/skills/mcp-apps-ui/SKILL.md) and
  use the **mcp-apps-ui** agent for widget work. Key UX rules: inline =
  glanceable, ≤2 actions; explicit loading/disabled/success/error-with-recovery
  states; Fluent 2 styling (24px card padding); light + dark themes; don't
  duplicate model text or recreate Copilot chat features.

## Conventions

- TypeScript strict; one MCP tool per file under `src/tools/`.
- Prefer editing existing files; don't add docs/comments to untouched code.
- After changes: `npm run build && npm test` must be green before committing.

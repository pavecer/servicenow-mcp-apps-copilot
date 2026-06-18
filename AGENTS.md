# AGENTS.md

Machine-readable guide for AI coding agents working in this repository. Humans
should read [README.md](README.md); this file is the fast path for agents.

## What this is

A stateless **Model Context Protocol (MCP) server** for the ServiceNow Service
Catalog, hosted on **Azure Functions** (Node.js 20, TypeScript). It delivers
catalog ordering (search → form → order → track, plus a cart) to **Microsoft 365
Copilot / Cowork** via **MCP Apps (SEP-1865)** interactive HTML widgets.

## Build / test / run

```bash
npm install            # install deps
npm run build          # build-widgets.mjs (regenerates generated/) THEN tsc
npm test               # vitest — full suite (exact-count manifest/widget tests)
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
  config.ts               Env-driven config (flags incl. MCP_APPS_ENABLED)
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
  agents/*.chatmode.md    Custom VS Code agents (deploy, mcp-apps-ui)
  skills/mcp-apps-ui/     Skill: MCP Apps UI/UX guidelines + repo conventions
```

## Critical invariants (violating these breaks cold start or tests)

1. **Feature flag gate.** `MCP_APPS_ENABLED` OFF must keep the manifest and tool
   responses **byte-identical** to the legacy Adaptive Card surface.
   `structuredContent` and `_meta.ui` are emitted **only** when
   `config.mcpApps.enabled`. Cart tools + widgets register only when the flag is on.
2. **Tool/widget lockstep.** Adding or renaming a tool/widget requires updating
   ALL of these together or import-time guards / tests throw:
   - `src/tools/index.ts` tool-name sets + minimal tool definitions (drift guard)
   - the tool's Zod schema (must match the minimal manifest: same property names +
     required set; no `oneOf`/`anyOf`/`format`/negative bounds)
   - `registerTools()` registration
   - `src/ui/widgets.ts` `WIDGETS` registry (for widgets)
   - `test/toolManifest.test.ts` (exact tool-name list + count)
   - `test/widgetResources.test.ts` (exact `ui://` resource count)
   - `m365-agent/appPackage/mcp-tools-1.json` + `ai-plugin.json`
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

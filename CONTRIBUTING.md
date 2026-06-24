# Contributing

Thanks for your interest in improving this project! It is a stateless
ServiceNow Service Catalog **MCP server** hosted on Azure Functions that
delivers MCP Apps (SEP-1865) widgets to Microsoft 365 Copilot.

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** — open an issue with the
  [bug report template](.github/ISSUE_TEMPLATE/bug_report.md).
- **Request a feature** — open an issue with the
  [feature request template](.github/ISSUE_TEMPLATE/feature_request.md).
- **Send a pull request** — bug fixes, docs, tests, or new catalog tools.

## Development setup

Prerequisites: **Node.js 20+**. (Azure CLI / azd and a ServiceNow instance are
only needed for an end-to-end deploy — not for building and unit-testing.)

```bash
git clone https://github.com/pavecer/servicenow-mcp-apps-copilot.git
cd servicenow-mcp-apps-copilot
npm install
npm run build   # regenerates src/ui/widgets/generated/, then runs tsc
npm test        # vitest — full suite
```

To run the Functions host locally:

```bash
cp local.settings.sample.json local.settings.json   # fill in ServiceNow creds
npm run start:dev                                    # http://localhost:7071/mcp
```

See [README.md](README.md) for the full local-development and deployment guide,
and [AGENTS.md](AGENTS.md) for the fast-path build/test commands.

## Repository invariants (read before changing tools or widgets)

This repo enforces several invariants via import-time guards and exact-count
tests. Violating them breaks the build or the test suite. The authoritative list
is in [AGENTS.md](AGENTS.md); the highlights:

1. **MCP Apps is the only surface.** Every widget-backed tool emits compact
   `structuredContent` plus a concise, neutral `content` summary, and widget
   resources / `_meta.ui` are always registered. Tool `content` must never carry
   verbose JSON or Adaptive Card payloads.
2. **Tool/widget lockstep.** Adding or renaming a tool or widget requires
   updating *all* of: the tool file + Zod schema, `src/tools/index.ts`,
   `registerTools()`, `src/ui/widgets.ts` (for widgets), the exact-count tests
   under `test/`, and the `m365-agent/appPackage/` manifests — together.
3. **No secrets in code.** Secrets come from env / Key Vault. Never commit
   `.env`, `local.settings.json`, or `*.har` files. See [SECURITY.md](SECURITY.md).

## Pull request checklist

Before opening a PR, make sure:

- [ ] `npm run build && npm test` is green.
- [ ] New/changed behavior is covered by tests where practical.
- [ ] Docs and the environment-variable table in [README.md](README.md) are
      updated when configuration or behavior changes.
- [ ] No secrets, tokens, PII, or tenant-specific resource names were added to
      code, docs, logs, or fixtures.
- [ ] A line was added to [CHANGELOG.md](CHANGELOG.md) under *Unreleased*.

## Coding conventions

- TypeScript strict mode; one MCP tool per file under `src/tools/`.
- Route operational logs through `src/utils/logger.ts` (it redacts secrets).
- Prefer editing existing files; don't add comments/docs to untouched code.
- Keep widget HTML self-contained (inline CSS + vanilla JS) and follow the
  [MCP Apps UI skill](.github/skills/mcp-apps-ui/SKILL.md).

## Commit messages

Conventional-commit style is appreciated but not required, e.g.
`feat(cart): …`, `fix(order-detail): …`, `docs: …`, `test: …`.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).

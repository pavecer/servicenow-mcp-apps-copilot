# Contributing to servicenow-mcp-apps-copilot

Thank you for your interest in contributing! This document describes how to set up a development environment, run tests, and submit changes.

---

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.

---

## Getting Started

### Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | ≥ 20 |
| npm | ≥ 10 (bundled with Node 20) |
| Azure Functions Core Tools | v4 (for `npm start`) |
| PowerShell | ≥ 7 (for deploy/setup scripts) |

### Fork & clone

```bash
git clone https://github.com/<your-fork>/servicenow-mcp-apps-copilot.git
cd servicenow-mcp-apps-copilot
npm install
```

### Local development config

Copy the sample settings file and fill in your values:

```bash
cp local.settings.sample.json local.settings.json
# Edit local.settings.json — it is gitignored and will never be committed
```

### Build & test

```bash
npm run build   # compile TypeScript + regenerate widget modules
npm test        # run the full Vitest suite
```

> **Always run `npm run build` before `npm test`** when you have edited any widget HTML under `src/ui/widgets/src/`.

---

## Making Changes

### Branch naming

Create a feature branch from `main`:

```bash
git checkout -b feat/my-feature
# or
git checkout -b fix/my-bugfix
```

### Commit messages

Use the [Conventional Commits](https://www.conventionalcommits.org/) format:

```
feat: add cart item sorting
fix: correct OBO token cache key collision
docs: update cost estimation for 2026 pricing
chore: bump @modelcontextprotocol/sdk to 1.30.0
```

### Critical invariants

Before opening a PR, verify these invariants hold (the tests assert them):

1. **Feature flag gate** — `MCP_APPS_ENABLED=false` (default) must not alter existing tool/resource responses. Cart tools are only registered when the flag is on.
2. **Tool/widget lockstep** — adding or renaming a tool or widget requires updating *all* of: `src/tools/index.ts`, the tool's Zod schema, `registerTools()`, `src/ui/widgets.ts` (for widgets), `test/toolManifest.test.ts`, `test/widgetResources.test.ts`, and `m365-agent/appPackage/mcp-tools-1.json` + `ai-plugin.json`.
3. **No secrets in code** — all secrets come from env / Key Vault. `src/utils/logger.ts` must redact sensitive keys. Never commit `.env` or `local.settings.json`.

Full invariant details are in [`AGENTS.md`](AGENTS.md).

---

## Pull Requests

1. Open a PR against `main`.
2. Fill in the PR description with:
   - A summary of what changed and why.
   - Any environment variables added or changed.
   - Test results (`npm test` green).
3. One approval from a maintainer is required before merge.

### PR checklist

- [ ] `npm run build && npm test` passes locally
- [ ] No secrets, tokens, or real endpoint URLs committed
- [ ] `local.settings.json` is untouched
- [ ] New env variables are documented in `local.settings.sample.json` and the README
- [ ] Relevant docs updated if behaviour changed

---

## Reporting Bugs

Open a [GitHub issue](https://github.com/pavecer/servicenow-mcp-apps-copilot/issues/new) and include:

- Node.js version and platform
- Minimal reproduction steps
- Relevant log output (redact any tokens/secrets before posting)

For security vulnerabilities, follow the process in [SECURITY.md](SECURITY.md) — **do not open a public issue**.

---

## Releasing

Maintainer-only. Bump `version` in `package.json`, update `CHANGELOG.md`, tag with `vX.Y.Z`, and push.

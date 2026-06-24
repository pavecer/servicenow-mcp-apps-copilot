# Engineering Guardrails

This document outlines the non-negotiable rules for developing, reviewing, and deploying changes to this repository. Every PR, feature, and fix must adhere to these guardrails.

## Overview

These guardrails ensure:
- **Security**: No secrets, tokens, or PII leak into tracked files or logs
- **Maintainability**: Code is consistent, well-documented, and follows MCP/OAuth best practices
- **Reliability**: Tests pass, invariants are enforced, and breaking changes are caught
- **Scalability**: The codebase remains readable as new tools, widgets, and flows are added

---

## Local Development Files

**Rule:** Treat `local.settings.json` as developer-local configuration; never commit it.

### What to do:
- ✅ Create and edit `local.settings.json` for local testing
- ✅ Add new sample keys to `local.settings.sample.json` so others know what to configure
- ✅ `.gitignore` includes `local.settings.json` — verify it's listed

### What NOT to do:
- ❌ Commit `local.settings.json` with real credentials
- ❌ Reformat, overwrite, or template `local.settings.json` in tooling unless the user explicitly asks
- ❌ Store developer secrets anywhere except `.gitignore`-excluded files

### Rationale:
Each developer has their own ServiceNow instance, Entra tenant, and credentials. Sharing one `local.settings.json` would expose secrets and break other devs' workflows.

---

## Logging and Diagnostics

**Rule:** Never log secrets, tokens, passwords, or caller PII by default.

### What to do:
- ✅ Route all logs through `src/utils/logger.ts` (provides automatic secret redaction)
- ✅ Log operational events: `logger.info("Order placed", { itemId, workflowStep })`
- ✅ Log errors with context: `logger.error("ServiceNow request failed", { status, endpoint })`
- ✅ Use opt-in diagnostics for sensitive info: gate behind `SERVICENOW_REQUESTED_FOR_DIAGNOSTICS_INCLUDE_PII`
- ✅ Sanitize error messages before returning to callers

### What NOT to do:
- ❌ Log bearer tokens, session IDs, API keys, passwords, function keys
- ❌ Log raw HTTP headers (they contain Authorization)
- ❌ Log full upstream payloads — sanitize or extract safe fields only
- ❌ Include caller UPN/email in logs unless `LOG_INCLUDE_CALLER_IDENTITY=true` (opt-in)
- ❌ Return full error messages from ServiceNow — filter for user-facing strings only

### Example:

**Bad:**
```typescript
logger.info(`ServiceNow request: ${JSON.stringify(headers)}`);  // Includes Authorization header!
```

**Good:**
```typescript
logger.info("Calling ServiceNow API", { endpoint, method });  // Safe to log
```

---

## Identity and Access

**Rule:** Prefer least privilege for both ServiceNow and Entra configuration.

### ServiceNow Permissions:
- ✅ Integration user should have `catalog` role + read on `sys_user`, read+write on `sc_request`/`sc_req_item`
- ✅ Narrow ACLs — don't grant `admin` or `sn_ws_svc.integrations` unless required
- ✅ Document why each permission is needed (in `SERVICENOW_SETUP.md` or PR description)

### Entra Permissions:
- ✅ App registration needs only `/.default` scope for OBO scenarios
- ✅ Scope approvals to `access_as_user` (not `User.Read` or `Directory.Read.All`)
- ✅ For multi-tenant: use `ENTRA_TRUSTED_TENANT_IDS` to whitelist, not `ENTRA_ALLOW_ANY_TENANT`

### Per-User Enforcement:
- ✅ Prefer delegated/OBO token exchange when enterprise policy requires per-user ACLs
- ✅ Document the OBO setup: see [AUTH_ENTRA_OBO_OKTA.md](AUTH_ENTRA_OBO_OKTA.md)
- ❌ Don't add Microsoft Graph permissions unless critical

---

## API and OAuth Surface

**Rule:** Keep OAuth secure and protocol-compatible.

### CORS:
- ✅ Use explicit allowlists: `CORS_ALLOWED_ORIGINS=https://example.com,https://copilot.microsoft.com`
- ✅ Document why each origin is needed
- ❌ Never use `CORS_ALLOWED_ORIGINS=*` (wildcard) for enterprise-exposed APIs

### Dynamic Client Registration (DCR):
- ✅ Require `ENTRA_DCR_REGISTRATION_TOKEN` (gate `/oauth/register` behind a secret)
- ✅ Only set `ENTRA_DCR_ALLOW_UNAUTHENTICATED=true` if intentional and reviewed
- ✅ Document the security decision in PR description

### MCP Protocol:
- ✅ When adding tools or changing tool schemas, verify compatibility with MCP spec
- ✅ Don't add `oneOf` / `anyOf` in Zod schemas without coordinating with MCP SDK
- ✅ Keep tool results backward-compatible (new fields OK, removing fields is breaking)

---

## Widget Development (SEP-1865)

**Rule:** Widgets must be self-contained, accessible, and follow Fluent 2 design.

### HTML & Build:
- ✅ Widgets are in `src/ui/widgets/src/*.html` (self-contained: inline CSS + JS)
- ✅ After editing widget HTML, run `npm run build` to regenerate `src/ui/widgets/generated/`
- ✅ Test locally: `npm run start:dev` then check the MCP endpoint returns the widget
- ✅ Verify the widget renders in Microsoft 365 Copilot (the sideloaded agent)

### JavaScript:
- ✅ Consume only `window.mcpHost` facade: `onData`, `getData`, `callTool`, `sendFollowUp`, `openExternal`, `applyTheme`
- ✅ Handle loading, error, and success states explicitly
- ✅ Support light + dark themes via CSS variables
- ✅ Don't duplicate model text or recreate Copilot features
- ✅ Keep widgets ≤2 actions for inline mode (glanceable)

### CSP & Security:
- ✅ Keep `<!-- MCP_HOST_BRIDGE -->` marker in place (host uses it to inject bridge)
- ✅ Don't fetch external resources (everything inline)
- ✅ Use Content Security Policy–safe practices (no eval, no unsafe inline without host bridge)

**See:** [MCP Apps UI Skill](./.github/skills/mcp-apps-ui/SKILL.md)

---

## Documentation Expectations

**Rule:** Update docs whenever behavior, permissions, or config changes.

### Required:
- ✅ **Environment variables**: Add to [docs/CONFIG_REFERENCE.md](CONFIG_REFERENCE.md) if creating new ones
- ✅ **Deployment behavior**: Update [README.md](../README.md) if setup steps change
- ✅ **Security**: Update [SECURITY.md](../SECURITY.md) if auth, secrets, or ACLs change
- ✅ **Permissions**: Document why integration user needs each role/permission
- ✅ **Code comments**: Add function-level comments for non-obvious logic (especially auth, logging, transport)

### Avoid:
- ❌ Outdated examples (test them before committing)
- ❌ Links to files that have moved (use exact paths)
- ❌ Placeholder values without explanation

---

## Testing and Validation

**Rule:** All changes must pass `npm test` and pass a code review.

### Pre-Commit Checklist:
```bash
npm run build  # Regenerate code (widgets → TS)
npm test       # All tests pass
git diff HEAD  # Review what you're committing
```

### Test Coverage:
- ✅ Add a test for every new tool or widget
- ✅ Add a test for every env-var or config change
- ✅ Test error paths (invalid input, network failure, ServiceNow 500)
- ✅ For widgets: verify they render in light + dark modes

### Existing Tests:
- ✅ Don't remove or weaken existing tests
- ✅ If tests fail after your change, fix the code (not the test)
- ✅ Exact counts are enforced: `test/toolManifest.test.ts` and `test/widgetResources.test.ts`

---

## Code Review Standard

**Before marking a PR as ready, verify:**

1. **Security**: No secrets, tokens, passwords, or PII in tracked files or logs ✅
2. **Configuration**: New env vars are in `local.settings.sample.json` and documented ✅
3. **Permissions**: New ServiceNow/Entra permissions are justified and documented ✅
4. **Tests**: All 215 tests pass; no test count changed unexpectedly ✅
5. **Docs**: README/docs updated if behavior changed ✅
6. **Backward Compatibility**: Old MCP clients still work (no breaking tool/schema changes) ✅

---

## Repo Invariants (Enforced by Tests)

These are checked by the test suite and will fail if violated:

| Invariant | Test | Reason |
|-----------|------|--------|
| Tool count exact (20 MCP tools) | `test/toolManifest.test.ts` | Prevents accidental tool registration |
| Widget count exact (8 SEP-1865 widgets) | `test/widgetResources.test.ts` | Ensures all widgets are tracked |
| MCP Apps surface wiring | `test/mcpAppsSurface.test.ts` | Widget registry, `_meta.ui` binding, and resource registration stay wired |
| Tool schema matches Zod | `test/toolManifest.test.ts` | Prevents invalid tool definitions |
| No secrets in code | (manual review) | Checked during PR review |

If you add a tool or widget, update the count in the test file.

---

## When in Doubt

1. **Check existing code** — find a similar tool/widget and follow its pattern
2. **Ask in PR description** — describe the tradeoff and ask reviewers for feedback
3. **See CONTRIBUTING.md** — contributor guide with examples
4. **Check docs/** — architecture and auth docs explain design decisions

---

## Questions?

Open an issue or discussion in the repo. We're here to help! 🚀

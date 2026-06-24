<!-- Thanks for contributing! Please fill out the checklist below. -->

## Summary

What does this PR change and why?

Closes #<!-- issue number, if any -->

## Type of change

- [ ] Bug fix
- [ ] New feature (new tool / widget / endpoint)
- [ ] Documentation
- [ ] Refactor / chore
- [ ] Tests

## Checklist

- [ ] `npm run build && npm test` passes locally.
- [ ] Tests added or updated where practical.
- [ ] If a tool/widget was added or renamed, **all** lockstep locations were
      updated together (tool file + Zod schema, `src/tools/index.ts`,
      `registerTools()`, `src/ui/widgets.ts`, exact-count tests, and
      `m365-agent/appPackage/` manifests). See [AGENTS.md](AGENTS.md).
- [ ] MCP Apps surface preserved: widget-backed tools emit compact
      `structuredContent` plus a concise, neutral `content` summary (no verbose
      JSON or Adaptive Card payloads in `content`).
- [ ] Docs / environment-variable table updated for any config or behavior change.
- [ ] No secrets, tokens, PII, or tenant-specific resource names were added.
- [ ] Added an entry to [CHANGELOG.md](CHANGELOG.md) under *Unreleased*.

## Notes for reviewers

Anything reviewers should pay special attention to.

# Pull Request

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

## Release impact

Select exactly one. See
[the release plan](https://github.com/pavecer/servicenow-mcp-apps-copilot/blob/main/docs/RELEASE_PLAN.md).

- [ ] None — docs, tests, dependencies, or internal maintenance only
- [ ] Patch — backward-compatible bug fix or security correction
- [ ] Minor — backward-compatible user-facing capability
- [ ] Major — breaking API, configuration, behavior, or support change

## PR kind

Select exactly one.

- [ ] Regular change
- [ ] Version release — generated with `npm run release:prepare`

## Release note

<!-- One user-facing sentence for Patch/Minor/Major. Write N/A for None. -->
<!-- Also add &lt;!-- release-impact: patch|minor|major --&gt; beside its Unreleased changelog entry. -->

## Human validation

Select exactly one. Agents may open a draft PR while evidence is pending. A
user-facing PR must not merge until click-through validation passes in both test
environments and the human records final approval.

- [ ] Not required — no user-facing behavior changed
- [ ] Completed maintainer workflow review — release/CI tooling only
- [ ] Completed in test tenant

## Human validation evidence

<!-- State what was tested and where, or why human validation is not required. -->

<!-- For user-facing changes include the exact SHA, M365 agent prompts/widget -->
<!-- result, corresponding ServiceNow record/ACL result, and cleanup outcome. -->

## Interaction lifecycle self-review

<!-- REQUIRED whenever this PR changes anything under src/ui/ (widgets, host -->
<!-- bridge, widget registry). N/A otherwise. This is a review artifact, not a -->
<!-- formality: walk the full interaction yourself and record what you found -->
<!-- BEFORE writing the Human test plan below. Its purpose is to catch obvious -->
<!-- UX problems (a "second click" away) before asking a human to find them. -->
<!-- See .github/skills/mcp-apps-ui/SKILL.md \u00a77 for the full checklist. -->

- Initial/idle state: <!-- what the user sees before any action -->
- Primary action → result: <!-- exact outcome of the first click -->
- Repeat the same action → result: <!-- what happens on the 2nd/Nth click; if -->
  <!-- state changed, does the control now reflect it, or is it a dead/duplicate -->
  <!-- affordance that silently does nothing useful? -->
- Error / unsupported / edge case → result: <!-- what happens when it fails, -->
  <!-- times out, or the host doesn't support it -->
- Recovery: <!-- can the user get back to a sane state without reloading? -->
- Reversibility: <!-- if this action changes a durable/visible state, is there -->
  <!-- a way to undo/reverse it, and does the control's label/affordance -->
  <!-- reflect the current state? -->

### Human test plan

<!-- Required for user-facing changes. The agent preparing this PR must replace -->
<!-- every placeholder with a reproducible manual script before requesting approval. -->

- Test tenant / agent: <!-- developer or organizational agent; never include tenant IDs -->
- Test persona(s): <!-- for example requestor, approver, admin; no private identifiers -->
- Preconditions / fixtures: <!-- exact safe fixture state and setup command -->
- Manual steps and expected results:
      1. <!-- exact prompt or click --> → <!-- expected tool, widget, and visible state -->
      2. <!-- next interaction --> → <!-- expected result and recovery/error behavior -->
- ServiceNow verification: <!-- table/record state, caller attribution, ACL expectation -->
- Cleanup: <!-- exact cleanup command or records to remove/reset -->
- Human result: PENDING
- Approval record: PENDING <!-- follow docs/HUMAN_APPROVAL.md; bind both records to the full SHA -->

### Candidate evidence

- Exact SHA:
- Build/tests/release check:
- Azure test deployment and live tools:
- ServiceNow test environment:
- M365 test tenant click-through:
- Fixture cleanup and storage security restoration:
- Final human approval: PENDING <!-- independent Approve review, or exact sole-maintainer HUMAN APPROVAL: MERGE comment -->

## Checklist

- [ ] `npm run build && npm test` passes locally.
- [ ] `npm run release:check` passes locally.
- [ ] The exact deployed SHA is recorded above; no commits were pushed after
      final human approval.
- [ ] For user-facing changes, the human test plan has no placeholders and its
      result is PASS before approval.
- [ ] For changes under `src/ui/`, the Interaction lifecycle self-review above
      is completed (not N/A) and was done before the Human test plan was written.
- [ ] Tests added or updated where practical.
- [ ] If a tool/widget was added or renamed, **all** lockstep locations were
      updated together (tool file + Zod schema, `src/tools/index.ts`,
      `registerTools()`, `src/ui/widgets.ts`, exact-count tests, and
      `m365-agent/appPackage/` manifests). See
      [AGENTS.md](https://github.com/pavecer/servicenow-mcp-apps-copilot/blob/main/AGENTS.md).
- [ ] MCP Apps surface preserved: widget-backed tools emit compact
      `structuredContent` plus a concise, neutral `content` summary (no verbose
      JSON or Adaptive Card payloads in `content`).
- [ ] Docs / environment-variable table updated for any config or behavior change.
- [ ] No secrets, tokens, PII, or tenant-specific resource names were added.
- [ ] Added an entry to
      [CHANGELOG.md](https://github.com/pavecer/servicenow-mcp-apps-copilot/blob/main/CHANGELOG.md)
      under *Unreleased*.

## Notes for reviewers

Anything reviewers should pay special attention to.

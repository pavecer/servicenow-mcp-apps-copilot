---
name: release-communications
description: 'Prepare release communications after a version is released: update the GitHub Pages project site, draft a factual LinkedIn announcement, verify release links and claims, and prepare a communications PR. Use when announcing a release, promoting a new feature, updating the project website for a release, or drafting a LinkedIn launch post. Never publish to LinkedIn without explicit user approval.'
argument-hint: 'Version to announce, for example v1.2.0'
---

# Release Communications

Use this workflow only after the release-bearing feature has passed its required
human validation. The dated `CHANGELOG.md` section is the source of truth for
public claims.

## Boundaries

- Never announce an `Unreleased` section as shipped.
- Never publish, schedule, or submit a LinkedIn post without explicit approval
  of the final text in the current conversation.
- Never claim Microsoft, ServiceNow, or LinkedIn endorsement or partnership.
- Do not include tenant names, internal resource identifiers, test identities,
  secrets, unpublished security details, or private validation evidence.
- Keep Microsoft 365 catalog publication separate from the GitHub release.
- Make release-communication changes on a branch and merge them through a PR.

## Inputs

Resolve these before editing:

1. Released version, preferably from the user or latest GitHub Release.
2. Matching dated section in `CHANGELOG.md`.
3. Public GitHub Release URL.
4. Public project-page URL.
5. Human-validation status for every user-facing behavior being announced.

Stop and report the missing prerequisite when the version is not released, the
changelog section is absent, or required human validation is incomplete.

## Workflow

1. Read `docs/REPO_STATE.md`, `docs/RELEASE_PLAN.md`, the matching dated
   `CHANGELOG.md` section, and the GitHub Release.
2. Compare the release section with the previous release and inspect the merged
   implementation only where needed to verify concrete claims.
3. Update `site/index.html` so its current feature description, tool/widget
   inventory, and validation facts match the released public baseline. Preserve
   the existing visual language and do not expose test-only state.
4. Draft the LinkedIn post using
   [the announcement template](./assets/linkedin-announcement.md). Keep the main
   post easy to scan and put links at the end. Prefer specific user value over
   implementation inventory.
5. Save the proposed copy to `release-comms/vX.Y.Z-linkedin.md`. The file must
   remain clearly marked as a draft until the user approves it.
6. Validate:
   - `npm run release:check`
   - `npm run build && npm test`
   - Confirm the GitHub Release and project-page links return successfully.
   - Inspect the Pages change at desktop and mobile widths, including dark mode.
   - Search the draft and site diff for tenant-specific or sensitive values.
7. Present the exact LinkedIn text and site-change summary for user approval.
8. After approval, prepare a dedicated communications PR. Publishing to
   LinkedIn remains a separate, explicit action.

## LinkedIn Approval Gate

Treat approval as valid only when the user approves the exact current draft.
Edits after approval invalidate it and require approval again. If no authorized
LinkedIn integration is available, return the approved copy ready for the user
to post; do not attempt credential setup or browser automation.

## Output

Report:

- release and source links used;
- exact site sections changed;
- exact proposed LinkedIn copy;
- validation results;
- whether LinkedIn publication is `blocked`, `awaiting approval`, `approved`, or
  `published`.

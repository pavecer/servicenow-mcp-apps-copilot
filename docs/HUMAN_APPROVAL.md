# Human PR approval protocol

This repository has one human development gate. It happens only after the agent
has finished implementation, automated validation, exact-commit test deployment,
and preparation of the PR's Human test plan. Human validation and permission to
merge are separate records; both must identify the same 40-character candidate
SHA.

## Before the human gate

The agent keeps the PR in draft and completes all agent-owned work:

1. Record the full candidate SHA in **Candidate evidence**.
2. Complete build, test, release, Azure deployment, and live-tool checks.
3. For any change under `src/ui/` (widgets, host bridge, widget registry),
   complete the **Interaction lifecycle self-review** first: walk the full
   interaction yourself — initial state, primary action, repeating the same
   action, error/edge case, recovery, and reversibility — and record what you
   found. This is CI-enforced (`release:pr-check` rejects a missing or
   incomplete review for these changes) and exists specifically so obvious UX
   problems (a dead affordance, a control that doesn't reflect the state it
   just changed) are caught before the human clicks through the plan, not
   after.
4. Replace every Human test plan placeholder with exact prompts, clicks,
   expected widget states, ServiceNow verification, and cleanup instructions.
5. Confirm that the deployed SHA equals the PR head SHA.
6. Stop changing the branch while the human runs the plan.

The human must test the recorded SHA. A branch name, abbreviated SHA, deployment
slot, or statement that "the latest version" was tested is not sufficient.

## Record the test result

After following the complete plan in Microsoft 365 and ServiceNow, the human
adds a normal PR comment using one of these exact forms.

Successful validation:

```text
HUMAN VALIDATION: PASS
Candidate SHA: <full 40-character SHA>
M365 test plan: PASS
ServiceNow verification: PASS
Cleanup: PASS
Notes: <concise non-secret observations, or none>
```

Failed or incomplete validation:

```text
HUMAN VALIDATION: FAIL
Candidate SHA: <full 40-character SHA>
Failed step: <step number and observed result>
Cleanup: PASS|PENDING
Notes: <concise non-secret observations>
```

Do not include tenant IDs, access tokens, user PII, private record identifiers,
HAR contents, credentials, or private URLs. A failure returns the PR to draft;
the agent repairs it, creates and deploys a new candidate, and provides a fresh
test plan.

## Authorize the merge

Only a PASS result may be approved. Use the applicable path:

- **Independent reviewer available:** the reviewer verifies the PASS comment and
  candidate SHA, then submits GitHub's **Approve** review on that same SHA. A
  comment-only review does not count as approval.
- **Sole maintainer:** GitHub does not allow an author to approve their own PR.
  After posting the PASS comment, the maintainer adds this separate PR comment:

  ```text
  HUMAN APPROVAL: MERGE
  Candidate SHA: <full 40-character SHA>
  ```

The sole-maintainer comment is the explicit merge instruction. Phrases such as
"approved," "looks good," an `@copilot` mention, a reaction, or completion of
the test-result comment alone do not authorize an agent to merge.

## Agent merge checks

Immediately before merging, the agent verifies all of the following:

- the PR head equals the SHA in both human records;
- Human validation is PASS and all required environment results are PASS;
- the independent approving review or sole-maintainer merge instruction exists;
- required checks pass and review conversations are resolved;
- the PR is not draft and GitHub reports it mergeable;
- no commit was pushed after validation or approval.

Any new commit invalidates the human validation and approval records, even when
GitHub does not dismiss a comment automatically. The agent resets the PR's Human
result and Approval record to `PENDING`, redeploys the new exact SHA, and repeats
the gate. The agent must never reinterpret an ambiguous comment as approval.

This gate authorizes merging the tested development PR only. It does not
authorize production deployment, tenant admin consent, organizational catalog
publication, a public release, or external communications.
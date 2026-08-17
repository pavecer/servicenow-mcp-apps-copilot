# Knowledge Retrieval Implementation Plan

Status: **1.2.0 release candidate on `feat/knowledge-retrieval`**  
Release impact: **Minor**  
Current public baseline: **23 tools / 8 widgets / version 1.1.6**

## Goal

Add caller-visible ServiceNow Knowledge retrieval for informational questions
that are not catalog-ordering requests. Search must minimize ServiceNow calls,
preserve caller visibility, rank the top three to five articles, store explicit
native feedback, and offer a consent-based incident after the third unresolved
Knowledge attempt.

Article authoring, attachment file rendering or download, explicit star-rating
and free-text feedback UI, and knowledge analytics administration remain outside
this candidate. Binary useful feedback, optional native not-helpful reasons,
and article-to-incident links are in scope.
Caller-visible attachment metadata and canonical ServiceNow handoff are in
scope. The verified native feedback and article-to-task schema is implemented
in the deployed candidate and documented below.

## User Journey

1. The agent routes how-to, policy, troubleshooting, and informational questions
   to `search_knowledge` instead of catalog search.
2. Attempt 1 performs one caller-scoped ServiceNow search and returns up to five
   ranked snippets.
3. Opening an article calls `get_knowledge_article` once for the full body.
4. The user opens a feedback form that discloses ServiceNow persistence, records
   `yes` or `no`, and optionally selects a native not-helpful reason.
5. Explicit “not helpful” feedback increments `attempt`, preserves the original
   question, and excludes tried article IDs.
6. On attempt 3, the widget offers incident creation after feedback. It never
   creates an incident without affirmative user consent.
7. `create_incident_from_knowledge` creates one incident POST containing a
   standardized, searchable “Knowledge assistance outcome: Not helpful” block
   plus attempted article metadata, then best-effort links visible articles
   through `m2m_kb_task`.

## Call Budget

| Operation | ServiceNow calls |
| --- | ---: |
| Search attempt | 1 |
| Open one article | 2: article detail + nonfatal attachment metadata |
| Submit feedback | Article visibility + caller lookup + `kb_feedback` POST |
| Consented incident creation | Existing identity lookups + incident POST + one bounded article visibility query + up to 20 best-effort `m2m_kb_task` POSTs |

The implementation does not enumerate knowledge bases before each search and
does not enrich every result with follow-up calls.

## Ranking

Prefer ServiceNow native relevance when the Knowledge API returns a score.
Otherwise rerank the bounded result set inside the Azure Function using a
deterministic BM25-style lexical score:

| Field | Weight |
| --- | ---: |
| Title | 5.0 |
| Article keywords | 4.0 |
| Short description | 3.0 |
| Search snippet | 1.5 |
| Category / knowledge base | 1.0 |

Exact-title phrase and full-query-token coverage receive small bonuses. Native
relevance, when present, contributes 60% of the fused score. Article popularity
and recency are tie-breakers only. Scores remain structured metadata; the UI
shows `Best match`, `Strong match`, or `Related`, not a misleading confidence
percentage.

## Tool Contracts

### `search_knowledge`

- `query`: current search wording
- `originalQuestion`: stable first user question
- `attempt`: integer 1–3
- `excludeArticleSysIds`: optional previously tried IDs
- `language`: optional locale
- `limit`: 1–5, default 5

Returns ranked snippets, ranking source, carried attempt state, and
`offerIncident: true` on attempt 3.

### `get_knowledge_article`

- `articleSysId`
- `originalQuestion`
- `attempt`
- `triedArticles`: compact article history

Returns one sanitized plain-text article and preserves journey state.

### `submit_knowledge_feedback`

- `articleSysId`
- `useful`: native `yes` or `no`
- `originalQuestion`
- optional native reason `1` incomplete, `2` incorrect, `3` unclear, `4` other
- optional explicit rating 1–5 and comment for non-widget callers

Requires caller identity, verifies the article is active/published/non-expired,
resolves the ServiceNow user, and creates a native `kb_feedback` record. The
widget currently exposes binary feedback plus the optional native reason.

### `create_incident_from_knowledge`

- `originalQuestion`
- `issueSummary`
- `attemptCount`
- `triedArticles`
- optional category/urgency/impact

Requires explicit consent at the agent/widget layer. Returns a minimal incident
confirmation plus native-link diagnostics without a detail refetch. Link failure
never changes a successfully created incident into a failed result; attempted
article history remains in the incident description.

## Access and API Strategy

- Use the existing `ServiceNowClient` so OBO/caller token resolution remains the
  same as catalog and incident flows.
- Primary endpoint: ServiceNow Knowledge API
  `/api/sn_km_api/knowledge/articles` and article detail by sys_id.
- Optional compatibility endpoint: caller-scoped `kb_knowledge` Table API,
   enabled only with `SERVICENOW_KNOWLEDGE_TABLE_FALLBACK_ENABLED=true`. It is
   used only when the dedicated endpoint returns 400/404, never for auth errors,
   and filters active/published/non-expired rows before ranking.
- Normalize several documented/observed response envelopes, but do not silently
  fall back to an overprivileged admin view.
- The current preflight confirms `kb_knowledge` and `kb_category` are reachable;
  the integration identity currently sees zero rows while admin has demo data.
  Human validation must prove Alex-visible results through OBO before release.
- Live delegated admin probing confirmed this demo instance returns 400
   `Requested URI does not represent any resource` for `sn_km_api`, while
   caller-scoped `kb_knowledge` returns data. The demo environment therefore
   requires the validated opt-in fallback; the default remains disabled.

## MCP App

One shared `knowledge` widget supports:

- ranked search results,
- article detail,
- omitted-image and attachment handoff to the canonical ServiceNow article,
- third-attempt incident offer,
- incident confirmation.

The inline widget remains glanceable, supports light/dark themes, has explicit
loading/error states, and shows no more than two bottom actions.

## Implementation Slices

- [x] Types and deterministic ranker
- [x] ServiceNow Knowledge search/detail client
- [x] Search/detail MCP tools and schemas
- [x] Shared Knowledge MCP App widget
- [x] Caller-scoped media/attachment metadata and ServiceNow handoff
- [x] Caller-scoped native `kb_feedback` writes and optional native reasons
- [x] Best-effort native `m2m_kb_task` article-to-incident links
- [x] Consent-based Knowledge incident tool and standardized incident flag
- [x] Agent intent/attempt routing instructions
- [x] Tool/widget lockstep manifests and exact-count tests
- [x] Scenario, setup, configuration, and handover documentation
- [x] Earlier retrieval/formatting/media build, test, and security reviews
- [x] Final full build/test/security review for the native-write candidate
- [x] Deploy runtime `b363012` plus package-guidance fix `1164751` to `snowmcpwidg-dev`
- [x] Human visual validation of structured article detail
- [x] Human validation of image and attachment ServiceNow handoff
- [ ] Human validation as Alex and admin
- [ ] Public PR only after explicit approval

## Validation Matrix

- Native relevance present and absent
- Exact title versus generic popular article
- Duplicate/superseded articles
- Excluded tried articles
- Empty and malformed results
- Published/access-controlled article visibility
- Attempt 1, 2, and 3 state preservation
- Incident offer on attempt 3 only
- No incident without explicit consent
- Feedback article state, caller attribution, native values, and write failures
- Rapid contradictory feedback prevention and required-state accessibility
- Attempt 1–2 explicit continuation and attempt-3 post-feedback escalation
- Truthful incident success under complete or partial task-link failure
- Standardized KB-not-helpful incident content
- Light/dark and responsive widget rendering
- Images after preview limits and executable-block exclusion
- Attachment count/filename/type/size bounds with nonfatal ACL failures
- No media URLs, attachment IDs, file bytes, or direct downloads in tool output
- Existing catalog/order/incident tests remain unchanged and green

## Local Validation Checkpoint

- Focused native-feedback/link validation: 7 test files / 130 tests passed.
- Knowledge candidate: 41 test files / 395 tests passed; backend and MCP Apps
   specialist verdicts APPROVE after all findings were remediated.
- Backend and MCP Apps specialist reviews: APPROVE after all High/Medium
   findings were remediated.
- Visual review passed for desktop search, responsive dark attempt 3,
   responsive article detail, the compact ranked-results update, and preserved
   source headings/nested lists in desktop light and narrow dark layouts using
   the actual widget source.
- Media handoff visual review passed for image-only desktop light and
   attachment-only narrow dark states. The notice remains above article content,
   lists at most three filenames plus a remainder count, and preserves the two
   bottom resolution actions.
- Native feedback visual review passed for initial article commands, narrow dark
   feedback form, saved not-helpful outcome, gated-host fallback, and
   attempt-three escalation. Every state remains readable and exposes no more
   than two commands.
- Minor release preparation completed: canonical npm/M365 version is `1.2.0`
   and the dated changelog section contains the validated release notes.
- Runtime `b363012` plus package-guidance fix `1164751` is deployed to
   `snowmcpwidg-dev` with 27 tools. The existing developer M365 app passed all
   61 package validations and retained title `T_7083fecd-9cd0-e94d-285b-0e25bfc2a169`.
- Ranked search now renders the top three compact previews so both actions stay
   visible, labels Knowledge base/category/update metadata, retains category in
   the narrow layout, and decodes decimal/hex numeric HTML entities before they
   reach the widget.
- Selected articles now preserve ServiceNow's returned heading, paragraph,
   nested-list, emphasis, code, preformatted, blockquote, and line-break
   structure through a bounded attribute-free document model. Executable blocks,
   attributes, and unknown tags are removed; plain model text derives from the
   same sanitized tree. Long previews are explicitly labeled and route to the
   full ServiceNow article.
- No package was added: managed-machine policy blocks external npm downloads,
   so the implementation uses a dependency-free bounded state-machine parser
   with hostile/malformed fixtures rather than bypassing policy or rendering raw
   ServiceNow HTML.
- Live deployed KB0005001 validation reports document v1 with 2 `h1`, 10 `h3`,
   14 nested `ul`, 40 `li`, maximum depth 5, and no truncation. Read-only probes
   also preserved VPN ordered/nested lists and emphasis, cookie headings/code,
   and password paragraph/strong structure.
- Live deployed media validation reports 3 omitted images for KB0000003 and one
   caller-visible PNG attachment for KB0000018. Both return a canonical article
   link and no direct media URL, attachment ID, download URL, or file content.
- Human media-handoff validation completed on 2026-08-11: the user tested the
   deployed image and attachment article states and confirmed that both behaved
   as described.
- Human visual validation completed on 2026-08-11: the user opened the deployed
   Workstation Security Standard article and confirmed that the preserved source
   formatting "works much better" and is easier to read.
- Live delegated-admin validation returned five ranked articles, opened
   `KB0005012` with content and a ServiceNow source link, and confirmed that
   attempt 3 excludes the tried article and sets `offerIncident: true` without
   creating an incident. The demo-only Table API fallback is enabled, storage
   public access is `Disabled`, and no deployment exemption remains.
- No public push or PR has occurred. The article-formatting checkpoint is
   approved and the media handoff is approved, but Alex and admin must still
   complete the three-attempt tenant journey, including explicit incident
   consent, before a Version release PR can be opened.

## Verified Native Feedback Schema

Read-only delegated-admin schema inspection on `dev351709` confirms that native
ServiceNow Knowledge processing uses:

- `kb_feedback.article` -> `kb_knowledge`, with `user`, `useful`, integer
   `rating`, `comments`, `reason`, and `query` fields;
- `kb_feedback_task.feedback` -> `kb_feedback` for downstream feedback work;
- `m2m_kb_task.kb_knowledge` + `m2m_kb_task.task` for a native article-to-task
   association; and
- `kb_use` for native view/use analytics, protected by its own ACLs.

The deployed candidate now writes `kb_feedback` using exact native `yes`/`no` and
reason values and links attempted caller-visible articles through `m2m_kb_task`
after incident creation. Both writes fail closed on caller identity. Feedback
failure remains visible and recoverable; task-link failure is nonfatal because
the incident already exists and retains attempted article history in its
description.

Live delegated-admin validation created one uniquely marked native feedback row
for KB0005001 (`useful=no`, reason `3`, caller populated), one caller-attributed
incident, and one `m2m_kb_task` article link. The tool reported 1 requested / 1
linked / 0 failed. All three marker-owned records were deleted with HTTP 204 and
follow-up queries confirmed zero feedback/incident rows remain. Human widget
validation as admin and Alex remains pending.

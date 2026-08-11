# Knowledge Retrieval Implementation Plan

Status: **1.2.0 release candidate on `feat/knowledge-retrieval`**  
Release impact: **Minor**  
Current public baseline: **23 tools / 8 widgets / version 1.1.6**

## Goal

Add read-only ServiceNow Knowledge retrieval for informational questions that
are not catalog-ordering requests. Search must minimize ServiceNow calls,
preserve caller visibility, rank the top three to five articles, and offer a
consent-based incident after the third unresolved Knowledge attempt.

Article authoring, native feedback/rating writes, attachments, and knowledge
analytics administration remain outside this candidate. The verified native
feedback schema is recorded below for a follow-up implementation.

## User Journey

1. The agent routes how-to, policy, troubleshooting, and informational questions
   to `search_knowledge` instead of catalog search.
2. Attempt 1 performs one caller-scoped ServiceNow search and returns up to five
   ranked snippets.
3. Opening an article calls `get_knowledge_article` once for the full body.
4. Explicit “not helpful” feedback increments `attempt`, preserves the original
   question, and excludes tried article IDs.
5. On attempt 3, the widget always offers incident creation politely. It never
   creates an incident without affirmative user consent.
6. `create_incident_from_knowledge` creates one incident POST containing a
   standardized, searchable “Knowledge assistance outcome: Not helpful” block
   plus attempted article metadata.

## Call Budget

| Operation | ServiceNow calls |
| --- | ---: |
| Search attempt | 1 |
| Open one article | 1 |
| Consented incident creation | Up to 2 identity lookups + 1 incident POST (existing incident path) |

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

### `create_incident_from_knowledge`

- `originalQuestion`
- `issueSummary`
- `attemptCount`
- `triedArticles`
- optional category/urgency/impact

Requires explicit consent at the agent/widget layer. Returns a minimal incident
confirmation without a detail refetch.

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
- third-attempt incident offer,
- incident confirmation.

The inline widget remains glanceable, supports light/dark themes, has explicit
loading/error states, and shows no more than two bottom actions.

## Implementation Slices

- [x] Types and deterministic ranker
- [x] ServiceNow Knowledge search/detail client
- [x] Search/detail MCP tools and schemas
- [x] Shared Knowledge MCP App widget
- [x] Consent-based Knowledge incident tool and standardized incident flag
- [x] Agent intent/attempt routing instructions
- [x] Tool/widget lockstep manifests and exact-count tests
- [x] Scenario, setup, configuration, and handover documentation
- [x] Full local build/test/security review
- [x] Deploy exact runtime commit `0dcfe4b` to `snowmcpwidg-dev`
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
- Standardized KB-not-helpful incident content
- Light/dark and responsive widget rendering
- Existing catalog/order/incident tests remain unchanged and green

## Local Validation Checkpoint

- Full repository: 41 test files / 360 tests passed.
- Backend and MCP Apps specialist reviews: APPROVE after all High/Medium
   findings were remediated.
- Visual review passed for desktop search, responsive dark attempt 3,
   responsive article detail, the compact ranked-results update, and preserved
   source headings/nested lists in desktop light and narrow dark layouts using
   the actual widget source.
- Minor release preparation completed: canonical npm/M365 version is `1.2.0`
   and the dated changelog section contains the validated release notes.
- Runtime commit `0dcfe4b` is deployed only to `snowmcpwidg-dev`; live MCP
   validation reports 26 tools, and the existing developer M365 app passed all
   61 package checks and was updated without organizational publication.
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
- Live delegated-admin validation returned five ranked articles, opened
   `KB0005012` with content and a ServiceNow source link, and confirmed that
   attempt 3 excludes the tried article and sets `offerIncident: true` without
   creating an incident. The demo-only Table API fallback is enabled, storage
   public access is `Disabled`, and no deployment exemption remains.
- No public push or PR has occurred. Alex and admin must still complete the
   human tenant journey, including explicit incident consent, before a Version
   release PR can be opened.

## Verified Native Feedback Schema

Read-only delegated-admin schema inspection on `dev351709` confirms that native
ServiceNow Knowledge processing uses:

- `kb_feedback.article` -> `kb_knowledge`, with `user`, `useful`, integer
   `rating`, `comments`, `reason`, and `query` fields;
- `kb_feedback_task.feedback` -> `kb_feedback` for downstream feedback work;
- `m2m_kb_task.kb_knowledge` + `m2m_kb_task.task` for a native article-to-task
   association; and
- `kb_use` for native view/use analytics, protected by its own ACLs.

The current `This solved it` / `Still need help` actions preserve conversation
state but do not yet create `kb_feedback` records. Knowledge incident creation
creates a real caller-attributed `incident` and records article sys_ids in its
description, but does not yet insert `m2m_kb_task`. Native feedback and task
linking must be added as an explicit mutating, caller-scoped follow-up slice.

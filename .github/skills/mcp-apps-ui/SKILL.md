---
name: mcp-apps-ui
description: >-
  Build, review, and fix MCP Apps interactive UI widgets that render inside
  Microsoft 365 Copilot (and other MCP hosts). Encodes the official Microsoft
  365 Copilot MCP Apps UX guidelines, the modelcontextprotocol.io MCP Apps
  protocol mechanics, the microsoft/mcp-interactiveUI-samples patterns, AND this
  repo's concrete widget conventions (host bridge, registry, build pipeline,
  flag gating, tests). USE WHEN: creating a new widget, adding a widget to a
  tool, editing widget HTML/CSS/JS, reviewing a widget against the UX
  guidelines, fixing inline-vs-side-by-side density, Fluent 2 styling, widget
  state handling, _meta.ui / ui:// resource wiring, CSP / permissions, or
  structuredContent contracts. DO NOT USE FOR: ServiceNow API logic, OBO/Entra
  auth, or Azure deployment (those have their own agents/docs).
---

# MCP Apps interactive UI for Microsoft 365 Copilot

This skill makes widgets that are **native to Copilot**: conversational,
glanceable, Fluent-consistent, and protocol-correct. It combines three sources
plus this repo's invariants:

1. **UX guidelines** — Microsoft Learn: *User experience guidelines for MCP apps
   in declarative agents for Microsoft 365 Copilot*
   (`/microsoft-365/copilot/extensibility/plugin-mcp-apps-ui-guidelines`).
2. **Protocol mechanics** — `modelcontextprotocol.io/extensions/apps/overview`
   and `/build` (the MCP Apps extension, a.k.a. SEP-1865 / `ext-apps`).
3. **Reference patterns** — `github.com/microsoft/mcp-interactiveUI-samples`
   (Fluent UI React widgets that render inline in Copilot chat).

> Always load this skill before touching anything under `src/ui/widgets/`.

---

## 1. The five UX principles (memorize these)

A Copilot agent must provide **more value inside Copilot than as a standalone
app**. Every widget decision flows from these:

1. **Deliver conversational value.** Leverage natural language, thread context,
   and multi-turn interaction. Design *for* conversation — don't replicate an
   existing web flow.
2. **Extract capabilities, don't replicate interfaces.** Expose atomic, high-
   value capabilities as tools. Each needs only minimum inputs, returns
   structured/reliable outputs, and lets the model confidently pick the next
   step. Do **not** port your full SaaS UI into Copilot.
3. **Design to feel native to Copilot.** Use Copilot's design system (Fluent 2)
   components, spacing, and interaction patterns. Consistency reduces cognitive
   load.
4. **Preserve human control.** The user is the ultimate decision-maker. Provide
   clear visibility into agent actions, explicit confirmations for sensitive
   operations, and transparent outcomes (what was created/modified/updated).
5. **Scale density with intent.** Match the visual footprint to the immediate
   need — inline for glanceable summaries + high-level actions; side-by-side
   only when the user needs more real estate to work alongside chat.

---

## 2. Chat surfaces — pick the right one

Core rules for every surface: **conversation-first**, **progressive
complexity** (start lightweight, expand only when needed), **context
preservation**, **clarity over duplication** (widget and model text must
complement, never repeat).

### Inline mode (REQUIRED — every app must support it)
The default in-conversation surface. The widget appears **before** the model
response. It is *not* a mini-application.

Use inline for: previews (documents, images, drafts), confirmations, simple
actions, quick decision prompts. Inline content should fit within a **single
scroll** of the response.

Inline widget anatomy:
- **Title** — include one if the card is document-based or has a parent entity.
- **Expand to side-by-side** — offer only if the card has rich media or
  interactivity that needs more room.
- **Actions** — **limit to two**, placed at the **bottom** of the card. Each
  action performs either a conversation turn or a tool call.

Inline interaction guidelines:
- **Keep interaction focused** — no multi-step flows, nested navigation, or deep
  configuration. If it needs iteration/comparison/extensive editing → side-by-
  side.
- **Show summaries, not systems** — previews, not full apps. No internal
  scrolling, pagination, tabs, filters, or multi-level grouping.
- **Make state explicit** — loading, disabled, success confirmation, and error
  (with a recovery option). Never rely on model text alone to convey status.
- **Preserve conversational flow** — fit in one response scroll; complement the
  model response, don't dominate the viewport.

### Side-by-side mode (OPTIONAL — use intentionally)
An expanded workspace alongside the conversation for richer workflows that can't
fit inline. Entering it should be a deliberate escalation, never the default.

Use side-by-side for: multi-step editing/configuration, iterative workflows with
persistent state, complex layouts (tables, canvases, dashboards), extended
review/comparison, rich authoring, workspace-level interaction beyond one
scroll. If the task is a concise single-turn interaction → use inline instead.

Side-by-side layout: conversation pane stays primary; the inline widget
collapses into a compact **chiclet card**; the panel header shows agent identity
+ handoff to the full app; the workspace is a *contextual* surface (not an app
shell) with task-specific contextual controls.

Side-by-side interaction guidelines:
- **Keep workspace contextual** — no global nav, multi-tab systems, settings
  panels, or unrelated features. If it resembles your whole SaaS product, it's
  out of scope.
- **Preserve chat as primary** — users keep chatting while it's open.
- **Scope to the active task** — one coherent workflow; don't switch between
  unrelated entities or launch nested experiences.
- **Make state explicit** and **maintain progressive escalation**.

---

## 3. Best practices — DO / DON'T

✅ **Preserve conversational flow.** Lightweight, action-oriented inline widgets.
Up to **two** primary actions (e.g. Approve, Edit, Download). Deep
navigation/multi-step/heavy config → hand off to side-by-side.

✅ **Use Fluent components for native fit.** Fluent 2 components, spacing,
typography, tokens.

✅ **Provide widget state handling.** Clear loading, disabled, success, and error
(with recovery) states.

❌ **Don't make a widget resemble a full application.** No app chrome, no
mimicking the whole product.

❌ **Don't duplicate Copilot features.** No prompt input, suggestions, reasoning
summaries, or retry controls inside the widget — Copilot already provides these.

❌ **Don't use deep navigation.** No multiple tabs or nested navigation inside a
widget. Split into separate cards or tool actions instead.

❌ **Don't build large, scroll-heavy layouts.** Inline widgets must be concise
and glanceable. Avoid vertical scroll within the widget. If content needs
scrolling, complex tables, or detailed editing → side-by-side.

❌ **Don't duplicate content between model text and widget.** Show it once.

---

## 4. Visual design (Fluent 2 Copilot theme)

Align to the [Fluent 2 design system](https://fluent2.microsoft.design/) so
behavior, controls, and visuals are predictable across Copilot apps.

| Token | Guidance |
| --- | --- |
| **Color** | Use Fluent 2 color ramps (e.g. brand blues 60–100). Support light AND dark via `color-scheme` + a `[data-theme="dark"]` override. |
| **Button** | Fluent 2 button styles + hierarchy (one primary action max per group). |
| **Typography** | Fluent 2 type ramp; Segoe UI / system font stack. |
| **Radius** | Fluent 2 corner radius (rounded, consistent — e.g. 4–8px). |
| **Spacing** | **Global app-card padding = 24px.** Consistent internal gaps. |
| **Iconography** | Fluent 2 icons; don't invent ad-hoc glyphs for primary actions. |

---

## 5. Protocol mechanics (MCP Apps / SEP-1865)

How a widget actually renders and talks to the host:

1. **UI preload** — the tool's `tools/list` entry carries
   `_meta.ui.resourceUri` pointing at a `ui://…` resource. The host may preload
   it before the tool is even called.
2. **Resource fetch** — the host reads the `ui://` resource via
   `resources/read`. It returns a **self-contained HTML page** (inline CSS + JS,
   no external fetches) with MIME `text/html;profile=mcp-app`.
3. **Sandboxed render** — the host mounts the HTML in a **sandboxed iframe**. It
   cannot reach the parent DOM, cookies, or storage. Extra origins need
   `_meta.ui.csp`; capabilities (camera, microphone, geolocation, clipboardWrite)
   need `_meta.ui.permissions` **on the resource, not the tool**.
4. **Bidirectional comms** — app ↔ host speak a JSON-RPC dialect over
   `postMessage`. The app receives the tool result, can `callServerTool` /
   `tools/call`, send follow-up messages, open links, and push context updates.

Server registration (canonical `ext-apps` shape):
- `registerAppTool(server, name, { …, _meta: { ui: { resourceUri } } }, handler)`
- `registerAppResource(server, uri, uri, { mimeType: RESOURCE_MIME_TYPE }, …)`
- The tool handler returns `{ content: [...], structuredContent: {...} }`. The
  **`structuredContent`** is what the widget renders.

Client (inside the widget):
- `app.connect()` once at init.
- `app.ontoolresult = (result) => …` for the initial pushed result.
- `app.callServerTool({ name, arguments })` for user-initiated tool calls.

> Host support varies. Microsoft 365 Copilot (Cowork) honours `_meta.ui` with
> `csp.frameDomains` (NOT `connectDomains`/`resourceDomains`) and camelCase
> permissions only. This repo's bridge also supports the OpenAI Apps SDK
> (`window.openai.*`) host shape — see §6.

---

## 6. THIS REPO's widget conventions (follow exactly)

The repo implements the protocol manually with self-contained HTML + a bundled
host bridge. Do not introduce React/Vite per-widget; match what exists.

### File map
- `src/ui/widgets/src/*.html` — one self-contained widget per file (inline CSS +
  vanilla JS IIFE). Authoring source of truth.
- `src/ui/widgets/bridge/host-bridge.ts` — dual-mode bridge (OpenAI Apps SDK
  `window.openai.*` + MCP Apps `App` postMessage). esbuild-bundled and injected
  at the `<!-- MCP_HOST_BRIDGE -->` marker.
- `scripts/dev/build-widgets.mjs` — auto-discovers `src/*.html`, injects the
  bridge, base64-emits to `src/ui/widgets/generated/`. Adding a new `.html`
  needs **no** pipeline change.
- `src/ui/widgets.ts` — the `WIDGETS` registry: `toolName`, optional
  `boundToolNames`, `uri` (`ui://servicenow-mcp/…`), `name`, `description`,
  `html`, optional `frameDomains` / `permissions`. `registerWidgetResources()`
  and `getWidgetForTool()` are always active (MCP Apps is the only surface).

### Widget bridge facade (`window.mcpHost`)
Consume only this facade from widget JS:
- `onData(cb)` → `cb(structuredContent)` when tool data arrives
- `getData()` → latest data | null
- `markRendered()` → call once the widget paints data
- `callTool(name, args)` → `Promise<result>` (unwrap `structuredContent`)
- `sendFollowUp(text)` → ask the model a follow-up (fallback when `callTool` is
  gated)
- `openExternal(url)` → open a URL (the sandbox blocks `window.open` /
  `target=_blank`)
- `applyTheme()` → sync `<html data-theme>` with host theme

### In-place multi-state pattern
A single widget instance re-renders through states (e.g. catalog-browse:
list → order form → confirmation; my-orders: list → detail). Prefer this over
mounting new widgets or forcing model round-trips. Always provide a graceful
**fallback to `sendFollowUp`** when the host gates widget-initiated `tools/call`.

### Design-system contract for widget HTML
- `:root` CSS vars + `html[data-theme="dark"]` override; `color-scheme: light dark`.
- Accent `#0078d4` (light) / `#2899f5` (dark); success banner `.banner-ok`.
- **Global card padding 24px** (Fluent guideline) — apply on `body`.
- Explicit state: `showLoading()` for loading, `.banner-ok` for success,
  `.error` for errors **with a retry/recovery path**, `button:disabled` for
  in-flight actions.
- Keep inline widgets glanceable: ≤2 primary actions at the bottom; no internal
  tabs/filters/pagination; avoid forcing vertical scroll.

### Surface + lockstep invariants (CRITICAL)
MCP Apps is the only surface: every widget-backed tool always emits compact
`structuredContent` + a concise, neutral `content` summary, and `_meta.ui` is
always present. When adding a tool or widget, update ALL of these or
cold-start/tests throw (see `/memories/repo/widget-and-tool-invariants.md`):
1. `src/tools/index.ts` `TOOL_NAMES` + minimal tool definitions (drift guard).
2. Tool Zod schema must match the minimal manifest (same property names +
   required set; no oneOf/anyOf/format/negative bounds).
3. `registerTools()` registers the tool.
4. `test/toolManifest.test.ts` exact tool-name list + count.
5. `test/widgetResources.test.ts` EXACT `ui://` resource count.
6. `m365-agent/appPackage/mcp-tools-1.json` + `ai-plugin.json` enumerate tools.
7. Tool `content` must never carry verbose JSON or Adaptive Card payloads.

### Build + verify
- `npm run build` runs `build-widgets.mjs` then `tsc` (generated widgets must
  exist before compile).
- `npm test` (vitest) — widget/manifest/gating tests assert exact counts.
- After widget HTML edits, **rebuild** so `generated/` is regenerated, then run
  the widget tests.

---

## 7. Review checklist (run this when validating/fixing a widget)

For each widget under `src/ui/widgets/src/`:

**Density & surface**
- [ ] Inline content is glanceable and fits ~one scroll; no app-shell chrome.
- [ ] ≤ 2 primary actions, at the bottom of the card.
- [ ] No tabs / nested navigation / internal pagination / filters inline.
- [ ] If it needs rich editing/comparison, it escalates to side-by-side rather
      than cramming inline.

**State handling**
- [ ] Loading state shown while data/tool calls are in flight.
- [ ] Action buttons disable while their call is in flight.
- [ ] Success confirmation is explicit (e.g. `.banner-ok`).
- [ ] Error state is visible AND offers recovery (retry / fallback follow-up),
      never a silent failure or opaque spinner.

**Native fit (Fluent 2)**
- [ ] Body/card padding = 24px; consistent gaps and radius.
- [ ] Light + dark themes both styled; `applyTheme()` wired.
- [ ] Accent + typography match the repo design-system contract.

**Conversational integrity**
- [ ] Widget does not duplicate content the model already says.
- [ ] Widget does not recreate Copilot features (prompt box, retry, suggestions).
- [ ] Sensitive/mutating actions get explicit confirmation (human control).

**Protocol & repo wiring**
- [ ] Self-contained HTML (no external fetches); bridge marker present.
- [ ] Consumes only `window.mcpHost` facade; `markRendered()` called on paint.
- [ ] `callTool` paths have a `sendFollowUp` fallback for gated hosts.
- [ ] Registered in `WIDGETS`; `permissions`/`frameDomains` on the resource.
- [ ] Lockstep invariants updated; widget/manifest tests pass after `npm run
      build`.

---

## 8. References
- UX guidelines: https://learn.microsoft.com/microsoft-365/copilot/extensibility/plugin-mcp-apps-ui-guidelines
- MCP Apps overview: https://modelcontextprotocol.io/extensions/apps/overview
- MCP Apps build guide: https://modelcontextprotocol.io/extensions/apps/build
- Samples: https://github.com/microsoft/mcp-interactiveUI-samples
- ext-apps spec: https://github.com/modelcontextprotocol/ext-apps
- Fluent 2: https://fluent2.microsoft.design/
- Repo invariants: `/memories/repo/widget-and-tool-invariants.md`

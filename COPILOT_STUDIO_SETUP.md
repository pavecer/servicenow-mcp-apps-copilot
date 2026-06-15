# Microsoft Copilot Studio Setup

This guide covers adding the ServiceNow MCP tool to a Copilot Studio agent and configuring the Adaptive Card ordering topic.

**Prerequisites**: MCP server deployed to Azure with Entra ID configured (see [README.md](README.md)).

## Supported orchestrator models

The agent model selected on the Copilot Studio agent (Settings > Generative AI > Model) controls how this MCP server's Adaptive Cards are rendered. Verified results:

| Model | Status | Notes |
|-------|--------|-------|
| GPT-5 (and newer) | Supported | Selection / form / confirmation Adaptive Cards render correctly. |
| Claude Sonnet (3.5+ in Copilot Studio) | Supported | Same Adaptive Card rendering parity as GPT-5. |
| GPT-4.1 | Not supported | Cannot reliably render the MCP `selectionAdaptiveCard` / `formAdaptiveCard`. The card payload is dropped or rewritten as plain text, breaking the ordering flow. Switch to GPT-5 or Claude Sonnet on the agent. |
| Older GPT-4 / GPT-4o variants | Untested | Not recommended; behavior may match the GPT-4.1 limitation. |

If you see the catalog text but no Adaptive Card UI in the agent, **check the agent's model first** before debugging the MCP server.

---

## Step 1 - Add the MCP Tool

1. Open your agent in [Microsoft Copilot Studio](https://copilotstudio.microsoft.com).
2. Go to **Tools > Add a tool > Model Context Protocol**.
3. Fill in:

   | Field | Value |
   |-------|-------|
   | Server name | `ServiceNow MCP` |
   | Server description | `MCP server for ServiceNow catalog search, order form retrieval, and order placement` |
   | Server URL | `https://<your-function-app>.azurewebsites.net/mcp` |
   | Authentication | `OAuth 2.0` |
   | Type | `Dynamic discovery` |

4. Click **Create**.
5. Copilot Studio reads `/.well-known/openid-configuration` and registers an OAuth client automatically.
6. When prompted, sign in with any account in your Entra tenant.
7. Verify all 4 tools appear:
   - `search_catalog_items`
   - `get_catalog_item_form`
   - `place_order`
   - `validate_servicenow_config`

---

## Step 2 - Import the Ordering Topic and Agent Instructions

The ordering flow uses an **autonomous-orchestrator + rendering topic** pattern, not a self-contained topic. The orchestrator drives the tool calls; the topic is invoked at each card-render boundary to deterministically render the Adaptive Card and capture the user's submit.

Two files in the repo define the working setup:

| File | Where it goes |
|------|---------------|
| [`copilot-studio/topics/[CTOP] - SnowMCP OrderCat.yaml`](copilot-studio/topics/%5BCTOP%5D%20-%20SnowMCP%20OrderCat.yaml) | Paste into Copilot Studio: **Topics > Add a topic > New topic > Open code editor**, replace the boilerplate with this YAML, Save. |
| [`copilot-studio/agent-instructions/CA-SNOW-Order-Agent.md`](copilot-studio/agent-instructions/CA-SNOW-Order-Agent.md) | Paste the *Instructions* block (inside the triple-backtick fence) into **Overview > Edit > Instructions**, Save, Publish. |

**Flow**: User states intent → search_catalog_items → topic renders selection card → user picks → get_catalog_item_form → topic renders form card → user submits → place_order → topic renders confirmation card. The orchestrator never tries to render or capture a card itself.

### Why this shape (not a self-contained topic)

Earlier attempts at a self-contained topic that *also* called `place_order` inline hit the dynamic-field-IDs limit of `AdaptiveCardPrompt`'s `output.binding` (which requires static keys). The current split fixes that: the topic captures the entire submit payload via `JSON(System.Activity.Value)` into one variable, and the orchestrator picks up two globals (`Global.ServiceNowSelectedItemSysId`, `Global.ServiceNowFormValuesJson`) on the next plan step to drive `place_order`.

See [`copilot-studio/agent-instructions/CA-SNOW-Order-Agent.md`](copilot-studio/agent-instructions/CA-SNOW-Order-Agent.md) for the full variable contract between topic and orchestrator, plus failure modes this design eliminates.

See [docs/MCS_ACTION_CONTRACTS.md](docs/MCS_ACTION_CONTRACTS.md) for the exact request and response schemas for each tool.

---

## Step 3 - (Optional) REST API Connector

For Power Automate flows or non-MCP action steps, create a custom connector in Power Platform using [docs/CATALOG_REST_API.openapi.json](docs/CATALOG_REST_API.openapi.json). Use the same OAuth 2.0 credentials as the MCP connector.

Operations needed: SearchCatalogItems, GetCatalogItemForm, PlaceCatalogOrder

---

## Channel notes - Teams and Microsoft 365 Copilot: per-user "Open connection manager" prompt

When the agent is published to **Microsoft Teams** OR consumed via **Microsoft 365 Copilot** (web / Office app), the first time each user invokes a ServiceNow MCP tool they get an Adaptive Card that says:

> Let's get you connected first, and then I can find that info for you.
> [Open connection manager] to verify your credentials.
> Once the connection is ready, retry your request.

This is **expected behavior** for MCP tools added via the Copilot Studio **MCP wizard** (auto-provisioned `oauth2pkcewithprm` connector). On every Power-Platform-connected channel, the host honors the connector's `isSsoConnection: false` flag and falls back to the per-user connection manager prompt.

### If you need silent SSO with on-behalf-of (OBO): use a hand-authored custom MCP connector

The Copilot Studio MCP **wizard** does not yet support OBO. To get silent SSO today you have to hand-author a custom MCP connector with the `aad` identity provider plus OBO enabled, and wire a separate Entra "client" app distinct from the API resource app. This pattern is validated end-to-end against a sandbox tenant + a ServiceNow developer instance. See **[docs/CUSTOM_MCP_CONNECTOR_OBO.md](docs/CUSTOM_MCP_CONNECTOR_OBO.md)** for the full step-by-step recipe — including the AADSTS90009 ("Application is requesting a token for itself") fix when the connector's client id and resource uri point at the same Entra app.

### Why the wizard does not give you OBO

True silent SSO (the host gets a token for `1P_HOST_RESOURCE` and exchanges it for a token to your `ENTRA_CLIENT_ID` via OBO) requires all of the following, none of which the Copilot Studio MCP wizard wires up today:

- The connector provisioned with an SSO-capable identity provider (`aad`, not `oauth2pkcewithprm`).
- The agent's Entra **client** app distinct from the **resource** app (same-app trips AADSTS90009).
- The resource app pre-authorizes the client app for `access_as_user` (skips user consent prompts).
- For Teams: a Teams app manifest with `webApplicationInfo.id` = your `ENTRA_CLIENT_ID` and `webApplicationInfo.resource` = `api://<ENTRA_CLIENT_ID>`, published as a Teams app package.
- For M365 Copilot: equivalent declaration in the agent's M365 Copilot manifest.

The hand-authored custom connector path checks the first three boxes and is sufficient for both the Copilot Studio test pane and Teams (verified). It does not currently solve the M365 Copilot host on its own — that still needs the manifest-side declaration above.

### What the user actually experiences

- **Wizard-provisioned MCP connector**: first use → connection manager prompt → sign in → consent → silent thereafter for ~90 days.
- **Hand-authored custom MCP connector with OBO** (per [docs/CUSTOM_MCP_CONNECTOR_OBO.md](docs/CUSTOM_MCP_CONNECTOR_OBO.md)): first use → small "Allow" approval card on the very first tool invocation → silent thereafter. No "Open connection manager" prompt, no separate Entra sign-in popup.

### Workarounds (if the per-user prompt is unacceptable)

| Option | Trade-off |
|---|---|
| Accept the prompt (recommended) | Native per-user identity flows through to ServiceNow `requested_for`, full audit trail in both Entra and ServiceNow. One-time prompt per user per environment. |
| Shared service-account connection (admin creates one connection, shares with team) | Loses per-user identity. `requested_for` resolution falls back to the integration user. Reduces ServiceNow audit value. |
| Rebuild as a Custom Engine Agent (CEA) on Bot Framework with a Teams app manifest | Gains true Teams SSO and direct token control, but requires abandoning the no-code Copilot Studio authoring experience. Does NOT help for the M365 Copilot host. |
| Wait for MCP-SSO GA in Copilot Studio | No public timeline. |

### Verifying the connection state when a user reports repeated prompts

The connection record is stored once per user per Power Platform environment and is shared across hosts (Teams, M365 Copilot, web test pane). If a user reports the prompt every time:

1. **Settings > Connections** in Power Apps / Power Automate (signed in as the affected user) - look for the `ServiceNow MCP` connection. If status is `Error - Unauthenticated`, the refresh token is invalid; delete the connection and let the user re-create it from the next host prompt.
2. Check that `ENTRA_CLIENT_SECRET` on the Function App still matches an active secret on your MCP server's API Entra app (see [Troubleshooting > Connection popup closes instantly](#connection-popup-closes-instantly-no-entra-login-page-appears) below). A rotated/expired secret silently invalidates every user's refresh token.
3. Confirm the agent's orchestrator model is GPT-5+ or Claude Sonnet (see [Supported orchestrator models](#supported-orchestrator-models) above) - the wrong model can hide the actual auth flow behind generic "I cannot help" messages.

### Connection stability after the first prompt

Once the user signs in, the connection is silent in practice. Expected lifecycle:

| Trigger | Effect | Frequency |
|---|---|---|
| Normal use | Silent. Cached refresh token mints new access tokens automatically. | Forever |
| Access token expiry | Auto-refreshed. User sees nothing. | Hourly |
| Refresh token expiry | Re-consent prompt. | ~90 days **idle**. Users who invoke the agent at least monthly keep the refresh token alive indefinitely via a sliding window. |
| Entra app client secret rotated or expired | All users' refresh tokens invalidated. Every user is reprompted on next use. | Once per secret lifetime. Recommend 1-2 year secrets with a calendar reminder 2 weeks before expiry. |
| User revokes consent in [myapplications.microsoft.com](https://myapplications.microsoft.com) | That user is reprompted. | Rare, user-initiated only. |
| User leaves tenant or changes UPN | Connection invalidated. | When it happens. |
| Conditional Access policy adds step-up MFA | One-time re-auth for affected users. | When the admin changes policy. |
| Function App URL changes | Connector breaks; full reset needed. | Don't change it. |
| Custom connector definition edited in Power Apps | Existing connections survive but may need refresh. | Only when the operator edits it. |

**Practical summary**: configure once, expect ~99% silent operation, plan for one known reprompt event roughly once per year tied to Entra secret rotation. That is the practical ceiling Copilot Studio offers for this connector type today.

**Operational checklist**:

1. **Communicate the one-time prompt at rollout**: "First time you order something you'll be asked to connect ServiceNow; sign in once - silent for ~3 months after that."
2. **Calendar Entra secret rotation 30 days before expiry**. Send a maintenance notice for the reprompt event.
3. **Do not edit the custom connector definition in Power Apps** unless necessary - every edit is a risk surface.
4. **Monitor `connection.unauthenticated` errors in App Insights** so you spot a tenant-wide breakage immediately rather than via user complaints.

---

## Troubleshooting

### "Failed to login. Could not discover authorization server metadata"

Power Platform caches OIDC metadata when the connection is first created. If ENTRA_* variables were missing at that time, the cached metadata is empty/stale and login fails silently.

**Fix - delete and recreate the connection:**

1. Copilot Studio > **Tools** > ServiceNow MCP > **Remove**
2. **Settings > Connections** > delete the ServiceNow MCP entry
3. Power Platform Admin Center > confirm the connector is removed
4. Re-add the tool from scratch (Step 1 above)

Do this any time you change ENTRA_* configuration after the connection was first created.

### Connection popup closes instantly (no Entra login page appears)

1. Verify ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET are set in Function App application settings.
2. Confirm OIDC discovery returns 200:
   GET https://your-function-app.azurewebsites.net/.well-known/openid-configuration
3. Confirm unauthenticated POST /mcp returns 401 with a WWW-Authenticate header containing resource_metadata.

### Copilot Studio in a different Entra tenant than the Function App

1. Change the app registration Supported account types to Accounts in any organizational directory (Multi-tenant).
2. Add the Copilot Studio tenant to the trusted list:
   azd env set ENTRA_TRUSTED_TENANT_IDS "copilot-studio-tenant-guid"
   azd deploy
3. Have an admin in the Copilot Studio tenant grant consent:
   https://login.microsoftonline.com/TENANT_ID/adminconsent?client_id=ENTRA_CLIENT_ID

### Tools not visible after adding the connection

- Verify the function app is running (check Application Insights).
- Ensure the MCP URL has no trailing slash.
- Delete and recreate the connection.

### Adaptive Card shows but looks static / no select button visible

Symptom: `search_catalog_items` (or any tool returning a selection card) sends back a card that renders the title, description, and item containers, but no clickable "Select" affordance is visible — the user has no way to pick an item and the topic stays in "Working" state.

**Root cause**: the Copilot Studio web test pane (and some other Power Platform renderers) do not honor `Container.selectAction`. Older versions of `buildCatalogItemSelectionAdaptiveCard` relied solely on `selectAction` for the per-item submit — so the card looked interactive in Teams but appeared static in the Copilot Studio test pane.

**Fix**: as of the current build the selection card emits **both** `Container.selectAction` (for clients that support it) **and** explicit top-level `Action.Submit` buttons (one per item, labeled `Select: <itemName>`). Top-level actions are always rendered as visible buttons by every Copilot Studio renderer. If you see only a static card:

1. Verify your Function App is on a build that includes this fix — `grep "Select: " dist/utils/adaptiveCards.js` in the deployed zip.
2. If you customized the topic to read the submitted data, the new buttons emit the same `{ action: "select_catalog_item", itemSysId, itemName }` shape as before — no topic changes required.
3. Confirm the agent's orchestrator model is GPT-5 or Claude Sonnet (see [Supported orchestrator models](#supported-orchestrator-models)). GPT-4.1 rewrites cards as plain text and the buttons vanish along with the structure.

### Adaptive Card not interactive on first message after "Allow" prompt

Symptom: user clicks **Allow** on the MCP tool consent card, the tool call succeeds and returns a card, but the buttons on that card don't respond to clicks until the user types something else or clicks elsewhere in the chat.

This is a known limitation of the Copilot Studio test pane (not a bug in this MCP server). After approving the connection, the card payload arrives but the UI does not always rebind click handlers. **Workaround**: send any next message (even a space) to force a re-render, then the buttons work. Does not occur on the published Teams / M365 Copilot channels.
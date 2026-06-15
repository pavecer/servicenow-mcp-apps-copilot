# ServiceNow Ordering Runbook

This runbook describes how the Copilot Studio ordering topic works with Adaptive Cards and the ServiceNow MCP server.

**Setup**: See [COPILOT_STUDIO_SETUP.md](../COPILOT_STUDIO_SETUP.md) for adding the MCP tool and importing the ordering topic.

---

## Ordering Flow

The topic `[CTOP] - SnowMCP OrderCat.yaml` drives the ordering workflow end-to-end using only 4 MCP tool calls.

### 1. Search catalog items

The user types a search phrase. The topic calls `search_catalog_items` with that query.

The tool returns:
- `selectionAdaptiveCard` — an Adaptive Card listing matching items. The user taps one.
- `totalResults` and `items[]` for optional display logic.

### 2. Retrieve the order form

After the user selects an item, its `sys_id` is captured from the card submit action.

The topic calls `get_catalog_item_form` with the `sys_id`. The tool returns:
- `formAdaptiveCard` — an Adaptive Card containing all required variables for the item.
- `itemName` and `itemDescription` for display.

The card is sent to the user who fills out the fields and submits.

### 3. Place the order

The form submit payload (JSON string) is captured. The topic calls `place_order` with the `sys_id` and form values.

The tool returns:
- `confirmationAdaptiveCard` — shows the order number, request number, and summary.
- `requestNumber` and `requestItemNumber` for reference.

---

## Tool Schemas

Full input/output contracts: [docs/MCS_ACTION_CONTRACTS.md](MCS_ACTION_CONTRACTS.md)

---

## Adaptive Card Rendering

All Adaptive Cards are pre-rendered on the server and returned as JSON strings.
The Copilot Studio topic sends them using the **Send an adaptive card** message type.
No client-side card construction is needed.

- Cards follow Adaptive Card schema v1.5, compatible with Teams and Copilot Studio.
- The selection card uses `Action.Submit` with `data.selectedItemId` containing the sys_id.
- The form card uses `Action.Submit` with `data` containing all variable key/value pairs.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| No results from search | ServiceNow user lacks `catalog` role | Add `catalog` role (see docs/SERVICENOW_SETUP.md) |
| Form card is empty | Catalog item has no variables | Normal for items with no required fields |
| Order fails with 403 | ServiceNow user lacks `itil` role | Add `itil` role (see docs/SERVICENOW_SETUP.md) |
| Tool returns 401 | Entra token invalid or expired | Check COPILOT_STUDIO_SETUP.md troubleshooting |
| Adaptive Card not rendering, plain text shown instead | Agent is using **GPT-4.1** (or older GPT-4 variant) which does not render MCP Adaptive Cards | Switch the Copilot Studio agent model to **GPT-5+** or **Claude Sonnet** (Settings > Generative AI > Model). See [COPILOT_STUDIO_SETUP.md](../COPILOT_STUDIO_SETUP.md#supported-orchestrator-models). |
| Adaptive Card not rendering | Copilot Studio channel does not support cards | Verify the channel supports Adaptive Cards v1.5 |

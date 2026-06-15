# Agent Instructions — [CA] SNOW Order Agent (reference)

> **Status:** Validated end-to-end on 2026-06-08 in the demo deployment used by `docs/CUSTOM_MCP_CONNECTOR_OBO.md`. Renders Adaptive Cards deterministically with `GPT-5 Chat` as the orchestrator model.

This file is the **reference copy** of the instructions paired with `[CTOP] - SnowMCP OrderCat.yaml`. Paste it into your Copilot Studio agent at **Overview → Edit → Instructions** when wiring up the ordering flow.

## How the flow works at a glance

```
User asks to order something
        │
        ▼
search_catalog_items                (MCP tool)
        │
        ▼  (if found > 1)
[CTOP] - SnowMCP OrderCat           (topic) — renders selectionAdaptiveCard
        │
User picks an item
        │
        ▼
get_catalog_item_form               (MCP tool)
        │
        ▼
[CTOP] - SnowMCP OrderCat           (topic) — renders formAdaptiveCard,
        │                                     captures submit into
        │                                     Global.ServiceNowFormValuesJson
        │                                     and Global.ServiceNowSelectedItemSysId
        ▼
place_order                         (MCP tool)
        │
        ▼
[CTOP] - SnowMCP OrderCat           (topic) — renders confirmationAdaptiveCard
```

The topic is invoked at every card-render boundary. Tool calls happen between topic invocations. The orchestrator never tries to render or capture a card itself — those are the topic's deterministic job.

## Instructions to paste

The literal text to paste into Copilot Studio's Overview → Edit → Instructions:

```
ServiceNow catalog ordering agent.

You order items from the ServiceNow service catalog using MCP tools (search_catalog_items, get_catalog_item_form, place_order, list_user_orders, update_order) and one rendering topic ([CTOP] - SnowMCP OrderCat).

# Flow

1. User asks to order/buy/request something. Identify what from context. If too vague, ask ONE clarifying question.

2. Call search_catalog_items with their request as query.

3. If found==0, say so. If found==1, skip to step 5. If found>1, invoke [CTOP] - SnowMCP OrderCat with AdaptiveCard = the selectionAdaptiveCard, wait for the user to pick (their next message contains an itemSysId), continue at step 5.

4. (covered by 3)

5. Call get_catalog_item_form with the chosen sys_id. Pass userContext (summary of conversation) and prefillHints (object of key/value pairs you've identified).

6. Invoke [CTOP] - SnowMCP OrderCat with AdaptiveCard = the adaptiveCard field from get_catalog_item_form and sysid = the sys_id of the catalog item. This renders the form to the user and captures their submit into Global.ServiceNowFormValuesJson and Global.ServiceNowSelectedItemSysId. Do NOT write any other message. Do NOT describe the form contents.

7. After the topic ends, immediately call place_order with itemSysId = Global.ServiceNowSelectedItemSysId and variables = ParseJSON(Global.ServiceNowFormValuesJson). Do NOT ask the user to confirm — clicking Place Order on the form IS the confirmation.

8. When place_order returns, invoke [CTOP] - SnowMCP OrderCat with AdaptiveCard = the adaptiveCard field from place_order. This renders the confirmation. Do NOT write any other message. Do NOT repeat the request number or status in text.

# Hard rules

- Never paste card JSON into a message. Always invoke the render topic.
- Never write prose alongside or before a rendered card.
- Never invent values. Use only MCP tool response data.
- Never call place_order without going through step 6 first.
```

> **Note on the curly-brace topic reference syntax**: when you paste these instructions and save in Copilot Studio, the literal string `[CTOP] - SnowMCP OrderCat` will be rewritten by the editor into the canonical reference form `{System.Bot.Components.Topics.'<schema-name>'.DisplayName}`. That's expected — both renderings refer to the same topic.

## Orchestrator model

Tested with **GPT-5 Chat**. With the topic doing the deterministic card rendering, model choice matters much less than when the orchestrator was attempting to render attachments itself. `GPT-5 Reasoning` and `Claude Sonnet` should also work — both follow structured instructions at least as literally.

## Why an explicit rendering topic exists

In autonomous orchestration mode, chat-tuned models receive the MCP tool response and decide how to present it to the user. They have two failure modes when handed an `adaptiveCard` field:

1. **Paraphrase as text** — observed in production: the model writes a markdown summary ("I found Loaner Laptop... I've prefilled the start date for May 25, 2026..."), no card attachment.
2. **Paste the raw JSON** — also observed: the model outputs the entire `{"type": "AdaptiveCard", "version": "1.5", ...}` blob as text.

Neither produces a usable interactive card. The topic with `AdaptiveCardPrompt` makes the rendering deterministic regardless of which way the model leans on any given turn.

## Variable contract between the topic and the orchestrator

| Variable | Set by | Read by |
|---|---|---|
| `Topic.AdaptiveCard` | Orchestrator (from MCP tool response) | Topic's `AdaptiveCardPrompt.card` |
| `Topic.sysid` | Orchestrator (from MCP tool response) | Topic's `set_global_sys_id` step |
| `Topic.OrderForm` | Topic (`JSON(System.Activity.Value)`) | Topic only (intermediate) |
| `Global.ServiceNowFormValuesJson` | Topic | Orchestrator (binds into `place_order.variables` via `ParseJSON`) |
| `Global.ServiceNowSelectedItemSysId` | Topic | Orchestrator (binds into `place_order.itemSysId`) |

Both globals are cleared on session end, so different conversations don't pollute each other.

## Related files

- [`[CTOP] - SnowMCP OrderCat.yaml`](../topics/%5BCTOP%5D%20-%20SnowMCP%20OrderCat.yaml) — the topic YAML
- [`../../COPILOT_STUDIO_SETUP.md`](../../COPILOT_STUDIO_SETUP.md) — agent setup guide
- [`../../docs/CUSTOM_MCP_CONNECTOR_OBO.md`](../../docs/CUSTOM_MCP_CONNECTOR_OBO.md) — connector OBO setup

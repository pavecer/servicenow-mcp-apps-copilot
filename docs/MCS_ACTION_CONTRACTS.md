# Copilot Studio + MCP Action Contracts

This document defines the contract between Microsoft Copilot Studio topics and the ServiceNow MCP server tools in this repository.

These contracts are designed for:
- predictable topic branching,
- adaptive card rendering,
- robust order submission handling.

## 1. Envelope Convention for Topic Parsing

Current tool responses return MCP content in `content[0].text` as JSON text.

Topic pattern:
1. Capture `tool.content[0].text` to a string variable.
2. Parse JSON.
3. Branch on required fields.

If a tool call fails at connector level, use Copilot Studio action error branch and fallback topic.

## 2. Tool: search_catalog_items

Tool name: `search_catalog_items`

### Request

```json
{
  "query": "need a new laptop",
  "catalogSysId": "optional-catalog-sys-id",
  "categorySysId": "optional-category-sys-id",
  "limit": 10
}
```

### Response JSON (inside `content[0].text`)

```json
{
  "found": 2,
  "items": [
    {
      "sys_id": "1a2b3c",
      "name": "Standard Laptop",
      "short_description": "Corporate laptop request",
      "category": "Hardware",
      "categorySysId": "cat123",
      "catalog": "Employee Services",
      "catalogSysId": "scat123"
    }
  ],
  "selectionAdaptiveCard": {
    "type": "AdaptiveCard",
    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
    "version": "1.5",
    "body": [],
    "actions": []
  }
}
```

### Required fields for topic
- `found`
- `items[]`
- `selectionAdaptiveCard`

## 3. Tool: get_catalog_item_form

Tool name: `get_catalog_item_form`

### Request

```json
{
  "itemSysId": "1a2b3c"
}
```

### Response JSON

```json
{
  "itemSysId": "1a2b3c",
  "itemName": "Standard Laptop",
  "variableCount": 5,
  "adaptiveCard": {
    "type": "AdaptiveCard",
    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
    "version": "1.5",
    "body": [],
    "actions": [
      {
        "type": "Action.Submit",
        "title": "Place Order",
        "data": {
          "action": "place_order",
          "itemSysId": "1a2b3c"
        }
      }
    ]
  }
}
```

### Required fields for topic
- `itemSysId`
- `adaptiveCard`

## 4. Tool: place_order

Tool name: `place_order`

### Request

```json
{
  "itemSysId": "1a2b3c",
  "variables": {
    "requested_for": "john.doe@contoso.com",
    "business_justification": "Replacement device",
    "cost_center": "IT-001"
  },
  "quantity": 1,
  "requestedFor": "optional-user-id-or-email"
}
```

If `requestedFor` is omitted, the server derives `requested_for` from the authenticated Copilot caller (Entra `preferred_username`/`upn`) and attempts to resolve it to a ServiceNow user.

### Response JSON

```json
{
  "success": true,
  "requestNumber": "REQ0012345",
  "requestId": "abc123sysid",
  "adaptiveCard": {
    "type": "AdaptiveCard",
    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
    "version": "1.5",
    "body": [],
    "actions": []
  }
}
```

### Required fields for topic
- `success`
- `requestNumber`
- `adaptiveCard`

## 5. Recommended Topic Variables

- `correlationId` (generate once at flow start)
- `itemSearchResultsJson`
- `itemSelectionCardJson`
- `selectedItemSysId`
- `itemFormCardJson`
- `formSubmitPayloadJson`
- `orderResultJson`
- `operationStatus`
- `operationError`

## 6. Submit Payload Handling Rules

When the form card is submitted, payload includes:
- hidden fields from card `Action.Submit.data`
- user input fields from `Input.*`

Before calling `place_order`:
1. Remove transport/metadata fields (`action`, `itemSysId`).
2. Keep remaining key-value pairs as `variables`.
3. Preserve value types where possible (boolean/number/text).

## 7. Error and Fallback Strategy

- Search returns `found = 0`: ask user to refine intent.
- Form retrieval fails: ask user to select a different item or retry.
- Place order fails: route to fallback topic and collect minimal fields in text.
- Channel card limitation: fallback to question-based data collection.

## 8. Security and Reliability Notes

- Always validate required fields server-side before `place_order`.
- Do not trust item identifiers solely from client payload; revalidate item availability.
- Implement idempotency (future enhancement): include `idempotencyKey` in request metadata.
- Log correlation IDs in topic context and MCP traces for troubleshooting.

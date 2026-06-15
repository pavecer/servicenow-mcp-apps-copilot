# Copilot Studio Topic Contract Linter

Validates **Copilot Studio AdaptiveDialog** topics against card-rendering best practices and output binding contracts.

## Usage

```bash
# Run from workspace root
node local/lint-topics.mjs
```

or with npm script (after adding to package.json):

```bash
npm run lint:topics
```

## What it validates

✅ **Errors** (must fix before import):
- Topic is a valid `kind: AdaptiveDialog`
- `beginDialog:` section is present
- `AdaptiveCardPrompt` steps have `card:` property

⚠️ **Warnings** (best practices):
- `AdaptiveCardPrompt` steps capture output via `output: binding:`
- `BeginDialog` calls capture output for follow-up actions
- Variable names are descriptive (not `result`, `data`, `response`, etc.)
- Error handling/fallback paths present after `BeginDialog` calls
- Card payloads are not empty or suspicious

## Adding to package.json

```json
{
  "scripts": {
    "lint:topics": "node local/lint-topics.mjs"
  }
}
```

## Example output

```
🔍 Linting Copilot Studio topics from: /path/to/topic_samples

📋 Lint Results:
   Files scanned: 4
   Errors: 0
   Warnings: 0

✅ All topics pass contract validation!
```

## Integration

Before importing a topic into Copilot Studio:

1. Save topic YAML (exported from Copilot Studio) to `local/topic_samples/`
2. Run `npm run lint:topics`
3. Fix any errors (must-fix) and review warnings (best practices)
4. Import into Copilot Studio and test card rendering in test chat

**Exit codes:**
- `0` ✅ All checks pass: ready to import
- `1` ❌ Errors found: fix before import

---

## Topic Structure Checklist

For new Copilot Studio topics covering Adaptive Card rendering:

### ✅ Trigger & Intent
- [ ] `kind: AdaptiveDialog` at top level
- [ ] `modelDescription` documents trigger conditions
- [ ] `beginDialog:` → `intent:` with `triggerQueries`

### ✅ Prompt & Output Binding
- [ ] Each `AdaptiveCardPrompt` has unique `id`
- [ ] Card payload in `card:` property (not empty/blank)
- [ ] User input captured via `output: binding:` → `Topic.variableName`

### ✅ Data Retrieval & Parsing
- [ ] `BeginDialog` calls stored in output variable
- [ ] `ParseValue` converts action result to typed variable
- [ ] Variable names are descriptive (e.g., `Topic.search_result`, `Topic.hrsd_data`)

### ✅ Fallback & Error Handling
- [ ] `ConditionBranch` checks for null/empty responses
- [ ] Fallback `SendActivity` message if data unavailable
- [ ] Optional: Retry logic for failed service calls

---

## Zero Dependencies

This linter uses only Node.js built-ins (`fs`, `path`). No npm install needed.


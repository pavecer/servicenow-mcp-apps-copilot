# Local Development Guide

This guide covers building, testing, and troubleshooting the ServiceNow MCP server locally.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Local Settings

Copy the sample configuration and fill in your credentials:

```bash
cp local.settings.sample.json local.settings.json
```

Edit `local.settings.json` with your ServiceNow and Entra ID credentials:
- `SERVICENOW_INSTANCE_URL` — your ServiceNow instance URL
- `SERVICENOW_CLIENT_ID` / `SERVICENOW_CLIENT_SECRET` — from ServiceNow OAuth app
- `SERVICENOW_USERNAME` / `SERVICENOW_PASSWORD` — integration user credentials
- `ENTRA_TENANT_ID` / `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET` — from Entra app registration
- `ENTRA_AUTH_DISABLED=true` (default in sample) — allows local testing without a token

For details on each variable, see [CONFIG_REFERENCE.md](CONFIG_REFERENCE.md).

### 3. Build the Project

```bash
npm run build
```

This regenerates MCP Apps widgets and runs TypeScript compilation. **Always run this before testing** if you edited any widget HTML files.

### 4. Run Tests

```bash
npm test
```

Runs the full Vitest suite (247 tests, ~3–5 seconds). All tests must pass before committing.

To run a single test file:

```bash
npx vitest run test/logger.test.ts
```

## Running Locally

### Start the MCP Server

```bash
npm run start:dev
```

The server starts on `http://localhost:7071/mcp` and watches for file changes.

### Test Locally

In a separate terminal:

```bash
npm run smoke:test
```

This runs a smoke test against the local server, validating:
- MCP discovery (tools/list)
- Catalog search
- Order form retrieval
- Order placement
- Order list

**Expected output:**
```
✓ /mcp/tools/list
✓ /mcp/tools/call (search_catalog_items)
✓ /mcp/tools/call (get_catalog_item_form)
✓ /mcp/tools/call (place_order)
...
All tests passed!
```

### Test Against Deployed Function App

Once deployed to Azure:

```bash
# Get an Entra access token
$token = az account get-access-token --resource api://<ENTRA_CLIENT_ID> --query accessToken -o tsv

# Test the deployed endpoint
$env:MCP_ENDPOINT_URL = "https://<function-app>.azurewebsites.net/mcp"
$env:ENTRA_BEARER_TOKEN = $token
npm run smoke:test
```

## Direct ServiceNow Testing

For faster iteration on ServiceNow API calls (bypassing MCP and Azure Functions):

```bash
npm run sn:local -- validate
npm run sn:local -- search "laptop" 5
npm run sn:local -- form 04b7e94b4f7b4200086eeed18110c7fd
npm run sn:local -- orders --upn=alice@contoso.com
npm run sn:local -- order <itemSysId> '{"justification":"test"}' --confirm --upn=alice@contoso.com
```

**Flags:**
- `--upn=<user@domain>` — simulates caller identity (required for order-related operations)
- `--confirm` — confirms order creation (use carefully, creates real ServiceNow requests)
- Environment variables override `local.settings.json`

**Output:** Raw JSON (pipe through `ConvertFrom-Json` or `jq` for readability)

## Debugging

### Enable Debug Logging

Edit `local.settings.json`:

```json
{
  "Values": {
    "LOG_LEVEL": "debug",
    "LOG_INCLUDE_CALLER_IDENTITY": "true",
    "LOG_INCLUDE_ERROR_STACK": "true"
  }
}
```

Then restart the server.

### Common Issues

| Issue | Solution |
|-------|----------|
| **401 on /mcp** | `ENTRA_AUTH_DISABLED=true` in `local.settings.json`; Bearer validation is on by default |
| **ServiceNow auth fails** | Verify `SERVICENOW_INSTANCE_URL`, `SERVICENOW_CLIENT_ID`, and `SERVICENOW_CLIENT_SECRET` are correct |
| **Tests fail with "cannot find module"** | Run `npm run build` first to regenerate widgets |
| **Port 7071 in use** | Change `functionAppPort` in `.vscode/tasks.json` or kill the existing process |

### See Full Details

For deeper troubleshooting, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Code Organization

```
src/
  app.ts                 Express app + route setup
  server.ts              MCP server + tool registration
  tools/                 Individual MCP tools (one file per tool)
  services/
    servicenowClient.ts  ServiceNow REST API client
    tokenManager.ts      OAuth token caching + refresh
    entraTokenValidator.ts Entra Bearer validation
  ui/
    widgets.ts           MCP Apps widget registry
    widgets/src/         Widget source HTML (inline CSS + JS)
    widgets/generated/   Build output (gitignored)
  utils/
    logger.ts            Structured logging (with secret redaction)
    entraAuthMiddleware.ts Auth middleware for /mcp endpoint

test/
  *.test.ts              Vitest test suites
  fixtures/              Mock data and test constants
```

## Build & Publish Flow

| Step | Command | Output |
|------|---------|--------|
| **Clean** | `npm run clean` | Removes `dist/`, `*.js`, `*.d.ts` |
| **Build widgets** | `npm run build:widgets` | Regenerates `src/ui/widgets/generated/` |
| **Compile TS** | `tsc` | Produces `.js` and `.d.ts` files |
| **Both** | `npm run build` | Runs clean + build:widgets + tsc |
| **Test** | `npm test` | Runs Vitest suite |
| **Watch** | `npm run watch` | Re-runs build on file changes |

## Git Workflow

Before committing:

1. `npm run build` — regenerate code
2. `npm test` — all tests must pass
3. `git add -A && git commit -m "..."` — commit changes

See [CONTRIBUTING.md](../CONTRIBUTING.md) for full contributor guidelines.

# Runbook 02: AI Gateway tier and MCP server

Executed 2026-10-15 in the AI Gateway portal (preview). ARM resource type
`Microsoft.ApiManagement/aigateways`, API `2026-09-01-preview`.

## 1. Create the gateway

1. Sign in to the AI Gateway portal, **Create gateway**.
2. Subscription the lab tenant, resource group `rg-snowmcp-gwlab`, name
   `snowmcp-gwlab-aigw`. **Change region** from the default East US 2 to
   Sweden Central (12 (local: `screenshots/12-aigw-create-dialog-defaults.png`)).
3. Create. The UI says 8-10 minutes; it took about 1 minute.

## 2. Add MCP server `servicenow`

1. MCP servers > **Add MCP server** > existing MCP server backend.
2. Backend URL: `https://<function-host>/mcp`. Backend auth: **None** for the
   identity tests (18-22). Options seen: None, API key
   (header/query), OAuth 2.0, managed identity.
3. Tools step: **Allow all tools** (no static-list option exists, see findings 5.4).
4. Display name `ServiceNow (lab)`.

## 3. Caller access

- **Keys**: Access > API keys > create `lab-harness`. Keys are gateway-wide.
  Store the key and the MCP URL in `.azure/snowmcp-gwlab/lab.env`
  (`LAB_GATEWAY_MCP_URL`, `LAB_GATEWAY_API_KEY`), never in git.
- **Entra**: Access > Entra ID > Add > role **AI Gateway Tools User** at the
  MCP server scope. If directory search requests extra consent, paste the
  object ID. Token: `az account get-access-token --scope https://azure-api.net/aigateway/Data.All`.

Never send `api-key` and `Authorization` together: the gateway returns 400.

## 4. Tests (Track A/B)

```powershell
$h = 'scripts/lab/ai-gateway/run-experiments.mjs'
node $h --scenario list --target gateway --no-bearer --label A1
node $h --scenario B1 --target gateway --no-bearer
node $h --scenario B2 --target gateway --no-bearer
node $h --scenario call --target gateway --no-bearer --tool search_catalog_items --args '{"query":"laptop"}' --label A2-keyonly
```

## 5. Governance on the gateway (Track C)

- **Tool block**: MCP server > Edit > Tools > Blocked tools > add
  `report_incident` > Save (36-39). Measure with
  `--scenario poll --poll 15 --timeout 900`.
- **Rate limit**: Policies > Add policy > Request rate limit, scope MCP server
  `servicenow`, 5 calls / 60 s per caller identity (40-44).
  Test with `--scenario burst --n 12`.

## 6. Backend header for D3

Edit MCP server > backend auth **API key**, header `X-Gateway-Key`. Set the
real value outside the portal so it is never displayed. Do **not** print an
ARM `PUT` response: it echoes the header value in plaintext. Header values are
arrays: `{"type":"header","headers":{"X-Gateway-Key":["<value>"]}}`.

# Cost Estimation

> **Disclaimer.** All numbers below are **public list prices as of mid-2026, in USD, for West Europe** (the default region used by `infra/main.bicep`). Real bills will differ based on region, Enterprise Agreement / CSP discounts, currency, taxes, and actual traffic. Treat the formulas as a planning aid, not a quote. Always reconcile against the [Azure Pricing Calculator](https://azure.microsoft.com/pricing/calculator/) before quoting a customer.

This document covers the **Azure infrastructure** that hosts the MCP server (Function App, Storage, Key Vault, monitoring, etc.).

> **Note on agent-host / messaging costs.** Whatever client or agent host invokes this MCP server (Microsoft 365 Copilot, an IDE MCP client, a custom app, etc.) may have its own licensing or per-message billing. Those costs depend entirely on the host you choose and are **out of scope** for this document — price them against that host's current pricing sheet.

---

## TL;DR for a typical mid-size deployment

A **medium-traffic deployment** (≈500 daily active users, each placing one ticket per workday, plus a similar volume of read-only catalog browsing) lands at roughly **$25 – $60/month** of Azure infrastructure — almost entirely Function App execution + Log Analytics ingestion.

Per-tool unit costs (Azure-only, list, West Europe, mid-2026):

| MCP tool | Backend cost per invocation | Notes |
|---|---|---|
| `validate_servicenow_config` | **~$0.0000005** | Single config read, no ServiceNow call |
| `search_catalog_items` | **~$0.0001 – $0.0003** | One ServiceNow REST query, small response |
| `get_catalog_item_form` | **~$0.0003 – $0.0008** | One ServiceNow REST call returning the full variable schema; larger payload |
| `place_order` | **~$0.0005 – $0.0010** | Two ServiceNow calls: order submit + read-back |
| `list_user_orders` | **~$0.0002 – $0.0005** | One ServiceNow REST query |
| `update_order` | **~$0.0003 – $0.0006** | One PATCH against the order record |

The Azure infrastructure bill is **flat and small** for any realistic ServiceNow ticketing workload — the MCP server itself is not a cost driver.

---

## 1. Azure infrastructure cost model

### What gets deployed

The `infra/main.bicep` provisions:

| Resource | SKU | Pricing meter |
|---|---|---|
| Azure Functions (host) | **Flex Consumption** (`FC1`) | Per-GB-second of execution + per-execution + always-ready instances if any |
| Storage account | `Standard_LRS`, StorageV2 | Per-GB-month + per-10k transactions |
| Key Vault | `standard` | Per-10k operations |
| Application Insights | Connected to Log Analytics workspace `PerGB2018` | Per-GB ingested (after free tier) |
| Log Analytics workspace | `PerGB2018` (Pay-As-You-Go) | Per-GB ingested, 30-day retention default |

There is no App Service Plan to pre-pay for — Flex Consumption is pure consumption-based once you stay within the default scaling configuration.

### Per-call cost breakdown (Flex Consumption + dependencies)

Each tool invocation is a single HTTP POST to `/mcp`. Empirical timings against the production-shaped deployment used during the OBO rollout:

| Stage | Typical duration | Notes |
|---|---|---|
| JWT validation + audience check | ~10 ms | In-memory after first cache hit |
| OBO token exchange (if enabled) | ~150-300 ms | One outbound call to Entra; cached per user for ~50 minutes |
| ServiceNow REST call | ~200-800 ms | The wall-clock dominates the per-call cost; depends on instance load |
| Response serialization | ~10-30 ms | Adaptive Card rendering for selection/form/confirmation cards |

So a typical tool call spends **400-1000 ms** of Functions execution time at ~256 MB of memory.

#### Flex Consumption pricing (Linux, West Europe, list)
- **$0.000016 per GB-second** of execution time
- **$0.20 per million executions**

A 256 MB / 700 ms call ≈ 0.256 × 0.700 = **0.179 GB-seconds** → ~**$0.0000029** per call.
Plus **$0.0000002** per call for the execution count.
**Total per call: ~$0.0000031** (~3 millionths of a dollar).

#### Plus ServiceNow side-effect costs (Azure-side)
- Outbound bandwidth (egress) is **free** within the same region; out-of-region or cross-cloud charges $0.087/GB. ServiceNow calls are typically <10 KB so even cross-region this is <$0.000001/call.
- Key Vault references are cached in the Function App after first cold read, so KV ops are bounded at ~1-10 per cold start, not per call.
- App Insights ingestion: a typical tool invocation logs ~3-5 KB of telemetry. At **$2.30/GB** beyond the 5 GB/month free tier, that's ~$0.0000115 per call once you've blown through the free quota.

**Bottom-line per-call infrastructure cost: $0.0001 to $0.001** depending on telemetry verbosity and ServiceNow round-trip payload size. The dominant variable is App Insights ingestion if you've enabled verbose logging.

### Always-on baseline cost (no traffic)

Even with zero invocations, the following monthly charges accrue:

| Component | Monthly (USD, list) |
|---|---|
| Key Vault (3 secrets, ~0 ops/month) | **<$0.05** (essentially $0) |
| Storage account (50 MB of deployment artifacts) | **~$0.02** |
| Application Insights / Log Analytics (telemetry from the always-ready Function instance) | **$0 – $5** (covered by the 5 GB/month free tier in most cases) |
| Flex Consumption "always-ready" instances | **$0** if you keep `alwaysReady=0` (the default in `main.bicep`) |
| **Total cold baseline** | **~$0 – $5/month** |

In other words: an MCP server with no traffic at all costs essentially nothing.

### Cost scenarios (Azure only)

Assumptions: 22 working days/month, 8 hours/working day, each user makes the listed number of tool calls. Each "ticket" = 1 search + 1 form + 1 place_order = 3 tool calls (~2.1 GB-seconds, ~15 KB of telemetry).

| Scenario | Users | Tool calls/month | Functions exec | Telemetry | Other | **Total/month (USD, list)** |
|---|---|---|---|---|---|---|
| Demo / pilot | 10 | ~660 | <$0.01 | <$0.10 | $5 | **~$5** |
| Small team | 100 | ~6,600 | ~$0.05 | ~$0.50 | $5 | **~$6** |
| Medium org | 500 | ~33,000 | ~$0.25 | ~$2 | $5 | **~$8** |
| Large org | 2,000 | ~132,000 | ~$1 | ~$8 | $5 | **~$15** |
| Enterprise | 10,000 | ~660,000 | ~$5 | ~$40 | $10 | **~$55** |

The Azure infrastructure bill is **flat and small** for any realistic ServiceNow ticketing workload. The MCP server itself is not a cost driver.

### How to keep Azure costs low

1. **Leave `alwaysReady` at 0** in Flex Consumption (the default in `infra/main.bicep`). Pay-per-execution is the most efficient model for bursty traffic.
2. **Set `LOG_LEVEL=info`, not `debug`**, in production. Debug logging can 10x your App Insights ingestion bill.
3. **Configure App Insights sampling** at 5-10% for very high traffic deployments (above 100k calls/month). The free 5 GB/month covers up to ~150k calls at info level.
4. **Set a budget alert** on the resource group at e.g. $50/month. The cost should never exceed it.
5. **Use a single regional deployment** unless you genuinely need geo-redundancy. ServiceNow itself is the bottleneck for latency, not the MCP server.

---

## 2. Full-stack worked examples (Azure only)

### Example A — Pilot deployment (10 users, 2 weeks of validation)

- **Tool calls**: ~200 across all tools
- **Tickets placed**: ~20

| Surface | Cost |
|---|---|
| Azure infrastructure | **~$3 – $5** |
| **Total** | **~$5 for the pilot** |

### Example B — Production rollout, 500 users

- **Tool calls**: ~6,000/month
- **Tickets placed**: ~2,000/month

| Surface | Cost |
|---|---|
| Azure infrastructure | **~$8/month** |
| **Total** | **~$8/month** for the integration |

### Example C — Enterprise, 10,000 users

- **Tool calls**: ~120,000/month
- **Tickets placed**: ~40,000/month

| Surface | Cost |
|---|---|
| Azure infrastructure | **~$55/month** |
| **Total** | **~$55/month** |

The Azure side stays a rounding error even at enterprise scale; the dominant cost driver in any deployment is whatever agent host / licensing you put in front of the MCP server (out of scope here).

---

## 3. Field-friendly rule of thumb

If a customer asks "what does the Azure side cost per transaction?", the safe answer in mid-2026 is:

- **Azure side**: rounding error. Less than $0.001 per tool call. Less than $10/month for any realistic deployment, under ~$55/month at enterprise scale.
- **Agent-host / messaging side**: depends entirely on the host (Microsoft 365 Copilot license, an IDE MCP client, a custom app, etc.). Price it against that host's current pricing sheet.

---

## 4. Where these numbers come from

- **Azure pricing meters**: [Azure Functions pricing](https://azure.microsoft.com/pricing/details/functions/), [Storage](https://azure.microsoft.com/pricing/details/storage/blobs/), [Key Vault](https://azure.microsoft.com/pricing/details/key-vault/), [Log Analytics](https://azure.microsoft.com/pricing/details/monitor/), [Bandwidth](https://azure.microsoft.com/pricing/details/bandwidth/) — all checked against the West Europe rate card.
- **Empirical timings**: production-shaped deployment in the tenant where the OBO rollout was validated (see `docs/AUTH_ENTRA_OBO_OKTA.md`). Wall-clock per call measured via App Insights, with the ServiceNow round-trip being the dominant component.

---

## 5. Disclaimer (read this before quoting a customer)

Everything above is a **planning aid**, not a binding price. In particular:

1. **Regional pricing differs.** West Europe is used as the reference. North Europe, US, and Asia regions vary by 0-30% on most meters.
2. **Enterprise Agreement / CSP discounts.** Azure list prices can be discounted 10-40% via volume agreements. The numbers here are list (un-discounted).
3. **Taxes and currency.** Numbers exclude VAT/GST/sales tax. Customers in non-USD regions will see local-currency conversion deltas.
4. **Workload assumptions.** The "ticket = 3 tool calls" pattern assumes the agent is well-designed. Profile your own traffic before scaling.

When in doubt, run the [Azure Pricing Calculator](https://azure.microsoft.com/pricing/calculator/) for the Azure side.

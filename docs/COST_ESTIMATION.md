# Cost Estimation

> **Disclaimer.** All numbers below are **public list prices as of mid-2026, in USD, for West Europe** (the default region used by `infra/main.bicep`). Real bills will differ based on region, Enterprise Agreement / CSP discounts, currency, taxes, and actual traffic. Treat the formulas as a planning aid, not a quote. Always reconcile against the [Azure Pricing Calculator](https://azure.microsoft.com/pricing/calculator/) and your tenant's current Microsoft 365 / Copilot Studio price sheet before quoting a customer.

This document covers two cost surfaces:

1. **Azure infrastructure** that hosts the MCP server (Function App, Storage, Key Vault, monitoring, etc.)
2. **Microsoft Copilot Studio messages** consumed when an agent invokes one of this server's tools

---

## TL;DR for a typical mid-size deployment

A **medium-traffic deployment** (≈500 daily active users, each placing one ticket per workday, plus a similar volume of read-only catalog browsing) lands at roughly:

| Surface | Monthly cost (USD, list) | Notes |
|---|---|---|
| Azure infrastructure | **$25 – $60** | Almost entirely Function App execution + Log Analytics ingestion |
| Copilot Studio messages | **$250 – $500** if billed at PAYG / standalone; **$0** if all users are licensed for Microsoft 365 Copilot | See "Copilot Studio cost" section for the messages-per-ticket math |
| **Total** | **$275 – $560** PAYG / **$25 – $60** if M365 Copilot-licensed | Per month, list, before discounts |

Per-tool unit costs (Azure-only, list, West Europe, mid-2026):

| MCP tool | Backend cost per invocation | Notes |
|---|---|---|
| `validate_servicenow_config` | **~$0.0000005** | Single config read, no ServiceNow call |
| `search_catalog_items` | **~$0.0001 – $0.0003** | One ServiceNow REST query, small response |
| `get_catalog_item_form` | **~$0.0003 – $0.0008** | One ServiceNow REST call returning the full variable schema; larger payload |
| `place_order` | **~$0.0005 – $0.0010** | Two ServiceNow calls: order submit + read-back |
| `list_user_orders` | **~$0.0002 – $0.0005** | One ServiceNow REST query |
| `update_order` | **~$0.0003 – $0.0006** | One PATCH against the order record |

Adding **Copilot Studio messages** (when billed PAYG / standalone) typically dominates the bill by 5-10x — see the Copilot Studio section below.

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

Each tool invocation is a single HTTP POST to `/api/mcp`. Empirical timings against the production-shaped deployment used during the OBO rollout:

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

## 2. Microsoft Copilot Studio cost model

This is where most deployments will see real money.

> **Important.** Copilot Studio billing terms changed multiple times during 2024–2026. As of mid-2026 the **messages** model still applies, but **autonomous / generative** features and **MCP tool calls** consume more messages than classic topic-driven flows. The numbers below are the best-effort current public list prices; **always cross-check the [official Copilot Studio pricing page](https://www.microsoft.com/microsoft-copilot/microsoft-copilot-studio/pricing) for your tenant before committing to a customer quote**.

### Licensing models

Three ways customers pay for Copilot Studio messages:

| Model | Effective per-message cost (USD) | Best fit |
|---|---|---|
| **Microsoft 365 Copilot license** (~$30/user/month) | **$0 incremental** — agent usage by licensed users does not draw from messages | Most enterprise deployments, especially if M365 Copilot is already rolling out |
| **Copilot Studio standalone** ($200/tenant/month for 25,000 messages) | **~$0.008/message** | Standalone tenants, or to cover non-M365-Copilot-licensed users (front-line workers, contractors) |
| **Pay-As-You-Go** (Azure subscription, no commitment) | **~$0.01/message** | Variable load, validation phases, environments without monthly commitment |

The "$.04 per form lookup / $.06 per catalog write" rule-of-thumb mentioned in some field conversations is consistent with the PAYG model **once you include all messages a single tool call actually consumes** (see below).

### How many messages a single MCP tool call consumes

The Copilot Studio pricing model bills **messages**, not raw tool calls. As of mid-2026, the message-counting rules that matter for an MCP tool call are roughly:

| Action | Messages billed |
|---|---|
| User sends a chat turn that triggers a topic (no AI) | **1** |
| Topic runs without generative answers | **1** |
| Generative answers / autonomous reasoning step (LLM call) | **~2** per LLM step |
| **MCP tool call via custom connector (with OBO)** | **~10 messages** per call (autonomous-style billing — the orchestrator's planning + the tool invocation + the response synthesis are billed together) |
| Adaptive Card sent back to user | **0 incremental** (part of the topic/tool response) |

This is the same "autonomous action" multiplier Microsoft applies to other AI-augmented connectors. Each MCP tool call (search, get-form, place-order) consumes **roughly 10 messages** end-to-end when invoked via an autonomous-style agent.

### Per-operation cost (Copilot Studio, PAYG basis)

Using ~10 messages per MCP tool call at ~$0.01/message (PAYG):

| User-facing operation | MCP tool calls | Messages billed | **Cost per operation (PAYG)** |
|---|---|---|---|
| Browse catalog (search only) | 1 (`search_catalog_items`) | ~10 | **~$0.10** |
| Look up an order form (search + get_form) | 2 | ~20 | **~$0.20** |
| Place a complete order (search + form + place) | 3 | ~30 | **~$0.30** |
| Check on an existing order | 1 (`list_user_orders`) | ~10 | **~$0.10** |
| Update / cancel an order | 2 (`list` + `update`) | ~20 | **~$0.20** |

**Same operations on the standalone Copilot Studio license** ($200 / 25,000 messages = ~$0.008/message): multiply the above by 0.8 (≈$0.08 search, ≈$0.24 full order).

**Same operations under a Microsoft 365 Copilot license**: **$0 incremental** to the agent owner; the user's $30/month covers their usage.

### Cost scenarios (Copilot Studio messages, PAYG basis)

Assuming the "ticket = 3 tool calls = ~30 messages" pattern dominates, plus ~5 messages of conversational overhead per session:

| Scenario | Tickets placed/month | Messages billed | **PAYG cost/month** | **Standalone cost/month** | **M365 Copilot license cost** |
|---|---|---|---|---|---|
| Demo / pilot | 200 | ~7,000 | **~$70** | **~$56** | $0 (if users licensed) |
| Small team (100 users, ~1 ticket/week) | 400 | ~14,000 | **~$140** | **~$112** | $0 |
| Medium org (500 users, ~1 ticket/week) | 2,000 | ~70,000 | **~$700** | $200 base + 1.8x overage ≈ **~$560** | $0 |
| Large org (2,000 users, ~1 ticket/week) | 8,000 | ~280,000 | **~$2,800** | $200 × 12 capacity packs ≈ **~$2,400** | $0 |

These numbers can shift up or down by ~2x depending on how chatty the agent's topic design is — every extra "did I get that right?" confirmation step adds another billed message.

### How to keep Copilot Studio costs low

1. **License via Microsoft 365 Copilot if the audience is already on M365 E3/E5 + Copilot**. This zeros out the incremental cost.
2. **Avoid unnecessary tool calls** in the topic design. For example, use the `selectionAdaptiveCard` returned by `search_catalog_items` directly instead of calling `search` twice — that's a 10-message saving per session.
3. **Pre-filter the user request before calling MCP**. If you can validate intent inside the topic ("did the user ask for something we even offer?") you can avoid spending 10 messages on a `search` that will return no results.
4. **For high-volume, low-margin operations**, consider whether the topic should call a deterministic Power Automate flow (which is cheaper per message) instead of routing through the autonomous orchestrator.
5. **Monitor message consumption via Power Platform Admin Center → Analytics → Capacity**. Set alerts at 70%, 85%, and 95% of your monthly cap.

---

## 3. Full-stack worked examples

### Example A — Pilot deployment (10 users, 2 weeks of validation)

- **Tool calls**: ~200 across all 6 tools
- **Tickets placed**: ~20
- **Messages**: ~600

| Surface | Cost |
|---|---|
| Azure infrastructure | **~$3 – $5** |
| Copilot Studio (PAYG) | **~$6** |
| **Total** | **~$10 for the pilot** |

### Example B — Production rollout, 500 users, all M365 Copilot-licensed

- **Tool calls**: ~6,000/month
- **Tickets placed**: ~2,000/month
- **Messages**: ~70,000/month — covered by user licenses

| Surface | Cost |
|---|---|
| Azure infrastructure | **~$8/month** |
| Copilot Studio messages | **$0 incremental** (covered by M365 Copilot) |
| **Total** | **~$8/month** for the integration |

### Example C — Production rollout, 500 users, standalone Copilot Studio

- Same traffic as Example B
- **Messages**: ~70,000/month → 1.8 standalone packs

| Surface | Cost |
|---|---|
| Azure infrastructure | **~$8/month** |
| Copilot Studio standalone (2 packs at $200 each) | **~$400/month** |
| **Total** | **~$408/month** |

### Example D — Enterprise, 10,000 users, PAYG

- **Tool calls**: ~120,000/month
- **Tickets placed**: ~40,000/month
- **Messages**: ~1.4M/month

| Surface | Cost |
|---|---|
| Azure infrastructure | **~$55/month** |
| Copilot Studio (PAYG at $0.01/msg) | **~$14,000/month** |
| **Total** | **~$14,055/month** |

At this scale, licensing optimization (move to M365 Copilot licenses or buy bulk standalone packs) typically reduces the bill by 5-10x.

---

## 4. Field-friendly rule of thumb

If a customer asks "what does this cost per transaction?", the safe answer in mid-2026 is:

- **Azure side**: rounding error. Less than $0.001 per tool call. Less than $10/month for any realistic deployment.
- **Copilot Studio side**:
  - **$0** if users are licensed for Microsoft 365 Copilot.
  - **~$0.30 per ticket placed end-to-end** at PAYG list price (search + form + submit + confirmation = ~30 messages × $0.01).
  - **~$0.20 per ticket placed end-to-end** at standalone Copilot Studio list price.
  - Confirm the message-count multiplier against your tenant's current Power Platform Admin Center → Analytics → Capacity dashboard — Microsoft tweaks the counting rules periodically.

---

## 5. Where these numbers come from

- **Azure pricing meters**: [Azure Functions pricing](https://azure.microsoft.com/pricing/details/functions/), [Storage](https://azure.microsoft.com/pricing/details/storage/blobs/), [Key Vault](https://azure.microsoft.com/pricing/details/key-vault/), [Log Analytics](https://azure.microsoft.com/pricing/details/monitor/), [Bandwidth](https://azure.microsoft.com/pricing/details/bandwidth/) — all checked against the West Europe rate card.
- **Empirical timings**: production-shaped deployment in tenant where the OBO rollout was validated (see `docs/CUSTOM_MCP_CONNECTOR_OBO.md`). Wall-clock per call measured via App Insights, with the ServiceNow round-trip being the dominant component.
- **Copilot Studio pricing**: the [official Copilot Studio pricing page](https://www.microsoft.com/microsoft-copilot/microsoft-copilot-studio/pricing) and the message-counting rules published in [Copilot Studio capacity documentation](https://learn.microsoft.com/microsoft-copilot-studio/requirements-messages-management). The per-MCP-call message multiplier is an empirical observation as of mid-2026; expect this to shift as Microsoft formalizes MCP billing.

---

## 6. Disclaimer (read this before quoting a customer)

Everything above is a **planning aid**, not a binding price. In particular:

1. **Microsoft changes Copilot Studio pricing periodically.** The message-counting model for MCP/autonomous tool calls has been adjusted multiple times in the last 18 months. Always pull the current `Power Platform Admin Center → Analytics → Capacity` reading from a representative test session before quoting.
2. **Regional pricing differs.** West Europe is used as the reference. North Europe, US, and Asia regions vary by 0-30% on most meters.
3. **Enterprise Agreement / CSP discounts.** Both Azure and Microsoft 365 list prices can be discounted 10-40% via volume agreements. The numbers here are list (un-discounted).
4. **Taxes and currency.** Numbers exclude VAT/GST/sales tax. Customers in non-USD regions will see local-currency conversion deltas.
5. **Workload assumptions.** The "ticket = 3 tool calls" pattern assumes the agent is well-designed. A topic that triggers `search_catalog_items` on every user turn can easily 5x the message count. Profile your own topic before scaling.

When in doubt, run the [Azure Pricing Calculator](https://azure.microsoft.com/pricing/calculator/) for the Azure side and the Copilot Studio capacity calculator (or your CSP's quote tool) for the Copilot Studio side.

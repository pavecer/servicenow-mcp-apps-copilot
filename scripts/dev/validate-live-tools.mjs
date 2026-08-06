#!/usr/bin/env node

/**
 * Validate that a deployed MCP endpoint exposes required tools for M365 Copilot testing.
 *
 * Usage:
 *   node scripts/dev/validate-live-tools.mjs --endpoint https://<host>/mcp
 *
 * Optional:
 *   --function-key <key>
 */

const REQUIRED_TOOLS = [
  "search_catalog_items",
  "get_catalog_item_form",
  "get_order_detail",
  "approve_order_approval",
  "reject_order_approval"
];

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return "";
  return process.argv[idx + 1] ?? "";
}

const endpointBase = getArg("--endpoint") || process.env.MCP_ENDPOINT_URL || "";
const functionKey = getArg("--function-key") || process.env.FUNCTION_KEY || "";

if (!endpointBase) {
  console.error("Missing endpoint. Provide --endpoint or MCP_ENDPOINT_URL.");
  process.exit(2);
}

const endpointUrl = new URL(endpointBase);
if (functionKey) {
  endpointUrl.searchParams.set("code", functionKey);
}

let nextId = 1;

async function postJson(payload) {
  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream"
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

async function main() {
  console.log(`Validating MCP endpoint: ${endpointUrl.toString()}`);

  await postJson({
    jsonrpc: "2.0",
    id: nextId++,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "copilot-ready-validator", version: "1.0.0" }
    }
  });

  const listResult = await postJson({
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/list",
    params: {}
  });

  if (listResult.error) {
    throw new Error(`tools/list error: ${JSON.stringify(listResult.error)}`);
  }

  const tools = listResult?.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error("tools/list returned no tools array.");
  }

  const names = new Set(tools.map((t) => String(t?.name || "")));
  const missing = REQUIRED_TOOLS.filter((name) => !names.has(name));

  if (missing.length) {
    throw new Error(`Missing required tools: ${missing.join(", ")}`);
  }

  console.log("Live validation passed.");
  console.log(JSON.stringify({
    endpoint: endpointUrl.origin + endpointUrl.pathname,
    toolCount: tools.length,
    checked: REQUIRED_TOOLS,
    readyForM365PromptTest: true
  }, null, 2));
}

main().catch((error) => {
  console.error("Live validation failed.");
  console.error(error?.message || String(error));
  process.exit(1);
});

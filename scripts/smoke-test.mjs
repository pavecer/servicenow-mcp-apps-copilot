#!/usr/bin/env node

const endpointBase = process.env.MCP_ENDPOINT_URL || "http://localhost:7071/mcp";
const functionKey = process.env.FUNCTION_KEY || "";
const entraBearerToken = process.env.ENTRA_BEARER_TOKEN || "";
const searchQuery = process.env.SEARCH_QUERY || "laptop";
const explicitItemSysId = process.env.ITEM_SYS_ID || "";
const requestedFor = process.env.REQUESTED_FOR || "";
const variablesJson = process.env.ORDER_VARIABLES_JSON || "{}";

let orderVariables;
try {
  orderVariables = JSON.parse(variablesJson);
} catch (error) {
  console.error("ORDER_VARIABLES_JSON must be valid JSON.");
  process.exit(1);
}

if (typeof orderVariables !== "object" || orderVariables === null || Array.isArray(orderVariables)) {
  console.error("ORDER_VARIABLES_JSON must be a JSON object.");
  process.exit(1);
}

const endpointUrl = new URL(endpointBase);
if (functionKey) {
  endpointUrl.searchParams.set("code", functionKey);
}

let nextId = 1;

async function postJson(payload) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream"
  };

  if (entraBearerToken) {
    headers["Authorization"] = `Bearer ${entraBearerToken}`;
  }

  const response = await fetch(endpointUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let body;
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

async function callTool(name, args) {
  const payload = {
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: {
      name,
      arguments: args
    }
  };

  const result = await postJson(payload);
  if (result.error) {
    throw new Error(`${name} failed: ${JSON.stringify(result.error)}`);
  }

  return result.result;
}

function extractJsonContent(result, toolName) {
  const textContent = result?.content?.find(entry => entry?.type === "text")?.text;
  if (!textContent) {
    throw new Error(`${toolName} returned no text content.`);
  }

  try {
    return JSON.parse(textContent);
  } catch (error) {
    throw new Error(`${toolName} returned non-JSON text content: ${textContent}`);
  }
}

async function run() {
  console.log(`Using MCP endpoint: ${endpointUrl.toString()}`);

  // Optional initialize to improve compatibility with MCP servers expecting init before calls.
  try {
    await postJson({
      jsonrpc: "2.0",
      id: nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "servicenow-mcp-smoke-test",
          version: "1.0.0"
        }
      }
    });
  } catch (error) {
    console.warn(`Initialize failed, continuing with tool calls: ${error.message}`);
  }

  console.log("1/3 search_catalog_items");
  const searchResultRaw = await callTool("search_catalog_items", {
    query: searchQuery,
    limit: 5
  });
  const searchResult = extractJsonContent(searchResultRaw, "search_catalog_items");

  console.log(`   found=${searchResult.found}`);

  let itemSysId = explicitItemSysId;
  if (!itemSysId) {
    itemSysId = searchResult?.items?.[0]?.sys_id || "";
  }

  if (!itemSysId) {
    throw new Error("No item sys_id available. Set ITEM_SYS_ID or use a query that returns results.");
  }

  console.log(`2/3 get_catalog_item_form (itemSysId=${itemSysId})`);
  const formResultRaw = await callTool("get_catalog_item_form", { itemSysId });
  const formResult = extractJsonContent(formResultRaw, "get_catalog_item_form");

  console.log(`   itemName=${formResult.itemName}`);
  console.log(`   variableCount=${formResult.variableCount}`);

  console.log("3/3 place_order");
  const placeOrderArgs = {
    itemSysId,
    variables: orderVariables
  };

  if (requestedFor) {
    placeOrderArgs.requestedFor = requestedFor;
  }

  const orderResultRaw = await callTool("place_order", placeOrderArgs);
  const orderResult = extractJsonContent(orderResultRaw, "place_order");

  console.log("Smoke test completed.");
  console.log(JSON.stringify({
    requestNumber: orderResult.requestNumber,
    requestId: orderResult.requestId,
    success: orderResult.success
  }, null, 2));
}

run().catch(error => {
  console.error("Smoke test failed.");
  console.error(error.message || error);
  process.exit(1);
});

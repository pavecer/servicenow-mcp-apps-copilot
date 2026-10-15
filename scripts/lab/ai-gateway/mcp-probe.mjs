// LAB ONLY (docs/lab/ai-gateway). Minimal MCP JSON-RPC client over Streamable
// HTTP that records HTTP status, selected response headers and the raw body.
// Never records request header VALUES for credentials.

const REDACT = /^(authorization|api-key|x-gateway-key|ocp-apim-subscription-key|cookie)$/i;

export function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k] = REDACT.test(k) ? "<present>" : v;
  return out;
}

function parseBody(text, contentType) {
  if (!text) return undefined;
  if ((contentType || "").includes("text/event-stream")) {
    const data = text.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("");
    try { return JSON.parse(data); } catch { return text; }
  }
  try { return JSON.parse(text); } catch { return text; }
}

let nextId = 1;

/**
 * @param {string} url MCP endpoint
 * @param {string} method JSON-RPC method
 * @param {object} [params]
 * @param {Record<string,string>} [headers] extra headers (credentials)
 */
export async function mcpRequest(url, method, params, headers = {}) {
  const reqHeaders = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
    ...headers
  };
  const body = { jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) };
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: reqHeaders, body: JSON.stringify(body) });
  } catch (err) {
    return { method, url, error: String(err), durationMs: Date.now() - started, requestHeaders: redactHeaders(reqHeaders) };
  }
  const text = await res.text();
  const pick = ["content-type", "retry-after", "www-authenticate", "x-ms-request-id", "apim-request-id", "x-ms-region", "x-ratelimit-remaining-requests"];
  const responseHeaders = {};
  for (const h of pick) { const v = res.headers.get(h); if (v) responseHeaders[h] = v; }
  return {
    method,
    url,
    status: res.status,
    durationMs: Date.now() - started,
    requestHeaders: redactHeaders(reqHeaders),
    responseHeaders,
    body: parseBody(text, res.headers.get("content-type"))
  };
}

export const initialize = (url, headers) =>
  mcpRequest(url, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gwlab-harness", version: "0.1.0" } }, headers);
export const listTools = (url, headers) => mcpRequest(url, "tools/list", {}, headers);
export const listResources = (url, headers) => mcpRequest(url, "resources/list", {}, headers);
export const readResource = (url, uri, headers) => mcpRequest(url, "resources/read", { uri }, headers);
export const callTool = (url, name, args, headers) => mcpRequest(url, "tools/call", { name, arguments: args ?? {} }, headers);

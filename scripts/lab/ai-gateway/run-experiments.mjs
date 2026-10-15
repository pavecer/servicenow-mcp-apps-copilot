#!/usr/bin/env node
// LAB ONLY (docs/lab/ai-gateway). Experiment runner for the AI gateway lab.
//
//   node scripts/lab/ai-gateway/run-experiments.mjs --scenario <name> [--target gateway|direct]
//        [--tool <name>] [--args <json>] [--no-bearer] [--no-api-key] [--gateway-header]
//        [--token-source azcli|devicecode] [--poll 15] [--timeout 900] [--n 30]
//
// Scenarios: list, call, B1, B2, B3, poll, burst
//
// Config comes from the azd env file (.azure/snowmcp-gwlab/.env) plus the
// gitignored lab file .azure/snowmcp-gwlab/lab.env (LAB_GATEWAY_MCP_URL,
// LAB_GATEWAY_API_KEY, LAB_GATEWAY_SHARED_SECRET). Secrets are never printed;
// evidence files contain only header presence and trimmed bodies.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { initialize, listTools, listResources, readResource, callTool } from "./mcp-probe.mjs";
import { getUserToken, tokenShape } from "./get-user-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const envName = process.env.LAB_AZD_ENV || "snowmcp-gwlab";

function loadEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

const cfg = {
  ...loadEnvFile(path.join(repoRoot, ".azure", envName, ".env")),
  ...loadEnvFile(path.join(repoRoot, ".azure", envName, "lab.env")),
  ...process.env
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const flag = name => process.argv.includes(`--${name}`);

const scenario = arg("scenario", "list");
const target = arg("target", "gateway");
const useBearer = !flag("no-bearer");
const useApiKey = !flag("no-api-key");

const urls = {
  direct: cfg.LAB_DIRECT_MCP_URL || cfg.MCP_ENDPOINT_URL,
  gateway: cfg.LAB_GATEWAY_MCP_URL
};

let cachedToken;
async function bearer() {
  if (!cachedToken) {
    cachedToken = await getUserToken({
      source: arg("token-source", "azcli"),
      tenantId: cfg.ENTRA_TENANT_ID,
      serverAppId: cfg.ENTRA_CLIENT_ID,
      harnessClientId: cfg.LAB_HARNESS_CLIENT_ID
    });
  }
  return cachedToken;
}

async function headersFor(t) {
  const h = {};
  if (useBearer) h.authorization = `Bearer ${await bearer()}`;
  if (t === "gateway" && useApiKey && cfg.LAB_GATEWAY_API_KEY) h["api-key"] = cfg.LAB_GATEWAY_API_KEY;
  if (flag("gateway-header") && cfg.LAB_GATEWAY_SHARED_SECRET) h["x-gateway-key"] = cfg.LAB_GATEWAY_SHARED_SECRET;
  return h;
}

function trim(value, max = 4000) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s && s.length > max ? `${s.slice(0, max)}…[trimmed ${s.length - max} chars]` : value;
}

function saveEvidence(name, data) {
  const dir = path.join(repoRoot, "docs", "lab", "ai-gateway", "evidence", "runs");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}-${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return path.relative(repoRoot, file);
}

function summarizeResult(r) {
  const b = r.body && typeof r.body === "object" ? r.body : undefined;
  const result = b?.result;
  return {
    status: r.status,
    durationMs: r.durationMs,
    responseHeaders: r.responseHeaders,
    jsonRpcError: b?.error,
    isError: result?.isError,
    denial: result?._meta?.["com.microsoft.azure.ai.gateway/denial"],
    hasStructuredContent: Boolean(result?.structuredContent),
    resultMetaKeys: result?._meta ? Object.keys(result._meta) : undefined,
    body: trim(r.body)
  };
}

function toolIndex(listResult) {
  const tools = listResult?.body?.result?.tools ?? [];
  return Object.fromEntries(tools.map(t => [t.name, t]));
}

const sha = s => crypto.createHash("sha256").update(s ?? "").digest("hex").slice(0, 16);

async function run() {
  const evidence = { scenario, target, startedUtc: new Date().toISOString(), useBearer, useApiKey };
  if (useBearer) evidence.callerTokenShape = tokenShape(await bearer());

  switch (scenario) {
    case "list": {
      const h = await headersFor(target);
      evidence.initialize = summarizeResult(await initialize(urls[target], h));
      const l = await listTools(urls[target], h);
      evidence.toolsList = { status: l.status, names: Object.keys(toolIndex(l)), raw: trim(l.body, 1500) };
      break;
    }
    case "call": {
      const h = await headersFor(target);
      const args = arg("args") ? JSON.parse(arg("args")) : {};
      evidence.tool = arg("tool");
      evidence.call = summarizeResult(await callTool(urls[target], arg("tool"), args, h));
      break;
    }
    case "B1": {
      const d = toolIndex(await listTools(urls.direct, await headersFor("direct")));
      const g = toolIndex(await listTools(urls.gateway, await headersFor("gateway")));
      const strip = n => n.replace(/^[^_]+__/, "").replace(/^servicenow[-_.]/, "");
      const gByBase = Object.fromEntries(Object.entries(g).map(([n, t]) => [strip(n), { ...t, gatewayName: n }]));
      evidence.directCount = Object.keys(d).length;
      evidence.gatewayCount = Object.keys(g).length;
      evidence.gatewayNames = Object.keys(g);
      evidence.diff = Object.keys(d).map(name => {
        const dt = d[name]; const gt = g[name] ?? gByBase[name];
        if (!gt) return { name, presentInGateway: false };
        return {
          name,
          gatewayName: gt.gatewayName ?? gt.name,
          renamed: (gt.gatewayName ?? gt.name) !== name,
          descriptionEqual: dt.description === gt.description,
          inputSchemaEqual: JSON.stringify(dt.inputSchema) === JSON.stringify(gt.inputSchema),
          annotationsEqual: JSON.stringify(dt.annotations) === JSON.stringify(gt.annotations),
          metaEqual: JSON.stringify(dt._meta) === JSON.stringify(gt._meta),
          directUi: dt._meta?.ui?.resourceUri ?? dt._meta?.["ui/resourceUri"],
          gatewayUi: gt._meta?.ui?.resourceUri ?? gt._meta?.["ui/resourceUri"],
          gatewayMetaKeys: gt._meta ? Object.keys(gt._meta) : []
        };
      });
      break;
    }
    case "B2": {
      for (const t of ["direct", "gateway"]) {
        const h = await headersFor(t);
        const lr = await listResources(urls[t], h);
        const resources = lr?.body?.result?.resources ?? [];
        evidence[t] = { listStatus: lr.status, listError: lr?.body?.error, uris: resources.map(r => r.uri), reads: {} };
        for (const r of resources) {
          const rr = await readResource(urls[t], r.uri, h);
          const c = rr?.body?.result?.contents?.[0];
          evidence[t].reads[r.uri] = { status: rr.status, mimeType: c?.mimeType, sha: sha(c?.text), length: c?.text?.length, error: rr?.body?.error };
        }
        if (resources.length === 0 && t === "gateway") {
          for (const uri of evidence.direct?.uris ?? []) {
            const rr = await readResource(urls[t], uri, h);
            const c = rr?.body?.result?.contents?.[0];
            evidence[t].reads[uri] = { status: rr.status, mimeType: c?.mimeType, sha: sha(c?.text), length: c?.text?.length, error: rr?.body?.error };
          }
        }
      }
      evidence.byteIdentical = Object.fromEntries((evidence.direct.uris ?? []).map(u => [u, evidence.direct.reads[u]?.sha === evidence.gateway.reads[u]?.sha]));
      break;
    }
    case "B3": {
      const tool = arg("tool", "search_catalog_items");
      const args = arg("args") ? JSON.parse(arg("args")) : { query: "laptop" };
      evidence.direct = summarizeResult(await callTool(urls.direct, tool, args, await headersFor("direct")));
      evidence.gateway = summarizeResult(await callTool(urls.gateway, arg("gateway-tool", tool), args, await headersFor("gateway")));
      break;
    }
    case "poll": {
      const interval = Number(arg("poll", 15)) * 1000;
      const timeout = Number(arg("timeout", 900)) * 1000;
      const tool = arg("tool");
      const args = arg("args") ? JSON.parse(arg("args")) : {};
      const start = Date.now();
      evidence.timeline = [];
      let first;
      while (Date.now() - start < timeout) {
        const h = await headersFor(target);
        const r = tool ? await callTool(urls[target], tool, args, h) : await listTools(urls[target], h);
        const s = summarizeResult(r);
        const sig = `${s.status}|${s.isError}|${s.denial?.code ?? ""}`;
        evidence.timeline.push({ t: new Date().toISOString(), elapsedS: Math.round((Date.now() - start) / 1000), sig });
        process.stderr.write(`${evidence.timeline.at(-1).elapsedS}s ${sig}\n`);
        if (first === undefined) first = sig;
        else if (sig !== first) { evidence.changedAfterS = evidence.timeline.at(-1).elapsedS; evidence.last = s; break; }
        await new Promise(r => setTimeout(r, interval));
      }
      break;
    }
    case "burst": {
      const n = Number(arg("n", 30));
      const h = await headersFor(target);
      const results = await Promise.all(Array.from({ length: n }, () => listTools(urls[target], h)));
      evidence.statusCounts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
      evidence.sample429 = results.find(r => r.status === 429) ? summarizeResult(results.find(r => r.status === 429)) : undefined;
      break;
    }
    default:
      throw new Error(`Unknown scenario ${scenario}`);
  }

  evidence.finishedUtc = new Date().toISOString();
  const file = saveEvidence(`${scenario}-${target}${arg("label") ? `-${arg("label")}` : ""}`, evidence);
  console.log(JSON.stringify({ evidenceFile: file, ...evidence }, null, 2).slice(0, 6000));
}

run().catch(err => { console.error(String(err?.stack || err)); process.exit(1); });

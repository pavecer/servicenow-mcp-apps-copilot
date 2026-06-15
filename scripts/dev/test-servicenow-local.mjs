#!/usr/bin/env node
/**
 * Direct ServiceNow probe — runs the ServiceNow client against your real
 * instance WITHOUT going through MCP, the Azure Functions runtime, or
 * Copilot Studio. Useful for:
 *
 *   - Verifying ServiceNow OAuth credentials and token endpoint
 *   - Inspecting raw catalog item / order responses
 *   - Reproducing ServiceNow-side bugs in isolation (no MCS / Express layer)
 *
 * Reads configuration from ./local.settings.json (the same file Azure
 * Functions Core Tools loads on `func start`). Existing process.env values
 * win, so you can override individual settings on the command line:
 *
 *   $env:SERVICENOW_INSTANCE_URL = "https://other.service-now.com"
 *   node scripts/dev/test-servicenow-local.mjs validate
 *
 * Usage:
 *   node scripts/dev/test-servicenow-local.mjs <command> [args] [--upn=<user>]
 *
 * Commands:
 *   validate                          Run the same checks as the
 *                                     validate_servicenow_config tool.
 *   search <query> [limit]            Full-text catalog search.
 *   form <itemSysId>                  Fetch the order form for an item.
 *   orders                            List the caller's open orders.
 *                                     Requires --upn=<user@domain> so the
 *                                     ServiceNow user lookup can resolve.
 *   order <itemSysId> <variablesJson> Place an order. CREATES A REAL REQUEST
 *           [--quantity=N]            in ServiceNow — pass --confirm to run.
 *           [--requested-for=<sys_id|email>]
 *           --confirm
 *
 * Notes:
 *   - Run `npm run build` first (or use the wrapper `npm run sn:local`).
 *   - Caller identity is simulated via --upn=<value>; pass it to test
 *     requested_for resolution and listUserOrders.
 *   - Output is raw JSON so you can pipe through jq / Out-String / etc.
 */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Load local.settings.json the way Azure Functions Core Tools does.
// Existing process.env values are NOT overwritten.
// ---------------------------------------------------------------------------
const settingsPath = path.join(repoRoot, "local.settings.json");
if (fs.existsSync(settingsPath)) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const values = raw?.Values ?? {};
    for (const [k, v] of Object.entries(values)) {
      if (process.env[k] === undefined && typeof v === "string") {
        process.env[k] = v;
      }
    }
  } catch (err) {
    console.error(`[warn] Failed to parse ${settingsPath}: ${err.message}`);
  }
} else {
  console.error(
    `[warn] ${settingsPath} not found. Either create it (copy local.settings.sample.json)\n` +
    `       or export the SERVICENOW_* env vars manually before running.`
  );
}

// Auth bypass for local dev so the source modules don't 503 at import time.
process.env.ENTRA_AUTH_DISABLED = process.env.ENTRA_AUTH_DISABLED ?? "true";

// ---------------------------------------------------------------------------
// Argument parsing (no external deps).
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const positional = [];
const flags = {};

for (const arg of argv) {
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=");
    if (eq === -1) {
      flags[arg.slice(2)] = true;
    } else {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  } else {
    positional.push(arg);
  }
}

const command = positional[0];
const callerUpn = flags.upn || flags["caller-upn"] || undefined;

if (!command || flags.help || flags.h) {
  printUsage();
  process.exit(command ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Dynamically import the compiled sources AFTER env is populated.
// The `src/config.ts` module evaluates `getRequiredEnv` at import time and
// will throw if SERVICENOW_INSTANCE_URL etc. are missing.
// ---------------------------------------------------------------------------
const distRoot = path.join(repoRoot, "dist");
if (!fs.existsSync(distRoot)) {
  console.error(`[error] dist/ not found. Run 'npm run build' first (or use 'npm run sn:local').`);
  process.exit(2);
}

const { ServiceNowClient } = await import(url.pathToFileURL(path.join(distRoot, "services", "servicenowClient.js")));
const { TokenManager } = await import(url.pathToFileURL(path.join(distRoot, "services", "tokenManager.js")));
const { runWithRequestContext } = await import(url.pathToFileURL(path.join(distRoot, "requestContext.js")));

const tokenManager = new TokenManager();
const client = new ServiceNowClient(tokenManager);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const commands = {
  async validate() {
    console.error("[info] validate: requesting OAuth token from ServiceNow...");
    const token = await tokenManager.getAccessToken();
    console.error(`[info] validate: token acquired (length=${token.length})`);

    const items = await runCallerContext(() => client.searchCatalogItems("laptop", { limit: 5 }));
    return {
      ok: true,
      auth: { tokenLengthBytes: token.length },
      catalog: {
        sampleQuery: "laptop",
        foundCount: items.length,
        firstItem: items[0]
          ? { sys_id: items[0].sys_id, name: items[0].name }
          : null
      }
    };
  },

  async search() {
    const query = positional[1];
    const limit = positional[2] ? Number(positional[2]) : 10;
    if (!query) throw new Error("Usage: search <query> [limit]");
    return runCallerContext(() => client.searchCatalogItems(query, { limit }));
  },

  async form() {
    const itemSysId = positional[1];
    if (!itemSysId) throw new Error("Usage: form <itemSysId>");
    return runCallerContext(() => client.getCatalogItem(itemSysId));
  },

  async orders() {
    if (!callerUpn) {
      throw new Error(
        "Usage: orders --upn=<user@domain.com>\n" +
        "       (orders are filtered by requested_for, which needs a caller identity)"
      );
    }
    const limit = positional[1] ? Number(positional[1]) : 10;
    return runCallerContext(() => client.listUserOrders(limit));
  },

  async order() {
    const itemSysId = positional[1];
    const variablesJson = positional[2];
    if (!itemSysId || !variablesJson) {
      throw new Error('Usage: order <itemSysId> <variablesJson> [--quantity=N] [--requested-for=<id>] --confirm');
    }
    if (!flags.confirm) {
      throw new Error(
        "Refusing to place an order without --confirm. This call CREATES a real ServiceNow request."
      );
    }
    let variables;
    try {
      variables = JSON.parse(variablesJson);
    } catch (err) {
      throw new Error(`variablesJson is not valid JSON: ${err.message}`);
    }
    if (typeof variables !== "object" || variables === null || Array.isArray(variables)) {
      throw new Error("variablesJson must be a JSON object");
    }
    const input = {
      variables,
      quantity: flags.quantity ? Number(flags.quantity) : 1,
      requestedFor: flags["requested-for"] || undefined
    };
    return runCallerContext(() => client.placeOrder(itemSysId, input));
  }
};

function runCallerContext(fn) {
  // Simulate what runWithRequestContext does in the Express middleware so
  // tools that read getRequestContext() (requested_for resolution, listUserOrders)
  // see a caller identity when --upn is supplied.
  return runWithRequestContext({ callerUpn }, fn);
}

function printUsage() {
  console.error(
    [
      "Usage: node scripts/dev/test-servicenow-local.mjs <command> [args] [--upn=<user@domain>]",
      "",
      "Commands:",
      "  validate                                  ServiceNow OAuth + catalog smoke check",
      "  search <query> [limit]                    Full-text catalog search",
      "  form <itemSysId>                          Fetch the order form for an item",
      "  orders [limit] --upn=<user@domain>        List the caller's open orders",
      "  order <itemSysId> <varsJson> --confirm    Place a real order in ServiceNow",
      "         [--quantity=N] [--requested-for=<sys_id|email>] [--upn=<user@domain>]",
      "",
      "Examples:",
      '  node scripts/dev/test-servicenow-local.mjs validate',
      '  node scripts/dev/test-servicenow-local.mjs search "vpn access" 5',
      '  node scripts/dev/test-servicenow-local.mjs form 04b7e94b4f7b4200086eeed18110c7fd',
      '  node scripts/dev/test-servicenow-local.mjs orders --upn=alice@contoso.com',
      '  node scripts/dev/test-servicenow-local.mjs order <sys_id> "{\\"justification\\":\\"x\\"}" --confirm --upn=alice@contoso.com'
    ].join("\n")
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
const handler = commands[command];
if (!handler) {
  console.error(`[error] Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

try {
  const result = await handler();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (err) {
  if (err?.response?.data) {
    console.error("[error] ServiceNow responded:", JSON.stringify({
      status: err.response.status,
      statusText: err.response.statusText,
      data: err.response.data
    }, null, 2));
  } else {
    console.error(`[error] ${err?.message || err}`);
  }
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Generic catalog-item smart-prefill probe.
 *
 * 1. Fetches a real ServiceNow catalog item form (default sys_id is the
 *    "Apple iPhone 13" demo item on https://<your-instance>.service-now.com).
 * 2. Runs the prefill engine (src/utils/prefillCatalogForm.ts) against a
 *    few representative user contexts (free-text only, structured hints
 *    only, both combined) or against a custom scenario you supply.
 * 3. Prints the (recursively-expanded) variable inventory, prefilled
 *    values, diagnostics, and the final Adaptive Card so you can see
 *    exactly what the agent would return to the end user.
 *
 * Usage:
 *   npm run build
 *   node scripts/dev/test-catalog-prefill.mjs                       # default = iPhone 13
 *   node scripts/dev/test-catalog-prefill.mjs <itemSysId>           # any catalog item
 *   node scripts/dev/test-catalog-prefill.mjs <itemSysId> --scenario=hints
 *
 * Built-in scenarios (iPhone-flavored):
 *   context   Free-text userContext only (no structured hints).
 *   hints     Structured prefillHints only (highest confidence path).
 *   both      Both userContext AND prefillHints (typical agent flow).
 *   all       Run every built-in scenario back-to-back. [default]
 *
 * Custom scenario (works for ANY catalog item):
 *   --hints='<json-object>'      OR  --hints-file=<path-to-json>
 *   --context='<free text>'      OR  --context-file=<path-to-txt>
 *   --scenario=custom            Run only the custom scenario
 *
 * Other flags:
 *   --dump-card                  Include the full Adaptive Card JSON in output
 */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Load local.settings.json the way Functions Core Tools does (same logic as
// scripts/dev/test-servicenow-local.mjs).
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
    `[error] ${settingsPath} not found. Copy local.settings.sample.json and ` +
      `fill in SERVICENOW_INSTANCE_URL and credentials before running.`
  );
  process.exit(2);
}

process.env.ENTRA_AUTH_DISABLED = process.env.ENTRA_AUTH_DISABLED ?? "true";

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const positional = [];
const flags = {};
for (const arg of argv) {
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=");
    if (eq === -1) flags[arg.slice(2)] = true;
    else flags[arg.slice(2, eq)] = arg.slice(eq + 1);
  } else {
    positional.push(arg);
  }
}

// Default = the Apple iPhone sys_id you shared from the demo ServiceNow instance.
const DEFAULT_IPHONE_SYS_ID = "ec80c13297968d1021983d1e6253af32";
const itemSysId = positional[0] || DEFAULT_IPHONE_SYS_ID;
const scenarioName = (flags.scenario || "all").toLowerCase();

// ---------------------------------------------------------------------------
// Import compiled sources
// ---------------------------------------------------------------------------
const distRoot = path.join(repoRoot, "dist");
if (!fs.existsSync(distRoot)) {
  console.error("[error] dist/ not found. Run 'npm run build' first.");
  process.exit(2);
}

const { ServiceNowClient } = await import(
  url.pathToFileURL(path.join(distRoot, "services", "servicenowClient.js"))
);
const { TokenManager } = await import(
  url.pathToFileURL(path.join(distRoot, "services", "tokenManager.js"))
);
const { computePrefillValues } = await import(
  url.pathToFileURL(path.join(distRoot, "utils", "prefillCatalogForm.js"))
);
const {
  buildOrderFormAdaptiveCard,
  collectVariables,
  isReferenceVariable,
  getReferenceTable,
  getReferenceQualifier
} = await import(
  url.pathToFileURL(path.join(distRoot, "utils", "adaptiveCards.js"))
);

const tokenManager = new TokenManager();
const client = new ServiceNowClient(tokenManager);

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
const SCENARIOS = {
  context: {
    label: "userContext only (free-text fallback path)",
    input: {
      userContext:
        "Hi! Please order me a black iPhone with 256GB storage on Verizon. " +
        "My old phone is damaged and I need a replacement by 2026-07-01. Just 1 unit."
    }
  },
  hints: {
    label: "prefillHints only (structured agent-extracted path)",
    input: {
      prefillHints: {
        color: "black",
        storage: "256",
        carrier: "verizon",
        justification: "Replacement for damaged corporate phone"
      }
    }
  },
  both: {
    label: "userContext + prefillHints (typical agent flow)",
    input: {
      userContext:
        "Replacement iPhone needed urgently, old one was damaged on business trip.",
      prefillHints: {
        color: "black",
        storage: "256",
        carrier: "verizon"
      }
    }
  }
};

const order = scenarioName === "all"
  ? ["context", "hints", "both"]
  : [scenarioName];

// Custom scenario via CLI flags --hints='<json>' and/or --context='<text>'.
// (PowerShell quoting is fiddly with JSON; use --hints-file=<path> as an
// alternative that reads the JSON from a file.)
// When either signal is provided, an additional "custom" scenario is
// registered and run AFTER the built-ins (or alone when --scenario=custom).
if (flags.hints || flags["hints-file"] || flags.context || flags["context-file"]) {
  let parsedHints;
  let hintsSource = flags.hints;
  if (flags["hints-file"]) {
    try {
      hintsSource = fs.readFileSync(flags["hints-file"], "utf8");
    } catch (err) {
      console.error(`[error] --hints-file could not be read: ${err.message}`);
      process.exit(1);
    }
  }
  if (hintsSource) {
    try {
      parsedHints = JSON.parse(hintsSource);
    } catch (err) {
      console.error(`[error] hints JSON is invalid: ${err.message}`);
      process.exit(1);
    }
    if (typeof parsedHints !== "object" || parsedHints === null || Array.isArray(parsedHints)) {
      console.error("[error] hints must be a JSON object");
      process.exit(1);
    }
  }
  let contextValue = flags.context;
  if (flags["context-file"]) {
    try {
      contextValue = fs.readFileSync(flags["context-file"], "utf8");
    } catch (err) {
      console.error(`[error] --context-file could not be read: ${err.message}`);
      process.exit(1);
    }
  }
  SCENARIOS.custom = {
    label: "custom (--hints / --context)",
    input: {
      ...(contextValue ? { userContext: contextValue } : {}),
      ...(parsedHints ? { prefillHints: parsedHints } : {})
    }
  };
  if (scenarioName === "custom") {
    order.length = 0;
    order.push("custom");
  } else if (scenarioName === "all") {
    order.push("custom");
  }
}

for (const name of order) {
  if (!SCENARIOS[name]) {
    console.error(`[error] Unknown scenario '${name}'. Use one of: ${Object.keys(SCENARIOS).join(", ")}, all`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
function hr(char = "-") {
  return char.repeat(80);
}

function summarizeVariable(v) {
  const choicesRaw = v.choices ?? v.options ?? null;
  let choices;
  if (typeof choicesRaw === "string") {
    choices = choicesRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } else if (Array.isArray(choicesRaw)) {
    choices = choicesRaw.map(c =>
      typeof c === "string" || typeof c === "number"
        ? String(c)
        : (c?.label ?? c?.title ?? c?.value ?? "")
    ).filter(Boolean);
  }

  const summary = {
    name: v.name,
    label: v.label,
    type: v.type ?? v.question_type ?? v.ui_type,
    mandatory: v.mandatory === true,
    visible: v.visible !== false,
    readonly: v.readonly === true,
    choices: choices && choices.length > 0 ? choices : undefined
  };

  // ServiceNow catalog items frequently expose containers/labels that wrap
  // nested children (e.g. "Optional Software" container -> powerpoint /
  // acrobat / siebel toggles). Recurse so the inventory shows what the
  // engine actually sees.
  for (const key of ["variables", "children", "questions", "fields"]) {
    const nested = v[key];
    if (Array.isArray(nested) && nested.length > 0) {
      summary.children = nested.map(summarizeVariable);
      break;
    }
  }

  return summary;
}

try {
  console.log(hr("="));
  console.log(`Fetching catalog item ${itemSysId} ...`);
  console.log(hr("="));

  const item = await client.getCatalogItem(itemSysId);

  console.log(`Item name:     ${item.name}`);
  console.log(`Item sys_id:   ${item.sys_id}`);
  console.log(`Short desc:    ${item.short_description ?? "(none)"}`);
  console.log(`Variables:     ${item.variables?.length ?? 0}`);
  console.log("");
  console.log("Variable inventory (what the prefill engine sees):");
  console.log(JSON.stringify((item.variables ?? []).map(summarizeVariable), null, 2));
  console.log("");

  // Pre-resolve reference variables exactly like getCatalogItemForm.ts does
  // in production, so the probe surfaces the same Input.ChoiceSet output the
  // agent would emit.
  const referenceVariables = collectVariables(item.variables).filter(
    v => isReferenceVariable(v) && v.visible !== false && getReferenceTable(v)
  );
  const referenceChoices = {};
  const referenceDiagnostics = {};
  if (referenceVariables.length > 0) {
    const lookups = await Promise.all(
      referenceVariables.map(async variable => {
        const table = getReferenceTable(variable);
        const refQualifier = getReferenceQualifier(variable);
        try {
          const records = await client.searchReferenceRecords(table, {
            refQualifier: refQualifier || undefined,
            limit: 10
          });
          return { variable, table, refQualifier, records };
        } catch (err) {
          return { variable, table, refQualifier, records: [], error: err?.message };
        }
      })
    );
    for (const { variable, table, refQualifier, records, error } of lookups) {
      if (records.length > 0) {
        referenceChoices[variable.name] = records.map(r => ({ title: r.display, value: r.sys_id }));
      }
      referenceDiagnostics[variable.name] = {
        table,
        refQualifier: refQualifier || undefined,
        count: records.length,
        error
      };
    }
    console.log("Reference lookup results (orchestrated):");
    console.log(JSON.stringify(referenceDiagnostics, null, 2));
    console.log("");
  }

  for (const name of order) {
    const scenario = SCENARIOS[name];
    console.log(hr("="));
    console.log(`SCENARIO '${name}': ${scenario.label}`);
    console.log(hr("="));
    console.log("Input to computePrefillValues:");
    console.log(JSON.stringify(scenario.input, null, 2));
    console.log("");

    const { values, diagnostics } = computePrefillValues(item.variables, scenario.input);

    console.log("Prefilled values:");
    console.log(JSON.stringify(values, null, 2));
    console.log("");
    console.log("Diagnostics (why each value was chosen):");
    console.log(JSON.stringify(diagnostics, null, 2));
    console.log("");

    const card = buildOrderFormAdaptiveCard(item, values, referenceChoices);
    const inputs = (card.body ?? [])
      .filter(b => typeof b.id === "string")
      .map(b => ({
        id: b.id,
        type: b.type,
        value: b.value,
        style: b.style,
        choicesCount: Array.isArray(b.choices) ? b.choices.length : undefined,
        prefilled: Object.prototype.hasOwnProperty.call(values, b.id)
      }));
    console.log("Adaptive Card inputs after prefill:");
    console.log(JSON.stringify(inputs, null, 2));
    console.log("");

    if (flags["dump-card"]) {
      console.log("Full Adaptive Card JSON:");
      console.log(JSON.stringify(card, null, 2));
      console.log("");
    }
  }
} catch (err) {
  if (err?.response?.data) {
    console.error("[error] ServiceNow responded:", JSON.stringify({
      status: err.response.status,
      statusText: err.response.statusText,
      data: err.response.data
    }, null, 2));
  } else {
    console.error(`[error] ${err?.message || err}`);
    if (err?.stack) console.error(err.stack);
  }
  process.exit(1);
}

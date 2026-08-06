#!/usr/bin/env node
/**
 * Phase 1 readiness preflight.
 *
 * Purpose:
 * - Validate local configuration required to continue IT + HR + KB expansion.
 * - Probe ServiceNow access for catalog, incident, knowledge, and HR tables.
 * - Emit a concise machine-readable summary plus a human checklist.
 *
 * Usage:
 *   npm run preflight:readiness
 */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import axios from "axios";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const settingsPath = path.join(repoRoot, "local.settings.json");

function loadConfig() {
  const env = { ...process.env };
  if (fs.existsSync(settingsPath)) {
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const values = raw?.Values ?? {};
    for (const [k, v] of Object.entries(values)) {
      if (env[k] === undefined && typeof v === "string") {
        env[k] = v;
      }
    }
  }
  return env;
}

function mask(value) {
  if (!value) return "(missing)";
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function getToken(baseUrl, cfg) {
  const payload = new URLSearchParams({
    grant_type: "password",
    client_id: cfg.SERVICENOW_CLIENT_ID,
    client_secret: cfg.SERVICENOW_CLIENT_SECRET,
    username: cfg.SERVICENOW_USERNAME,
    password: cfg.SERVICENOW_PASSWORD
  });

  const response = await axios.post(`${baseUrl}/oauth_token.do`, payload.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30000
  });

  if (!response.data?.access_token) {
    throw new Error("Token response did not include access_token");
  }

  return response.data.access_token;
}

async function probe(baseUrl, token, check) {
  const response = await axios.get(`${baseUrl}${check.path}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000,
    validateStatus: () => true
  });

  const body = response.data ?? {};
  const resultArray = Array.isArray(body.result) ? body.result : [];
  return {
    id: check.id,
    area: check.area,
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    count: resultArray.length,
    error: body.error?.message ?? null,
    guidance: check.guidance
  };
}

async function main() {
  const cfg = loadConfig();
  const required = [
    "SERVICENOW_INSTANCE_URL",
    "SERVICENOW_CLIENT_ID",
    "SERVICENOW_CLIENT_SECRET",
    "SERVICENOW_USERNAME",
    "SERVICENOW_PASSWORD"
  ];

  const missing = required.filter((k) => !cfg[k]);
  if (missing.length) {
    console.error("[preflight] Missing required configuration keys:", missing.join(", "));
    process.exit(2);
  }

  const baseUrl = cfg.SERVICENOW_INSTANCE_URL.replace(/\/$/, "");
  console.error("[preflight] Instance:", baseUrl);
  console.error("[preflight] Client ID:", mask(cfg.SERVICENOW_CLIENT_ID));
  console.error("[preflight] Username:", cfg.SERVICENOW_USERNAME);

  let token;
  try {
    token = await getToken(baseUrl, cfg);
  } catch (error) {
    console.error("[preflight] OAuth token check failed:", error instanceof Error ? error.message : String(error));
    process.exit(3);
  }

  const checks = [
    {
      id: "catalog.items",
      area: "IT",
      path: "/api/sn_sc/servicecatalog/items?sysparm_limit=1",
      guidance: "Requires catalog visibility and Service Catalog API access."
    },
    {
      id: "incident.table",
      area: "IT",
      path: "/api/now/table/incident?sysparm_limit=1&sysparm_fields=sys_id,number,state",
      guidance: "Required for incident report/track/comment flows."
    },
    {
      id: "kb.knowledge",
      area: "KB",
      path: "/api/now/table/kb_knowledge?sysparm_limit=1&sysparm_fields=sys_id,number,short_description,published",
      guidance: "Required for employee self-service knowledge search and article detail flows."
    },
    {
      id: "kb.category",
      area: "KB",
      path: "/api/now/table/kb_category?sysparm_limit=1&sysparm_fields=sys_id,label",
      guidance: "Useful for category facets and browse-first knowledge UX."
    },
    {
      id: "hr.case",
      area: "HR",
      path: "/api/now/table/sn_hr_core_case?sysparm_limit=1&sysparm_fields=sys_id,number,short_description,state",
      guidance: "If 400 Invalid table, HRSD core tables are not enabled in this instance."
    },
    {
      id: "hr.profile",
      area: "HR",
      path: "/api/now/table/sn_hr_core_profile?sysparm_limit=1&sysparm_fields=sys_id,name,user",
      guidance: "Validates baseline HR profile model availability for employee-aware HR flows."
    }
  ];

  const results = [];
  for (const check of checks) {
    try {
      results.push(await probe(baseUrl, token, check));
    } catch (error) {
      results.push({
        id: check.id,
        area: check.area,
        status: 0,
        ok: false,
        count: 0,
        error: error instanceof Error ? error.message : String(error),
        guidance: check.guidance
      });
    }
  }

  const areas = {
    IT: results.filter((r) => r.area === "IT").every((r) => r.ok),
    KB: results.filter((r) => r.area === "KB").every((r) => r.ok),
    HR: results.filter((r) => r.area === "HR").every((r) => r.ok)
  };

  const summary = {
    ok: areas.IT && areas.KB,
    areaReadiness: areas,
    nextBlockingArea: areas.HR ? null : "HR",
    checks: results
  };

  console.log(JSON.stringify(summary, null, 2));

  console.error("\n[preflight] Human summary:");
  console.error(`- IT readiness: ${areas.IT ? "PASS" : "FAIL"}`);
  console.error(`- KB readiness: ${areas.KB ? "PASS" : "FAIL"}`);
  console.error(`- HR readiness: ${areas.HR ? "PASS" : "FAIL"}`);

  if (!areas.HR) {
    console.error("- HR follow-up: enable HR Service Delivery / core HR tables and grant API ACLs for the integration identity.");
  }

  if (!(areas.IT && areas.KB)) {
    process.exit(4);
  }
}

main().catch((error) => {
  console.error("[preflight] Unexpected failure:", error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

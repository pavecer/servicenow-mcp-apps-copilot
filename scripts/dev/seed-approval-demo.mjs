#!/usr/bin/env node

/**
 * Create, verify, or remove repeatable ServiceNow approval demo records.
 *
 * Reads ServiceNow credentials from local.settings.json. Process environment
 * values take precedence, matching the other local development scripts.
 *
 * Usage:
 *   node scripts/dev/seed-approval-demo.mjs seed --confirm
 *   node scripts/dev/seed-approval-demo.mjs verify
 *   node scripts/dev/seed-approval-demo.mjs cleanup --confirm
 */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import axios from "axios";
import spawn from "cross-spawn";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const settingsPath = path.join(repoRoot, "local.settings.json");
const markerPrefix = "[MCP_APPS_DEMO:approval:";
const command = process.argv[2] || "verify";
const confirmed = process.argv.includes("--confirm");

const scenarios = [
  {
    key: "alex-action",
    requestedFor: "alex",
    approver: "alex",
    title: "Demo: Developer laptop approval for Alex Baker",
    description: "Account-local approval action demo for Alex Baker."
  },
  {
    key: "admin-action",
    requestedFor: "admin",
    approver: "admin",
    title: "Demo: Executive laptop approval for admin",
    description: "Account-local approval action demo for the admin account."
  },
  {
    key: "alex-manager",
    requestedFor: "alex",
    approver: "admin",
    title: "Demo: Alex Baker laptop awaiting manager approval",
    description: "Manager narrative demo: Alex Baker is the requester and admin is the approver."
  }
];

function loadConfig() {
  const values = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))?.Values ?? {}
    : {};
  return { ...values, ...process.env };
}

function required(config, key) {
  const value = config[key];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required configuration: ${key}`);
  }
  return String(value).trim();
}

function marker(key) {
  return `${markerPrefix}${key}]`;
}

function rawValue(value) {
  if (value && typeof value === "object" && "value" in value) {
    return value.value;
  }
  return value;
}

function displayValue(value) {
  if (value && typeof value === "object") {
    return value.display_value ?? value.value ?? "";
  }
  return value ?? "";
}

async function createClient() {
  const config = loadConfig();
  const baseUrl = required(config, "SERVICENOW_INSTANCE_URL").replace(/\/$/, "");
  let accessToken;

  if (command === "seed" || command === "cleanup") {
    let scope = String(config.ENTRA_OBO_DOWNSTREAM_SCOPE || "").trim();
    if (!scope) {
      const scopeResult = spawn.sync(
        "azd",
        ["env", "get-value", "ENTRA_OBO_DOWNSTREAM_SCOPE"],
        { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
      scope = scopeResult.status === 0 ? scopeResult.stdout.trim() : "";
    }
    if (!scope) {
      throw new Error("ENTRA_OBO_DOWNSTREAM_SCOPE is missing from local settings and the active azd environment.");
    }
    const result = spawn.sync(
      "az",
      ["account", "get-access-token", "--scope", scope, "--query", "accessToken", "--output", "tsv"],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    if (result.status !== 0 || !result.stdout?.trim()) {
      throw new Error(
        "Could not acquire the delegated ServiceNow admin token. Sign in to Azure CLI with the mapped admin account and retry."
      );
    }
    accessToken = result.stdout.trim();
  } else {
  const payload = new URLSearchParams({
    grant_type: "password",
    client_id: required(config, "SERVICENOW_CLIENT_ID"),
    client_secret: required(config, "SERVICENOW_CLIENT_SECRET"),
    username: required(config, "SERVICENOW_USERNAME"),
    password: required(config, "SERVICENOW_PASSWORD")
  });

  let tokenResponse;
  try {
    tokenResponse = await axios.post(`${baseUrl}/oauth_token.do`, payload.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 30000
    });
  } catch (error) {
    const status = error?.response?.status;
    if (status === 502 || status === 503) {
      throw new Error(`ServiceNow instance is unavailable (HTTP ${status}). Wake the PDI, then rerun the command.`);
    }
    throw new Error(`ServiceNow OAuth failed${status ? ` (HTTP ${status})` : ""}: ${error?.message || error}`);
  }

    accessToken = tokenResponse.data?.access_token;
    if (!accessToken) {
      throw new Error("ServiceNow OAuth response did not contain an access token.");
    }
  }

  return {
    baseUrl,
    api: axios.create({
      baseURL: baseUrl,
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 30000
    })
  };
}

async function tableList(api, table, query, fields, limit = 50, display = "false") {
  const response = await api.get(`/api/now/table/${table}`, {
    params: {
      sysparm_query: query,
      sysparm_fields: fields,
      sysparm_limit: limit,
      sysparm_display_value: display
    }
  });
  return response.data?.result ?? [];
}

async function createRecord(api, table, body) {
  const response = await api.post(`/api/now/table/${table}`, body, {
    params: { sysparm_input_display_value: "false" }
  });
  return response.data?.result;
}

async function updateRecord(api, table, sysId, body) {
  const response = await api.patch(`/api/now/table/${table}/${sysId}`, body, {
    params: { sysparm_input_display_value: "false" }
  });
  return response.data?.result;
}

async function deleteRecord(api, table, sysId) {
  await api.delete(`/api/now/table/${table}/${sysId}`);
}

async function resolveUsers(api) {
  const fields = "sys_id,user_name,name,first_name,last_name,email,active";
  const [alexRows, adminRows] = await Promise.all([
    tableList(api, "sys_user", "active=true^name=Alex Baker", fields, 10),
    tableList(api, "sys_user", "active=true^user_name=admin", fields, 10)
  ]);

  const alex = alexRows[0];
  const admin = adminRows[0];

  if (!alex) {
    throw new Error("Could not resolve an active ServiceNow user named Alex Baker.");
  }
  if (!admin) {
    throw new Error("Could not resolve the active ServiceNow admin user.");
  }

  return { alex, admin };
}

async function resolveCatalogItem(api) {
  const preferred = await tableList(
    api,
    "sc_cat_item",
    "active=true^nameLIKEApple MacBook Pro^ORDERBYname",
    "sys_id,name,short_description,price,active",
    10
  );
  if (preferred[0]) return preferred[0];

  const fallback = await tableList(
    api,
    "sc_cat_item",
    "active=true^ORDERBYname",
    "sys_id,name,short_description,price,active",
    10
  );
  if (!fallback[0]) {
    throw new Error("No active catalog item is available for demo requests.");
  }
  return fallback[0];
}

async function findRequest(api, scenario) {
  const rows = await tableList(
    api,
    "sc_request",
    `descriptionLIKE${marker(scenario.key)}^ORDERBYDESCsys_created_on`,
    "sys_id,number,short_description,description,state,approval,requested_for,opened_by,sys_created_on",
    5
  );
  return rows[0];
}

async function ensureRequest(api, scenario, users) {
  const requestedFor = users[scenario.requestedFor];
  const requestedForSysId = rawValue(requestedFor.sys_id);
  let request = await findRequest(api, scenario);
  const body = {
    requested_for: requestedForSysId,
    opened_by: requestedForSysId,
    requested_by: requestedForSysId,
    short_description: scenario.title,
    description: `${marker(scenario.key)} ${scenario.description}`,
    state: "1",
    approval: "requested"
  };

  if (request) {
    request = await updateRecord(api, "sc_request", rawValue(request.sys_id), body);
  } else {
    request = await createRecord(api, "sc_request", body);
  }
  if (!request?.sys_id) {
    throw new Error(`ServiceNow did not return a request record for ${scenario.key}.`);
  }
  return request;
}

async function ensureRequestItem(api, request, scenario, users, catalogItem) {
  const requestSysId = rawValue(request.sys_id);
  const existing = await tableList(
    api,
    "sc_req_item",
    `request=${requestSysId}^descriptionLIKE${marker(scenario.key)}`,
    "sys_id,number,request,cat_item,requested_for,state,stage,short_description,description,quantity",
    5
  );
  const requestedForSysId = rawValue(users[scenario.requestedFor].sys_id);
  const body = {
    request: requestSysId,
    cat_item: rawValue(catalogItem.sys_id),
    requested_for: requestedForSysId,
    opened_by: requestedForSysId,
    short_description: scenario.title,
    description: `${marker(scenario.key)} Demo requested item.`,
    quantity: "1",
    state: "1"
  };

  if (existing[0]) {
    return updateRecord(api, "sc_req_item", rawValue(existing[0].sys_id), body);
  }
  return createRecord(api, "sc_req_item", body);
}

async function ensureApproval(api, request, scenario, users) {
  const requestSysId = rawValue(request.sys_id);
  const approverSysId = rawValue(users[scenario.approver].sys_id);
  const existing = await tableList(
    api,
    "sysapproval_approver",
    `sysapproval=${requestSysId}^approver=${approverSysId}`,
    "sys_id,sysapproval,approver,state,comments,sys_created_on",
    5
  );
  const body = {
    sysapproval: requestSysId,
    approver: approverSysId,
    state: "requested",
    comments: `${marker(scenario.key)} Reset to pending for the MCP Apps demo.`
  };

  if (existing[0]) {
    return updateRecord(api, "sysapproval_approver", rawValue(existing[0].sys_id), body);
  }
  return createRecord(api, "sysapproval_approver", body);
}

async function seed(api, users, catalogItem) {
  if (!confirmed) {
    throw new Error("Seed creates real ServiceNow records. Rerun with --confirm.");
  }

  const results = [];
  for (const scenario of scenarios) {
    let request = await ensureRequest(api, scenario, users);
    const item = await ensureRequestItem(api, request, scenario, users, catalogItem);
    const approval = await ensureApproval(api, request, scenario, users);
    request = await updateRecord(api, "sc_request", rawValue(request.sys_id), {
      state: "1",
      approval: "requested"
    });
    results.push({ scenario, request, item, approval });
  }
  return results;
}

async function verify(api, users) {
  const results = [];
  for (const scenario of scenarios) {
    const request = await findRequest(api, scenario);
    if (!request) {
      results.push({ scenario, missing: true });
      continue;
    }
    const requestSysId = rawValue(request.sys_id);
    const [items, approvals] = await Promise.all([
      tableList(api, "sc_req_item", `request=${requestSysId}`, "sys_id,number,request,cat_item,requested_for,state,stage,short_description,quantity", 20, "all"),
      tableList(api, "sysapproval_approver", `sysapproval=${requestSysId}`, "sys_id,sysapproval,approver,state,comments", 20, "all")
    ]);
    results.push({ scenario, request, items, approvals });
  }
  return results;
}

async function cleanup(api) {
  if (!confirmed) {
    throw new Error("Cleanup deletes demo records. Rerun with --confirm.");
  }

  const deleted = [];
  for (const scenario of scenarios) {
    const request = await findRequest(api, scenario);
    if (!request) continue;
    const requestSysId = rawValue(request.sys_id);
    const [items, approvals] = await Promise.all([
      tableList(api, "sc_req_item", `request=${requestSysId}`, "sys_id", 100),
      tableList(api, "sysapproval_approver", `sysapproval=${requestSysId}`, "sys_id", 100)
    ]);
    for (const approval of approvals) {
      await deleteRecord(api, "sysapproval_approver", rawValue(approval.sys_id));
    }
    for (const item of items) {
      await deleteRecord(api, "sc_req_item", rawValue(item.sys_id));
    }
    await deleteRecord(api, "sc_request", requestSysId);
    deleted.push({ key: scenario.key, requestSysId });
  }
  return deleted;
}

function summarizeUsers(users) {
  return Object.fromEntries(Object.entries(users).map(([key, user]) => [key, {
    sysId: rawValue(user.sys_id),
    userName: rawValue(user.user_name),
    name: rawValue(user.name),
    email: rawValue(user.email)
  }]));
}

function summarizeRecords(records) {
  return records.map(({ scenario, request, item, approval, items, approvals, missing }) => ({
    key: scenario.key,
    requestedFor: scenario.requestedFor,
    approver: scenario.approver,
    missing: missing || false,
    request: request ? {
      sysId: rawValue(request.sys_id),
      number: rawValue(request.number),
      state: displayValue(request.state),
      approval: displayValue(request.approval),
      requestedFor: displayValue(request.requested_for)
    } : null,
    item: item ? {
      sysId: rawValue(item.sys_id),
      number: rawValue(item.number)
    } : undefined,
    approvalRecord: approval ? {
      sysId: rawValue(approval.sys_id),
      state: displayValue(approval.state)
    } : undefined,
    itemCount: items?.length,
    approvals: approvals?.map(row => ({
      sysId: rawValue(row.sys_id),
      approver: displayValue(row.approver),
      state: displayValue(row.state)
    }))
  }));
}

async function main() {
  if (!["seed", "verify", "cleanup"].includes(command)) {
    throw new Error("Usage: seed-approval-demo.mjs <seed|verify|cleanup> [--confirm]");
  }

  const { api } = await createClient();
  const users = await resolveUsers(api);

  if (command === "cleanup") {
    const deleted = await cleanup(api);
    console.log(JSON.stringify({ command, deleted }, null, 2));
    return;
  }

  const catalogItem = await resolveCatalogItem(api);
  const records = command === "seed"
    ? await seed(api, users, catalogItem)
    : await verify(api, users);

  console.log(JSON.stringify({
    command,
    users: summarizeUsers(users),
    catalogItem: {
      sysId: rawValue(catalogItem.sys_id),
      name: rawValue(catalogItem.name)
    },
    records: summarizeRecords(records),
    prompts: {
      alex: "Show my recent ServiceNow orders and open the demo laptop approval.",
      admin: "Show my recent ServiceNow orders and open the demo executive laptop approval.",
      managerBySysId: "Open the ServiceNow order with sys_id <alex-manager request sysId> and show its pending approval."
    }
  }, null, 2));
}

main().catch(error => {
  const status = error?.response?.status;
  const body = error?.response?.data;
  console.error(`[demo-data] ${error?.message || String(error)}`);
  if (status) console.error(`[demo-data] HTTP ${status}`);
  if (body?.error?.message) console.error(`[demo-data] ${body.error.message}`);
  process.exit(1);
});

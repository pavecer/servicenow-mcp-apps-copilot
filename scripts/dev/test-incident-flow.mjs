#!/usr/bin/env node
// Live end-to-end integration test for the end-user INCIDENT flow against a real
// ServiceNow instance. Exercises the actual compiled ServiceNowClient methods
// (not mocks): report -> list -> detail -> comment -> attachment, with caller
// attribution (caller_id) resolved from a simulated caller identity.
//
// Unlike the offline vitest suite, this hits a live instance and is intended to
// be run manually with real credentials. It never runs in CI.
//
// Required env (or local.settings.json Values):
//   SERVICENOW_INSTANCE_URL, SERVICENOW_CLIENT_ID, SERVICENOW_CLIENT_SECRET,
//   SERVICENOW_USERNAME, SERVICENOW_PASSWORD, SERVICENOW_OAUTH_GRANT_TYPE
// Optional:
//   TEST_CALLER_UPN   caller identity to attribute the incident to (default: the
//                     SERVICENOW_USERNAME, matched against sys_user user_name/email)
//
// Usage:
//   npm run build
//   node scripts/dev/test-incident-flow.mjs            # creates + verifies, then deletes the test incident
//   node scripts/dev/test-incident-flow.mjs --keep     # keep the test incident in the instance
//
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import axios from "axios";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

// Load local.settings.json (Functions style) only for keys not already in env.
const settingsPath = path.join(repoRoot, "local.settings.json");
if (fs.existsSync(settingsPath)) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    for (const [k, v] of Object.entries(raw?.Values ?? {})) {
      if (process.env[k] === undefined && typeof v === "string") process.env[k] = v;
    }
  } catch (err) {
    console.error(`[warn] Failed to parse ${settingsPath}: ${err.message}`);
  }
}

process.env.ENTRA_AUTH_DISABLED = process.env.ENTRA_AUTH_DISABLED ?? "true";

const flags = {};
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=");
    if (eq === -1) flags[arg.slice(2)] = true;
    else flags[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
}

for (const required of ["SERVICENOW_INSTANCE_URL", "SERVICENOW_CLIENT_ID", "SERVICENOW_CLIENT_SECRET"]) {
  if (!process.env[required]) {
    console.error(`[error] Missing required env: ${required}`);
    process.exit(2);
  }
}

const distRoot = path.join(repoRoot, "dist");
if (!fs.existsSync(distRoot)) {
  console.error("[error] dist/ not found. Run 'npm run build' first.");
  process.exit(2);
}

const { ServiceNowClient } = await import(url.pathToFileURL(path.join(distRoot, "services", "servicenowClient.js")));
const { TokenManager } = await import(url.pathToFileURL(path.join(distRoot, "services", "tokenManager.js")));
const { runWithRequestContext } = await import(url.pathToFileURL(path.join(distRoot, "requestContext.js")));

const instanceUrl = process.env.SERVICENOW_INSTANCE_URL.replace(/\/$/, "");
const callerUpn = process.env.TEST_CALLER_UPN || process.env.SERVICENOW_USERNAME || "admin";

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) { passed++; console.log(`  \u2713 ${label}${detail ? "  \u2014 " + detail : ""}`); }
  else { failed++; console.log(`  \u2717 ${label}${detail ? "  \u2014 " + detail : ""}`); }
}

const client = new ServiceNowClient(new TokenManager());
const stamp = new Date().toISOString();
const shortDescription = `[automated test] Incident flow smoke ${stamp}`;

console.log(`\nLive incident-flow test against ${instanceUrl}`);
console.log(`Caller attribution: ${callerUpn}\n`);

let createdSysId = "";
let createdNumber = "";

try {
  await runWithRequestContext({ callerUpn }, async () => {
    // 1) report_incident
    console.log("1. report (create) incident");
    const created = await client.createIncident({
      shortDescription,
      description: "Created by scripts/dev/test-incident-flow.mjs to validate the incident flow.",
      category: "hardware",
      urgency: "3",
      impact: "3"
    });
    createdSysId = created.sys_id;
    createdNumber = created.number;
    check("incident created with a number + sys_id", Boolean(created.number && created.sys_id), created.number);

    // 2) list_user_incidents — the new incident should appear for this caller
    console.log("2. list user incidents (caller-scoped)");
    const list = await client.listUserIncidents(50);
    const found = list.find(r => String(r.sys_id) === createdSysId || String(r.number) === createdNumber);
    check("created incident appears in the caller's list", Boolean(found), `${list.length} incident(s) returned`);

    // 3) get_incident_detail — status + comments + attachments
    console.log("3. get incident detail");
    const detail = await client.getIncidentDetail(createdSysId);
    const detailNumber = detail.incident?.number?.display_value || detail.incident?.number?.value || detail.incident?.number;
    check("detail returns the same incident", String(detailNumber) === createdNumber, String(detailNumber));
    check("detail exposes comments[] and attachments[]", Array.isArray(detail.comments) && Array.isArray(detail.attachments));

    // 4) add_incident_comment — appears in the customer-visible journal
    console.log("4. add a customer-visible comment");
    const commentText = `Automated test comment ${stamp}`;
    await client.addIncidentComment(createdSysId, commentText);
    const afterComment = await client.getIncidentDetail(createdSysId);
    const hasComment = afterComment.comments.some(c => (c.value || "").includes("Automated test comment"));
    check("comment appears in the activity journal", hasComment, `${afterComment.comments.length} comment(s)`);

    // 5) add_incident_attachment — file shows up in the attachments list
    console.log("5. upload an attachment");
    const fileName = `mcp-test-${Date.now()}.txt`;
    const data = Buffer.from(`hello from the incident-flow test at ${stamp}`, "utf8");
    const att = await client.addIncidentAttachment(createdSysId, { fileName, contentType: "text/plain", data });
    check("attachment upload returns a sys_id + file name", Boolean(att.sysId && att.fileName), att.fileName);
    const afterAttach = await client.getIncidentDetail(createdSysId);
    const attFound = afterAttach.attachments.some(a => a.fileName === fileName);
    check("attachment appears in the incident's attachment list", attFound, `${afterAttach.attachments.length} attachment(s)`);
  });
} catch (err) {
  failed++;
  const msg = err?.response?.data ? JSON.stringify(err.response.data) : err?.message || String(err);
  console.error(`\n[error] ${msg}`);
}

// Cleanup: delete the test incident (cascades its attachment) unless --keep.
if (createdSysId && !flags.keep) {
  try {
    const username = process.env.SERVICENOW_USERNAME;
    const password = process.env.SERVICENOW_PASSWORD;
    if (username && password) {
      await axios.delete(`${instanceUrl}/api/now/table/incident/${createdSysId}`, {
        auth: { username, password }
      });
      console.log(`\nCleaned up test incident ${createdNumber}.`);
    } else {
      console.log(`\n[note] No basic-auth creds to delete the test incident; left ${createdNumber} in the instance.`);
    }
  } catch (err) {
    console.log(`\n[note] Could not delete test incident ${createdNumber}: ${err?.message || err}`);
  }
} else if (createdSysId) {
  console.log(`\nKept test incident ${createdNumber} (${instanceUrl}/incident.do?sys_id=${createdSysId}).`);
}

console.log(`\nResult: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);

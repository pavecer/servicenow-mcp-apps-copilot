#!/usr/bin/env node
/**
 * Quick survey across catalog items: fetches up to N items, prints a
 * one-line structural fingerprint per item so we can pick representative
 * shapes to probe with test-catalog-prefill.mjs.
 *
 * Usage:
 *   npm run build
 *   node scripts/dev/survey-catalog-items.mjs [limit] [--exclude=sys_id,sys_id,...]
 */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const settingsPath = path.join(repoRoot, "local.settings.json");
if (fs.existsSync(settingsPath)) {
  const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const values = raw?.Values ?? {};
  for (const [k, v] of Object.entries(values)) {
    if (process.env[k] === undefined && typeof v === "string") process.env[k] = v;
  }
}
process.env.ENTRA_AUTH_DISABLED = process.env.ENTRA_AUTH_DISABLED ?? "true";

const argv = process.argv.slice(2);
let limit = 60;
const exclude = new Set();
for (const arg of argv) {
  if (arg.startsWith("--exclude=")) {
    arg.slice(10).split(",").map(s => s.trim()).filter(Boolean).forEach(s => exclude.add(s));
  } else if (/^\d+$/.test(arg)) {
    limit = Number(arg);
  }
}

const distRoot = path.join(repoRoot, "dist");
const { ServiceNowClient } = await import(url.pathToFileURL(path.join(distRoot, "services", "servicenowClient.js")));
const { TokenManager } = await import(url.pathToFileURL(path.join(distRoot, "services", "tokenManager.js")));

const tm = new TokenManager();
const c = new ServiceNowClient(tm);

const items = await c.searchCatalogItems({ query: "", limit });
console.log(`sys_id | vars | container ref multi date number | name`);
console.log(`-`.repeat(100));

for (const it of items) {
  if (exclude.has(it.sys_id)) continue;
  try {
    const full = await c.getCatalogItem(it.sys_id);
    const vars = full.variables ?? [];
    if (vars.length < 1) continue;
    const t = (v) => Number(typeof v.type === "number" ? v.type : NaN);
    const hasContainer = vars.some(v => t(v) === 0 || /container|label/i.test(String(v.type ?? "")));
    const hasRef = vars.some(v => [18, 31].includes(t(v)));
    const hasMulti = vars.some(v => t(v) === 21);
    const hasDate = vars.some(v => [6, 8].includes(t(v)));
    const hasNumber = vars.some(v => [3, 4].includes(t(v)));
    console.log(
      `${it.sys_id} | ${String(vars.length).padStart(2)} | ` +
      `${hasContainer ? "Y" : "-"}         ` +
      `${hasRef ? "Y" : "-"}   ` +
      `${hasMulti ? "Y" : "-"}     ` +
      `${hasDate ? "Y" : "-"}    ` +
      `${hasNumber ? "Y" : "-"}      | ${it.name}`
    );
  } catch (e) {
    // skip items we can't load
  }
}

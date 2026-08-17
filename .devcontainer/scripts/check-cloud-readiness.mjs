#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

function capture(command, args, optional = false) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    if (optional) return "";
    throw new Error((result.stderr || "").trim() || `${command} ${args.join(" ")} failed`);
  }
  return (result.stdout || "").trim();
}

function requireCommand(command, versionArgs = ["--version"]) {
  capture(command, versionArgs);
  console.log(`[cloud-check] ${command}: available`);
}

function azdValue(key) {
  return capture("azd", ["env", "get-value", key], true);
}

async function main() {
  for (const [command, args] of [
    ["node", ["--version"]],
    ["npm", ["--version"]],
    ["git", ["--version"]],
    ["gh", ["--version"]],
    ["az", ["version"]],
    ["azd", ["version"]],
    ["func", ["--version"]],
    ["pwsh", ["--version"]],
    ["atk", ["--version"]]
  ]) {
    requireCommand(command, args);
  }

  const requiredFiles = [
    "local.settings.json",
    "m365-agent/env/.env.dev",
    "m365-agent/env/.env.dev.user"
  ];
  for (const relativePath of requiredFiles) {
    if (!fs.existsSync(path.join(repoRoot, relativePath))) {
      throw new Error(`${relativePath} is missing. Run npm run codespaces:configure after adding Codespaces secrets.`);
    }
  }
  console.log("[cloud-check] ignored runtime and M365 configuration files: available");

  const expectedSubscription = process.env.AZURE_SUBSCRIPTION_ID || azdValue("AZURE_SUBSCRIPTION_ID");
  const expectedTenant = process.env.AZURE_TENANT_ID || azdValue("AZURE_TENANT_ID");
  const resourceGroup = process.env.AZURE_RESOURCE_GROUP || azdValue("AZURE_RESOURCE_GROUP");
  const endpoint = process.env.MCP_ENDPOINT_URL || azdValue("MCP_ENDPOINT_URL");
  if (!expectedSubscription || !expectedTenant || !resourceGroup || !endpoint) {
    throw new Error("The azd environment is incomplete; expected subscription, tenant, resource group, and endpoint values.");
  }

  const account = JSON.parse(capture("az", ["account", "show", "--output", "json"]));
  if (account.id !== expectedSubscription || account.tenantId !== expectedTenant) {
    throw new Error(
      "Azure CLI is signed into the wrong management context. Run " +
      "az login --tenant $AZURE_TENANT_ID, then az account set --subscription $AZURE_SUBSCRIPTION_ID."
    );
  }
  capture("az", ["group", "show", "--name", resourceGroup, "--output", "none"]);
  console.log(`[cloud-check] Azure resource group ${resourceGroup}: accessible`);

  capture("gh", ["auth", "status"]);
  console.log("[cloud-check] GitHub CLI: authenticated");

  const healthUrl = new URL("/health", endpoint).toString();
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error(`Deployed health endpoint returned HTTP ${response.status}.`);
  }
  console.log(`[cloud-check] deployed Function health endpoint: HTTP ${response.status}`);
  console.log("[cloud-check] Base cloud workstation checks passed. Run npm run preflight:readiness to probe ServiceNow APIs.");
}

try {
  await main();
} catch (error) {
  console.error(`[cloud-check] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

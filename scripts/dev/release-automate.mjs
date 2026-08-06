#!/usr/bin/env node

/**
 * Copilot-ready automation:
 * - build
 * - test
 * - deploy to Azure using existing deploy-azure.ps1 (non-interactive from local settings)
 * - validate live MCP tools presence
 *
 * Stops here intentionally: human then tests by prompting M365 Copilot.
 *
 * Usage:
 *   npm run release:auto -- --environment snowmcpwidg-dev
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const settingsPath = path.join(repoRoot, "local.settings.json");

function getArg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return "";
  return process.argv[i + 1] ?? "";
}

function hasArg(name) {
  return process.argv.includes(name);
}

function runChecked(cmd, args, opts = {}) {
  console.log(`\n==> ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: opts.env || process.env,
    ...opts
  });

  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
  }
}

function runBestEffort(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: "ignore"
  });
  return result.status === 0;
}

function setStoragePublicAccess(storageArmUrl, value) {
  runChecked("az", [
    "rest",
    "--method",
    "patch",
    "--url",
    storageArmUrl,
    "--body",
    `{"properties":{"publicNetworkAccess":"${value}"}}`,
    "--output",
    "none"
  ]);
}

function ensureStoragePublicAccess(storageArmUrl) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    setStoragePublicAccess(storageArmUrl, "Enabled");
    const effectiveValue = runCapture("az", [
      "rest",
      "--method",
      "get",
      "--url",
      storageArmUrl,
      "--query",
      "properties.publicNetworkAccess",
      "--output",
      "tsv"
    ]);
    if (effectiveValue.toLowerCase() === "enabled") {
      return;
    }
    console.warn(`Storage policy exemption is still propagating (${attempt}/5).`);
  }
  throw new Error("Storage public access remained disabled after the temporary policy exemption was created.");
}

function deploySourcePackage() {
  const functionAppName = runCapture("azd", ["env", "get-value", "FUNCTION_APP_NAME"]);
  const resourceGroup = runCapture("azd", ["env", "get-value", "AZURE_RESOURCE_GROUP"]);
  const deploymentStorageUrl = runCapture("az", [
    "functionapp",
    "deployment",
    "config",
    "show",
    "--name",
    functionAppName,
    "--resource-group",
    resourceGroup,
    "--query",
    "storage.value",
    "--output",
    "tsv"
  ]);
  const storageAccountName = new URL(deploymentStorageUrl).hostname.split(".")[0];
  const subscriptionId = runCapture("az", ["account", "show", "--query", "id", "--output", "tsv"]);
  const storageId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}`;
  const storageArmUrl = `https://management.azure.com${storageId}?api-version=2023-05-01`;
  const packagePath = path.join(repoRoot, ".tmp", "copilot-ready-source.zip");
  const exemptionName = "copilot-ready-deploy";
  let exemptionCreated = false;

  fs.mkdirSync(path.dirname(packagePath), { recursive: true });
  fs.rmSync(packagePath, { force: true });

  runChecked("zip", [
    "-qr",
    packagePath,
    ".",
    "-x",
    ".git/*",
    "node_modules/*",
    "dist/*",
    ".tmp/*",
    ".azure/*",
    "local.settings.json",
    ".env",
    "env/*",
    "debug/*",
    "m365-agent/appPackage/build/*"
  ]);

  const publicNetworkAccess = runCapture("az", [
    "rest",
    "--method",
    "get",
    "--url",
    storageArmUrl,
    "--query",
    "properties.publicNetworkAccess",
    "--output",
    "tsv"
  ]);

  try {
    if (publicNetworkAccess.toLowerCase() === "disabled") {
      const policyJson = runCapture("az", [
        "policy",
        "state",
        "list",
        "--resource",
        storageId,
        "--filter",
        "PolicyDefinitionAction eq 'modify'",
        "--query",
        "[?policyDefinitionName=='StorageAccount_PublicNetwork_Modify'] | [0].{assignmentId:policyAssignmentId,referenceId:policyDefinitionReferenceId}",
        "--output",
        "json"
      ]);
      const policy = JSON.parse(policyJson || "null");
      if (!policy?.assignmentId || !policy?.referenceId) {
        throw new Error("Deployment storage is network-disabled, but no narrow public-network policy reference was found for a temporary exemption.");
      }

      const referenceId = policy.referenceId.toLowerCase() === "storageaccountpublicnetworkmodify"
        ? "StorageAccountPublicNetworkModify"
        : policy.referenceId;
      const expiresOn = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

      runBestEffort("az", ["policy", "exemption", "delete", "--name", exemptionName, "--scope", storageId, "--yes"]);
      runChecked("az", [
        "policy",
        "exemption",
        "create",
        "--name",
        exemptionName,
        "--scope",
        storageId,
        "--policy-assignment",
        policy.assignmentId,
        "--exemption-category",
        "Waiver",
        "--policy-definition-reference-ids",
        referenceId,
        "--display-name",
        "Temporary MCP deployment access",
        "--description",
        "Two-hour deployment-only exemption; automation removes it immediately after release.",
        "--expires-on",
        expiresOn,
        "--output",
        "none"
      ]);
      exemptionCreated = true;

      ensureStoragePublicAccess(storageArmUrl);
    }

    let deploymentError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        if (exemptionCreated) {
          ensureStoragePublicAccess(storageArmUrl);
        }
        runChecked("az", [
          "functionapp",
          "deployment",
          "source",
          "config-zip",
          "--name",
          functionAppName,
          "--resource-group",
          resourceGroup,
          "--src",
          packagePath,
          "--build-remote",
          "true",
          "--timeout",
          "600",
          "--output",
          "none"
        ]);
        deploymentError = undefined;
        break;
      } catch (error) {
        deploymentError = error;
        if (attempt < 3) {
          console.warn(`Flex deployment attempt ${attempt}/3 failed; refreshing policy-protected storage access.`);
        }
      }
    }
    if (deploymentError) {
      throw deploymentError;
    }
  } finally {
    if (exemptionCreated) {
      runBestEffort("az", ["policy", "exemption", "delete", "--name", exemptionName, "--scope", storageId, "--yes"]);
    }
    setStoragePublicAccess(storageArmUrl, "Disabled");
    fs.rmSync(packagePath, { force: true });
  }
}

function refreshM365Agent() {
  const projectPath = path.join(repoRoot, "m365-agent");
  const lifecyclePath = path.join(projectPath, "m365agents.yml");
  const buildPath = path.join(projectPath, "appPackage", "build");
  const originalLifecycle = fs.readFileSync(lifecyclePath, "utf8");
  const oauthStart = originalLifecycle.indexOf("  # Register the OAuth client");
  const packageStart = originalLifecycle.indexOf("  # Build app package with latest env value", oauthStart);

  if (oauthStart === -1 || packageStart === -1) {
    throw new Error("Could not isolate oauth/register in m365-agent/m365agents.yml.");
  }

  const releaseLifecycle = originalLifecycle.slice(0, oauthStart) + originalLifecycle.slice(packageStart);
  fs.rmSync(buildPath, { recursive: true, force: true });
  fs.writeFileSync(lifecyclePath, releaseLifecycle, "utf8");

  try {
    runChecked(
      "atk",
      ["provision", "--env", "dev", "--folder", projectPath, "--interactive", "false"],
      { env: { ...process.env, ATK_CLI_SKILL: "true" } }
    );
  } finally {
    fs.writeFileSync(lifecyclePath, originalLifecycle, "utf8");
  }
}

function publishM365Agent() {
  const projectPath = path.join(repoRoot, "m365-agent");
  runChecked(
    "atk",
    ["publish", "--env", "dev", "--folder", projectPath, "--interactive", "false"],
    { env: { ...process.env, ATK_CLI_SKILL: "true" } }
  );
}

function runCapture(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    const err = (result.stderr || "").trim() || `${cmd} failed`;
    throw new Error(err);
  }
  return (result.stdout || "").trim();
}

function runCaptureOptional(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0 ? (result.stdout || "").trim() : "";
}

function loadValues() {
  if (!fs.existsSync(settingsPath)) {
    throw new Error("local.settings.json not found. This automation requires local settings.");
  }
  const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  return raw?.Values ?? {};
}

function required(values, key) {
  const value = values[key];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required local.settings.json value: ${key}`);
  }
  return String(value).trim();
}

function main() {
  const environmentName = getArg("--environment") || process.env.AZD_ENV_NAME || "snowmcpwidg-dev";
  const publish = hasArg("--publish");

  const values = loadValues();
  const serviceNowInstanceUrl = required(values, "SERVICENOW_INSTANCE_URL");
  const serviceNowClientId = required(values, "SERVICENOW_CLIENT_ID");
  const serviceNowClientSecret = required(values, "SERVICENOW_CLIENT_SECRET");
  const serviceNowUsername = required(values, "SERVICENOW_USERNAME");
  const serviceNowPassword = required(values, "SERVICENOW_PASSWORD");

  const entraTenantId = String(values.ENTRA_TENANT_ID || "").trim();
  const entraClientId = String(values.ENTRA_CLIENT_ID || "").trim();
  const entraClientSecret = String(values.ENTRA_CLIENT_SECRET || "").trim();
  const entraAudience = String(values.ENTRA_AUDIENCE || "").trim();
  const entraOboEnabled = String(
    values.ENTRA_OBO_ENABLED
      || runCaptureOptional("azd", ["env", "get-value", "ENTRA_OBO_ENABLED"])
      || "false"
  ).trim();
  const entraOboDownstreamScope = String(
    values.ENTRA_OBO_DOWNSTREAM_SCOPE
      || runCaptureOptional("azd", ["env", "get-value", "ENTRA_OBO_DOWNSTREAM_SCOPE"])
      || ""
  ).trim();

  if (entraOboEnabled === "true" && !entraOboDownstreamScope) {
    throw new Error("ENTRA_OBO_ENABLED is true but ENTRA_OBO_DOWNSTREAM_SCOPE is missing.");
  }

  console.log("Starting Copilot-ready automation (build -> test -> deploy -> live validate).");

  runChecked("npm", ["run", "build"]);
  runChecked("npm", ["test"]);

  const deployEnv = {
    ...process.env,
    SERVICENOW_INSTANCE_URL: serviceNowInstanceUrl,
    SERVICENOW_CLIENT_ID: serviceNowClientId,
    SERVICENOW_CLIENT_SECRET: serviceNowClientSecret,
    SERVICENOW_USERNAME: serviceNowUsername,
    SERVICENOW_PASSWORD: serviceNowPassword,
    ENTRA_OBO_ENABLED: entraOboEnabled,
    ENTRA_OBO_DOWNSTREAM_SCOPE: entraOboDownstreamScope
  };

  if (entraTenantId && entraClientId && entraClientSecret) {
    deployEnv.ENTRA_TENANT_ID = entraTenantId;
    deployEnv.ENTRA_CLIENT_ID = entraClientId;
    deployEnv.ENTRA_CLIENT_SECRET = entraClientSecret;
    if (entraAudience) {
      deployEnv.ENTRA_AUDIENCE = entraAudience;
    }
  }

  runChecked(
    "pwsh",
    [
      "-File",
      "scripts/deploy-azure.ps1",
      "-EnvironmentName",
      environmentName,
      "-SkipNpmInstall",
      "-SkipBuild",
      "-SkipSmokeTest",
      "-ProvisionOnly"
    ],
    { env: deployEnv }
  );

  deploySourcePackage();

  const endpoint = runCapture("azd", ["env", "get-value", "MCP_ENDPOINT_URL"]);
  if (!endpoint) {
    throw new Error("Could not read MCP_ENDPOINT_URL from azd environment.");
  }

  runChecked("node", ["scripts/dev/validate-live-tools.mjs", "--endpoint", endpoint]);
  refreshM365Agent();
  if (publish) {
    publishM365Agent();
  }

  console.log("\nReady for M365 Copilot prompt testing.");
  console.log(`Endpoint: ${endpoint}`);
  if (publish) {
    console.log("Agent package submitted to the organizational catalog. Admin approval is still required.");
  }
  console.log("Next: open your test tenant agent and send prompts for catalog/order flow including pending approval actions.");
}

try {
  main();
} catch (error) {
  console.error(error?.message || String(error));
  process.exit(1);
}

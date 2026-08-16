#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const strict = process.argv.includes("--strict");
const outputRootArg = process.argv.indexOf("--output-root");
if (outputRootArg !== -1) {
  const outputRootValue = process.argv[outputRootArg + 1];
  if (!outputRootValue || outputRootValue.startsWith("--")) {
    throw new Error("--output-root requires a directory path.");
  }
}
const outputRoot = outputRootArg === -1
  ? repoRoot
  : path.resolve(process.argv[outputRootArg + 1]);

const runtimeRequired = [
  "SERVICENOW_INSTANCE_URL",
  "SERVICENOW_CLIENT_ID",
  "SERVICENOW_CLIENT_SECRET",
  "SERVICENOW_USERNAME",
  "SERVICENOW_PASSWORD",
  "ENTRA_TENANT_ID",
  "ENTRA_CLIENT_ID",
  "ENTRA_CLIENT_SECRET",
  "ENTRA_OBO_DOWNSTREAM_SCOPE"
];

const m365Required = [
  "TEAMS_APP_ID",
  "MCP_DA_OAUTH_CLIENT_ID_FUNCYJ453F",
  "MCP_DA_OAUTH_SCOPE_FUNCYJ453F",
  "MCP_DA_AUTH_ID_FUNCYJ453F",
  "TEAMS_APP_TENANT_ID",
  "M365_TITLE_ID",
  "M365_APP_ID",
  "MCP_SERVER_URL",
  "MCP_SERVER_HOST",
  "SECRET_MCP_DA_OAUTH_CLIENT_SECRET_FUNCYJ453F"
];

function missing(keys) {
  return keys.filter((key) => !String(process.env[key] ?? "").trim());
}

function writePrivateFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function configureFunctions() {
  const absent = missing(runtimeRequired);
  if (absent.length > 0) {
    console.warn(`[codespaces] Function settings not written; missing: ${absent.join(", ")}`);
    return false;
  }

  const samplePath = path.join(repoRoot, "local.settings.sample.json");
  const sample = JSON.parse(fs.readFileSync(samplePath, "utf8"));
  const values = { ...sample.Values };

  for (const key of Object.keys(values)) {
    if (process.env[key] !== undefined) {
      values[key] = process.env[key];
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(SERVICENOW_|ENTRA_|LOG_)/.test(key) || key === "CORS_ALLOWED_ORIGINS" || key === "MCP_APPS_PUBLIC_ORIGIN") {
      values[key] = value;
    }
  }

  values.AzureWebJobsStorage = process.env.AzureWebJobsStorage || "UseDevelopmentStorage=true";
  values.FUNCTIONS_WORKER_RUNTIME = "node";
  values.ENTRA_AUTH_DISABLED = process.env.ENTRA_AUTH_DISABLED || "true";
  values.ENTRA_OBO_ENABLED = process.env.ENTRA_OBO_ENABLED || "true";

  writePrivateFile(
    path.join(outputRoot, "local.settings.json"),
    `${JSON.stringify({ IsEncrypted: false, Values: values }, null, 2)}\n`
  );
  console.log("[codespaces] Wrote ignored local.settings.json from Codespaces secrets.");
  return true;
}

function envLine(key, fallback = "") {
  const value = String(process.env[key] ?? fallback).replace(/[\r\n]/g, "");
  return `${key}=${value}`;
}

function configureM365() {
  const absent = missing(m365Required);
  if (absent.length > 0) {
    console.warn(`[codespaces] M365 env files not written; missing: ${absent.join(", ")}`);
    return false;
  }

  const publicLines = [
    envLine("TEAMSFX_ENV", "dev"),
    envLine("APP_NAME_SUFFIX", "dev"),
    envLine("TEAMS_APP_ID"),
    envLine("MCP_DA_OAUTH_CLIENT_ID_FUNCYJ453F"),
    envLine("MCP_DA_OAUTH_SCOPE_FUNCYJ453F"),
    envLine("MCP_DA_AUTH_ID_FUNCYJ453F"),
    envLine("TEAMS_APP_TENANT_ID"),
    envLine("M365_TITLE_ID"),
    envLine("M365_APP_ID"),
    envLine("MCP_SERVER_URL"),
    envLine("MCP_SERVER_HOST"),
    envLine("AZURE_AI_OPENAI_ENDPOINT"),
    envLine("AZURE_AI_API_VERSION"),
    envLine("AZURE_AI_MODEL_NAME")
  ];
  const userLines = [
    envLine("SECRET_MCP_DA_OAUTH_CLIENT_SECRET_FUNCYJ453F"),
    envLine("AZURE_AI_API_KEY"),
    envLine("TEAMS_APP_UPDATE_TIME")
  ];

  writePrivateFile(path.join(outputRoot, "m365-agent", "env", ".env.dev"), `${publicLines.join("\n")}\n`);
  writePrivateFile(path.join(outputRoot, "m365-agent", "env", ".env.dev.user"), `${userLines.join("\n")}\n`);
  console.log("[codespaces] Wrote ignored M365 dev env files from Codespaces secrets.");
  return true;
}

const functionsReady = configureFunctions();
const m365Ready = configureM365();

if (strict && (!functionsReady || !m365Ready)) {
  process.exitCode = 2;
} else if (!functionsReady || !m365Ready) {
  console.warn("[codespaces] Setup is partial. Add the missing repository Codespaces secrets, then rebuild or restart the Codespace.");
}

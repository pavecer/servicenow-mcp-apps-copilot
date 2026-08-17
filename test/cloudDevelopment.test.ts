import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("Codespaces cloud development", () => {
  it("pins the cloud workstation and installs the required CLIs", () => {
    const config = JSON.parse(read(".devcontainer/devcontainer.json"));
    const postCreate = read(".devcontainer/post-create.sh");
    const postStart = read(".devcontainer/post-start.sh");

    expect(config.image).toContain("typescript-node:1-20-bookworm");
    expect(config.features).toHaveProperty("ghcr.io/devcontainers/features/azure-cli:1");
    expect(config.features).toHaveProperty("ghcr.io/azure/azure-dev/azd:0");
    expect(config.forwardPorts).toEqual(expect.arrayContaining([7071, 10000, 10001, 10002]));
    expect(postCreate).toContain("azure-functions-core-tools@4");
    expect(postCreate).toContain("@microsoft/m365agentstoolkit-cli");
    expect(postCreate).toContain("npm ci");
    expect(config.postStartCommand).toContain("post-start.sh");
    expect(postStart).toContain("azurite --silent");
  });

  it("materializes ignored Function and M365 files from environment values", () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snowmcp-codespaces-"));
    const env = {
      ...process.env,
      SERVICENOW_INSTANCE_URL: "https://example.service-now.com",
      SERVICENOW_CLIENT_ID: "sn-client",
      SERVICENOW_CLIENT_SECRET: "sn-secret",
      SERVICENOW_USERNAME: "integration-user",
      SERVICENOW_PASSWORD: "sn-password",
      ENTRA_TENANT_ID: "runtime-tenant",
      ENTRA_CLIENT_ID: "entra-client",
      ENTRA_CLIENT_SECRET: "entra-secret",
      ENTRA_OBO_DOWNSTREAM_SCOPE: "api://downstream/ServiceNow.Use",
      TEAMS_APP_ID: "teams-app",
      MCP_DA_OAUTH_CLIENT_ID_FUNCYJ453F: "oauth-client",
      MCP_DA_OAUTH_SCOPE_FUNCYJ453F: "api://entra-client/access_as_user",
      MCP_DA_AUTH_ID_FUNCYJ453F: "auth-reference",
      TEAMS_APP_TENANT_ID: "m365-tenant",
      M365_TITLE_ID: "m365-title",
      M365_APP_ID: "m365-app",
      MCP_SERVER_URL: "https://example.test/mcp",
      MCP_SERVER_HOST: "example.test",
      AZURE_AI_API_KEY: "azure-ai-secret",
      SECRET_MCP_DA_OAUTH_CLIENT_SECRET_FUNCYJ453F: "m365-secret"
    };

    try {
      execFileSync(
        process.execPath,
        [".devcontainer/scripts/configure-codespaces.mjs", "--strict", "--output-root", outputRoot],
        { cwd: root, env, stdio: "pipe" }
      );

      const settings = JSON.parse(fs.readFileSync(path.join(outputRoot, "local.settings.json"), "utf8"));
      const m365User = fs.readFileSync(
        path.join(outputRoot, "m365-agent", "env", ".env.dev.user"),
        "utf8"
      );
      const m365Public = fs.readFileSync(
        path.join(outputRoot, "m365-agent", "env", ".env.dev"),
        "utf8"
      );
      expect(settings.Values.SERVICENOW_INSTANCE_URL).toBe(env.SERVICENOW_INSTANCE_URL);
      expect(settings.Values.ENTRA_OBO_ENABLED).toBe("true");
      expect(m365User).toContain("SECRET_MCP_DA_OAUTH_CLIENT_SECRET_FUNCYJ453F=m365-secret");
      expect(m365User).toContain("AZURE_AI_API_KEY=azure-ai-secret");
      expect(m365Public).not.toContain("AZURE_AI_API_KEY");
    } finally {
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing value", ["--output-root"]],
    ["flag as value", ["--output-root", "--strict"]]
  ])("rejects a malformed output-root: %s", (_name, args) => {
    expect(() => execFileSync(
      process.execPath,
      [".devcontainer/scripts/configure-codespaces.mjs", ...args],
      { cwd: root, stdio: "pipe" }
    )).toThrow();
  });

  it("keeps the cloud agent, skill, and single approval gate discoverable", () => {
    const skill = read(".github/skills/cloud-development/SKILL.md");
    const agent = read(".github/agents/cloud-development.agent.md");
    const instructions = read(".github/copilot-instructions.md");
    const pullRequestTemplate = read(".github/PULL_REQUEST_TEMPLATE.md");
    const releasePlan = read("docs/RELEASE_PLAN.md");
    const humanApproval = read("docs/HUMAN_APPROVAL.md");
    const copilotSetup = read(".github/workflows/copilot-setup-steps.yml");
    const deployWorkflow = read(".github/workflows/deploy.yml");

    expect(skill).toMatch(/^---\r?\nname: cloud-development\r?\n/);
    expect(skill).toContain("Single human gate");
    expect(skill).toContain("ServiceNow test environment");
    expect(skill).toContain("M365 test tenant click-through");
    expect(agent).toMatch(/^---\r?\nname: Cloud Development\r?\n/);
    expect(agent).toContain("user-invocable: true");
    expect(instructions).toContain("## One human approval gate");
    expect(pullRequestTemplate).toContain("### Candidate evidence");
    expect(pullRequestTemplate).toContain("### Human test plan");
    expect(pullRequestTemplate).toContain("Manual steps and expected results");
    expect(pullRequestTemplate).toContain("ServiceNow verification");
    expect(pullRequestTemplate).toContain("Human result: PENDING");
    expect(pullRequestTemplate).toContain("Approval record: PENDING");
    expect(skill).toContain("HUMAN VALIDATION: PASS");
    expect(skill).toContain("HUMAN APPROVAL: MERGE");
    expect(humanApproval).toContain("Human validation and permission to");
    expect(humanApproval).toContain("merge are separate records");
    expect(humanApproval).toContain("Candidate SHA: <full 40-character SHA>");
    expect(humanApproval).toContain("comment-only review does not count as approval");
    expect(humanApproval).toContain("Any new commit invalidates the human validation and approval records");
    expect(pullRequestTemplate).toContain("docs/HUMAN_APPROVAL.md");
    expect(instructions).toContain("docs/HUMAN_APPROVAL.md");
    expect(read("AGENTS.md")).toContain("docs/HUMAN_APPROVAL.md");
    expect(skill).toContain("OIDC-backed `.github/workflows/deploy.yml`");
    expect(skill).toContain("Do not run `atk provision`");
    expect(read("docs/CODESPACES.md")).toContain("sole-maintainer repository");
    expect(read("docs/CODESPACES.md")).toContain("HUMAN APPROVAL: MERGE");
    expect(read("docs/CODESPACES.md")).toContain("## Authentication and autonomy matrix");
    expect(read("docs/CODESPACES.md")).toContain("azd pipeline config --provider github");
    expect(read("docs/CODESPACES.md")).toContain("do not support application permissions");
    expect(deployWorkflow).toContain("candidate_ref:");
    expect(deployWorkflow).toContain("ref: ${{ env.CANDIDATE_REF }}");
    expect(deployWorkflow).toContain("Azure/setup-azd@v2");
    expect(deployWorkflow).toContain("azd provision --no-prompt");
    expect(deployWorkflow).toContain("azd deploy --no-prompt");
    expect(deployWorkflow).toContain("secrets.SERVICENOW_CLIENT_SECRET");
    expect(deployWorkflow).toContain("Validate live MCP tools");
    expect(deployWorkflow).not.toContain("environment: ${{ vars.AZURE_ENV_NAME }}");
    expect(deployWorkflow).not.toContain("azd env refresh");
    expect(deployWorkflow).not.toContain("config-zip");
    expect(deployWorkflow).not.toMatch(/^\s{2}push:/m);
    expect(releasePlan).toContain("single development approval gate");
    expect(copilotSetup).toContain("copilot-setup-steps:");
    expect(copilotSetup).toContain("node-version: 20");
    expect(copilotSetup).toContain("run: npm ci");
    expect(copilotSetup).toContain("if [[ -f test/cloudDevelopment.test.ts ]]");
    expect(copilotSetup).not.toContain("secrets.");
  });
});

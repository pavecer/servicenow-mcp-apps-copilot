import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface McpRuntime {
  type: string;
  spec: {
    url: string;
    mcp_tool_description?: unknown;
  };
  run_for_functions: string[];
  auth: {
    type: string;
    reference_id: string;
  };
}

interface PluginManifest {
  functions: unknown[];
  runtimes: McpRuntime[];
}

const appPackagePath = path.join(process.cwd(), "m365-agent", "appPackage");
const plugin = JSON.parse(
  fs.readFileSync(path.join(appPackagePath, "ai-plugin.json"), "utf8")
) as PluginManifest;
const manifest = JSON.parse(
  fs.readFileSync(path.join(appPackagePath, "manifest.json"), "utf8")
) as {
  version: string;
  copilotAgents: { declarativeAgents: Array<{ id: string; file: string }> };
};
const declarativeAgent = JSON.parse(
  fs.readFileSync(path.join(appPackagePath, "declarativeAgent.json"), "utf8")
) as { actions: Array<{ id: string; file: string }> };
const lifecycle = fs.readFileSync(
  path.join(process.cwd(), "m365-agent", "m365agents.yml"),
  "utf8"
);
const releaseAutomation = fs.readFileSync(
  path.join(process.cwd(), "scripts", "dev", "release-automate.mjs"),
  "utf8"
);

describe("Microsoft 365 declarative agent MCP plugin", () => {
  it("wires the MCP plugin directly into the declarative agent", () => {
    expect(manifest.copilotAgents.declarativeAgents).toEqual([
      { id: "declarativeAgent", file: "declarativeAgent.json" }
    ]);
    expect(declarativeAgent.actions).toEqual([
      { id: "action_1", file: "ai-plugin.json" }
    ]);
  });

  it("uses dynamic tool discovery for the organizational package", () => {
    expect(plugin.functions).toEqual([]);
    expect(plugin.runtimes).toHaveLength(1);

    const runtime = plugin.runtimes[0];
    expect(runtime.type).toBe("RemoteMCPServer");
    expect(runtime.run_for_functions).toEqual(["*"]);
    expect(runtime.spec.url).toBe("${{MCP_SERVER_URL}}");
    expect(runtime.spec.mcp_tool_description).toBeUndefined();
    expect(fs.existsSync(path.join(appPackagePath, "mcp-tools-1.json"))).toBe(false);
  });

  it("preserves OAuthPluginVault authentication", () => {
    expect(plugin.runtimes[0].auth).toEqual({
      type: "OAuthPluginVault",
      reference_id: "${{MCP_DA_AUTH_ID_FUNCYJ453F}}"
    });
  });

  it("reconciles OAuth for both developer and published app identities", () => {
    expect(lifecycle).toContain("uses: oauth/register");
    expect(lifecycle).toContain("uses: oauth/update");
    expect(lifecycle.match(/applicableToApps: AnyApp/g)).toHaveLength(2);
    expect(lifecycle.match(/targetAudience: HomeTenant/g)).toHaveLength(2);
    expect(lifecycle).toContain("configurationId: ${{MCP_DA_AUTH_ID_FUNCYJ453F}}");
    expect(lifecycle).toContain("clientId: ${{MCP_DA_OAUTH_CLIENT_ID_FUNCYJ453F}}");
    expect(releaseAutomation).not.toContain("Could not isolate oauth/register");
  });

  it("keeps the M365 package version aligned with the canonical project version", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(manifest.version).toBe(packageJson.version);
  });
});
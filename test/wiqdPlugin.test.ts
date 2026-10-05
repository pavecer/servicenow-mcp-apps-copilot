import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getMinimalToolDefinitions } from "../src/tools/index";

const pluginRoot = resolve(process.cwd(), "wiqd-plugin");

describe("WIQD plugin contract", () => {
  it("declares the remote MCP connector and tool description", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(pluginRoot, "appPackage", "manifest.json"), "utf8")
    ) as {
      manifestVersion: string;
      agentConnectors: Array<{
        toolSource: {
          remoteMcpServer: {
            mcpServerUrl: string;
            mcpToolDescription: { file: string };
            authorization: { type: string; referenceId: string };
          };
        };
      }>;
    };

    const connector = manifest.agentConnectors[0].toolSource.remoteMcpServer;
    expect(manifest.manifestVersion).toBe("1.29");
    expect(connector.mcpServerUrl).toMatch(/^https:\/\/[^/]+\/mcp$/);
    expect(connector.mcpToolDescription.file).toBe("mcp-tool-description.json");
    expect(connector.authorization.type).toBe("OAuthPluginVault");
    expect(connector.authorization.referenceId).toBe(
      "REPLACE_WITH_OAUTH_PLUGIN_VAULT_REFERENCE_ID"
    );
  });

  it("keeps the checked-in MCP tool inventory in lockstep with the server", () => {
    const description = JSON.parse(
      readFileSync(
        resolve(pluginRoot, "appPackage", "mcp-tool-description.json"),
        "utf8"
      )
    ) as { tools: Array<{ name: string; description: string }> };
    const runtimeNames = getMinimalToolDefinitions()
      .map(tool => tool.name)
      .sort();
    const pluginNames = description.tools.map(tool => tool.name).sort();

    expect(description.tools).toHaveLength(runtimeNames.length);
    expect(pluginNames).toEqual(runtimeNames);
    expect(description.tools.every(tool => tool.description.length > 0)).toBe(true);
  });

  it("contains no credential-shaped values", () => {
    const files = [
      "wiqd.plugin.json",
      "appPackage/manifest.json",
      "appPackage/mcp-tool-description.json",
      "appPackage/skills/servicenow-self-service/SKILL.md"
    ].map(relativePath =>
      readFileSync(resolve(pluginRoot, relativePath), "utf8")
    );

    expect(files.join("\n")).not.toMatch(
      /client_secret|client-secret|password\s*[:=]|access[_-]?token/i
    );
  });
});

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getMinimalToolDefinitions } from "../src/tools/index";

interface RegistrationTemplate {
  serverName: string;
  description: string;
  tools: Array<{ name: string; description: string }>;
}

const templatePath = path.join(
  process.cwd(),
  "scripts",
  "agent365-mcp-registration.template.json"
);
const template = JSON.parse(fs.readFileSync(templatePath, "utf8")) as RegistrationTemplate;

describe("Agent 365 BYO MCP registration template", () => {
  it("matches the runtime MCP tool inventory exactly", () => {
    const runtimeNames = getMinimalToolDefinitions().map(tool => tool.name).sort();
    const registrationNames = template.tools.map(tool => tool.name).sort();

    expect(registrationNames).toEqual(runtimeNames);
  });

  it("satisfies Agent 365 registration limits", () => {
    expect(template.serverName).toMatch(/^ext_/);
    expect(template.serverName.length).toBeLessThanOrEqual(20);
    expect(template.description.length).toBeLessThanOrEqual(80);

    for (const tool of template.tools) {
      expect(tool.name.length).toBeLessThanOrEqual(30);
      expect(tool.description.trim().length).toBeGreaterThan(0);
    }
  });
});

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const skillPath = path.join(root, ".github/skills/release-communications/SKILL.md");
const agentPath = path.join(root, ".github/agents/release-communications.agent.md");
const templatePath = path.join(
  root,
  ".github/skills/release-communications/assets/linkedin-announcement.md"
);

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("release communications customization", () => {
  it("keeps the skill, agent, and LinkedIn template discoverable", () => {
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.existsSync(agentPath)).toBe(true);
    expect(fs.existsSync(templatePath)).toBe(true);

    const skill = fs.readFileSync(skillPath, "utf8");
    const agent = fs.readFileSync(agentPath, "utf8");
    expect(skill).toMatch(/^---\nname: release-communications\n/);
    expect(skill).toContain("description:");
    expect(skill).toContain("./assets/linkedin-announcement.md");
    expect(agent).toMatch(/^---\nname: Release Communications\n/);
    expect(agent).toContain("user-invocable: true");
  });

  it("requires a released version and exact-draft approval before LinkedIn publication", () => {
    const skill = fs.readFileSync(skillPath, "utf8");
    const agent = fs.readFileSync(agentPath, "utf8");
    const template = fs.readFileSync(templatePath, "utf8");

    expect(skill).toContain("Never announce an `Unreleased` section as shipped.");
    expect(skill).toContain("approves the exact current draft");
    expect(skill).toContain("Edits after approval invalidate it");
    expect(agent).toContain("Do not push directly to `main`.");
    expect(template).toContain("Status: Draft - not approved for publication");
    expect(template).toContain("The final text has explicit user approval.");
  });

  it("documents the workflow in the release plan and repository guide", () => {
    expect(read("docs/RELEASE_PLAN.md")).toContain("## Release Communications");
    expect(read("docs/RELEASE_PLAN.md")).toContain("release-comms/");
    expect(read("AGENTS.md")).toContain(".github/skills/release-communications/");
  });
});
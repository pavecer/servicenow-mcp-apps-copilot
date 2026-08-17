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
const workflowPath = path.join(root, ".github/workflows/release-communications.yml");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("release communications customization", () => {
  it("keeps the skill, agent, and LinkedIn template discoverable", () => {
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.existsSync(agentPath)).toBe(true);
    expect(fs.existsSync(templatePath)).toBe(true);
    expect(fs.existsSync(workflowPath)).toBe(true);

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

  it("ties the public site to a released baseline and matching announcement draft", () => {
    const site = read("site/index.html");
    const releaseVersion = site.match(/<body data-release-version="(v\d+\.\d+\.\d+)">/)?.[1];

    expect(releaseVersion).toBeDefined();
    expect(read("CHANGELOG.md")).toMatch(
      new RegExp(`## \\[${releaseVersion?.slice(1)}\\] - \\d{4}-\\d{2}-\\d{2}`)
    );
    expect(site).toContain(
      `https://github.com/pavecer/servicenow-mcp-apps-copilot/releases/tag/${releaseVersion}`
    );
    expect(site).not.toMatch(/feature branch|test-only|test deployment|candidate/i);

    const draft = read(`release-comms/${releaseVersion}-linkedin.md`);
    expect(draft).toContain("Status: Draft - not approved for publication");
    expect(draft).toContain(
      `https://github.com/pavecer/servicenow-mcp-apps-copilot/releases/tag/${releaseVersion}`
    );
    expect(draft).toContain("https://pavecer.github.io/servicenow-mcp-apps-copilot/");
  });

  it("creates one cloud communications work item after a successful release", () => {
    const workflow = fs.readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain("workflows: [release]");
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("actions/github-script@v8");
    expect(workflow).toContain("Release communications: ${version}");
    expect(workflow).toContain("Communications issue already exists");
    expect(workflow).toContain("Release Communications");
    expect(workflow).toContain("never publish or schedule LinkedIn content");
    expect(workflow).not.toContain("pages: write");
  });
});
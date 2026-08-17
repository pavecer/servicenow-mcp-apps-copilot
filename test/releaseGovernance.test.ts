import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const script = path.join(root, "scripts/dev/release-governance.mjs");
const temporaryDirectories: string[] = [];
const GOVERNANCE_NOTE = "Add enforceable release planning and version checks for contributors.";

function temporaryFile(contents: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "release-governance-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "fixture.txt");
  fs.writeFileSync(file, contents);
  return file;
}

function prBody(
  releaseNote: string,
  validation = "Completed maintainer workflow review",
  impact = "Minor",
  prKind = "Regular change"
): string {
  return [
    "## Release impact",
    "- [ ] None — docs, tests, dependencies, or internal maintenance only",
    `${impact === "Patch" ? "- [x]" : "- [ ]"} Patch — backward-compatible bug fix or security correction`,
    `${impact === "Minor" ? "- [x]" : "- [ ]"} Minor — backward-compatible user-facing capability`,
    `${impact === "Major" ? "- [x]" : "- [ ]"} Major — breaking API, configuration, behavior, or support change`,
    "",
    "## PR kind",
    `${prKind === "Regular change" ? "- [x]" : "- [ ]"} Regular change`,
    `${prKind === "Version release" ? "- [x]" : "- [ ]"} Version release — generated with npm run release:prepare`,
    "",
    "## Release note",
    releaseNote,
    "",
    "## Human validation",
    `${validation === "Not required" ? "- [x]" : "- [ ]"} Not required — no user-facing behavior changed`,
    `${validation === "Completed maintainer workflow review" ? "- [x]" : "- [ ]"} Completed maintainer workflow review — release/CI tooling only`,
    `${validation === "Completed in test tenant" ? "- [x]" : "- [ ]"} Completed in test tenant`,
    "",
    "## Human validation evidence",
    "No runtime behavior changed; this is repository governance only."
  ].join("\n");
}

function currentVersion(): string {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
}

function basePackage(version = currentVersion()): string {
  const current = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  current.version = version;
  return temporaryFile(`${JSON.stringify(current, null, 2)}\n`);
}

function baseLock(version = currentVersion()): string {
  const current = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  current.version = version;
  current.packages[""].version = version;
  return temporaryFile(`${JSON.stringify(current, null, 2)}\n`);
}

function governanceFixture(options: { version?: string; releaseNote?: string; impact?: "patch" | "minor" | "major" } = {}) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "governance-repo-"));
  temporaryDirectories.push(fixtureRoot);
  fs.mkdirSync(path.join(fixtureRoot, "scripts/dev"), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, "m365-agent/appPackage"), { recursive: true });
  for (const relativePath of [
    "scripts/dev/release-governance.mjs", "package.json", "package-lock.json",
    "m365-agent/appPackage/manifest.json"
  ]) fs.copyFileSync(path.join(root, relativePath), path.join(fixtureRoot, relativePath));

  const version = options.version ?? currentVersion();
  for (const relativePath of ["package.json", "package-lock.json", "m365-agent/appPackage/manifest.json"]) {
    const filePath = path.join(fixtureRoot, relativePath);
    const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
    json.version = version;
    if (relativePath === "package-lock.json") json.packages[""].version = version;
    fs.writeFileSync(filePath, `${JSON.stringify(json, null, relativePath.includes("manifest") ? 4 : 2)}\n`);
  }
  const note = options.releaseNote ?? GOVERNANCE_NOTE;
  const impact = options.impact ?? "minor";
  fs.writeFileSync(path.join(fixtureRoot, "CHANGELOG.md"), [
    "# Changelog", "", "## [Unreleased]", "", "### Added", "", `- ${note}`,
    `<!-- release-impact: ${impact} -->`, "", `## [${version}] - 2026-08-09`, "", "Baseline.", ""
  ].join("\n"));
  return { fixtureRoot, fixtureScript: path.join(fixtureRoot, "scripts/dev/release-governance.mjs"), version };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("release governance", () => {
  it("keeps package and M365 versions aligned", () => {
    const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
    expect(execFileSync("node", [script, "check"], { cwd: root, encoding: "utf8" })).toContain(version);
  });

  it("accepts a classified PR whose release note is in Unreleased", () => {
    const releaseNote = GOVERNANCE_NOTE;
    const fixture = governanceFixture();
    const body = temporaryFile(prBody(releaseNote));
    const changed = temporaryFile("CHANGELOG.md\nscripts/dev/release-governance.mjs\n");
    const base = temporaryFile(`# Changelog\n\n## [Unreleased]\n\n### Added\n\n## [${fixture.version}] - 2026-08-09\n\nBaseline.\n`);
    const output = execFileSync("node", [fixture.fixtureScript, "pr-check", "--body-file", body, "--changed-files", changed, "--base-changelog", base, "--base-package", basePackage(fixture.version), "--json"], {
      cwd: fixture.fixtureRoot,
      encoding: "utf8"
    });
    expect(JSON.parse(output)).toMatchObject({ impact: "minor", prKind: "Regular change", humanValidation: "Completed maintainer workflow review" });
  });

  it("rejects a release-bearing PR that omits the changelog", () => {
    const fixture = governanceFixture();
    const body = temporaryFile(prBody(GOVERNANCE_NOTE));
    const changed = temporaryFile("scripts/dev/release-governance.mjs\n");
    const result = spawnSync("node", [fixture.fixtureScript, "pr-check", "--body-file", body, "--changed-files", changed, "--base-package", basePackage(fixture.version)], {
      cwd: fixture.fixtureRoot,
      encoding: "utf8"
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/must update CHANGELOG\.md/i);
  });

  it("rejects ambiguous release impact and mismatched tags", () => {
    const fixture = governanceFixture();
    const body = temporaryFile(prBody(GOVERNANCE_NOTE)
      .replace("- [ ] Patch", "- [x] Patch"));
    const changed = temporaryFile("CHANGELOG.md\n");
    const prResult = spawnSync("node", [fixture.fixtureScript, "pr-check", "--body-file", body, "--changed-files", changed, "--base-package", basePackage(fixture.version)], {
      cwd: fixture.fixtureRoot,
      encoding: "utf8"
    });
    expect(prResult.status).toBe(1);
    expect(prResult.stderr).toMatch(/exactly one release impact/i);

    const tagResult = spawnSync("node", [script, "check", "--tag", "v2.0.0"], { cwd: root, encoding: "utf8" });
    expect(tagResult.status).toBe(1);
    expect(tagResult.stderr).toMatch(/does not match canonical version/i);
  });

  it("rejects release impact without tenant validation or a newly added note", () => {
    const releaseNote = GOVERNANCE_NOTE;
    const fixture = governanceFixture();
    const changed = temporaryFile("CHANGELOG.md\n");
    const baseWithoutNote = temporaryFile(`# Changelog\n\n## [Unreleased]\n\n### Added\n\n## [${fixture.version}] - 2026-08-09\n\nBaseline.\n`);
    const validationResult = spawnSync("node", [
      fixture.fixtureScript, "pr-check", "--body-file", temporaryFile(prBody(releaseNote, "Not required")),
      "--changed-files", changed, "--base-changelog", baseWithoutNote, "--base-package", basePackage(fixture.version)
    ], { cwd: fixture.fixtureRoot, encoding: "utf8" });
    expect(validationResult.status).toBe(1);
    expect(validationResult.stderr).toMatch(/require 'Completed maintainer workflow review'/i);

    const baseWithNote = temporaryFile(`# Changelog\n\n## [Unreleased]\n\n- ${releaseNote}\n<!-- release-impact: minor -->\n\n## [${fixture.version}] - 2026-08-09\n\nBaseline.\n`);
    const provenanceResult = spawnSync("node", [
      fixture.fixtureScript, "pr-check", "--body-file", temporaryFile(prBody(releaseNote)),
      "--changed-files", changed, "--base-changelog", baseWithNote, "--base-package", basePackage(fixture.version)
    ], { cwd: fixture.fixtureRoot, encoding: "utf8" });
    expect(provenanceResult.status).toBe(1);
    expect(provenanceResult.stderr).toMatch(/already existed in the base changelog/i);
  });

  it("does not accept release-note text hidden inside HTML comments", () => {
    const releaseNote = "Document a visible release-governance improvement for users.";
    const hiddenRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hidden-note-"));
    temporaryDirectories.push(hiddenRoot);
    fs.copyFileSync(path.join(root, "package.json"), path.join(hiddenRoot, "package.json"));
    fs.copyFileSync(path.join(root, "package-lock.json"), path.join(hiddenRoot, "package-lock.json"));
    fs.mkdirSync(path.join(hiddenRoot, "m365-agent/appPackage"), { recursive: true });
    fs.copyFileSync(path.join(root, "m365-agent/appPackage/manifest.json"), path.join(hiddenRoot, "m365-agent/appPackage/manifest.json"));
    fs.mkdirSync(path.join(hiddenRoot, "scripts/dev"), { recursive: true });
    fs.copyFileSync(script, path.join(hiddenRoot, "scripts/dev/release-governance.mjs"));
    fs.writeFileSync(path.join(hiddenRoot, "CHANGELOG.md"), [
      "# Changelog", "", "## [Unreleased]", "", `<!-- ${releaseNote} -->`,
      "<!-- release-impact: minor -->", "", "## [1.1.6] - 2026-08-10", "", "Baseline.", ""
    ].join("\n"));
    const result = spawnSync("node", [
      path.join(hiddenRoot, "scripts/dev/release-governance.mjs"), "pr-check",
      "--body-file", temporaryFile(prBody(releaseNote)),
      "--changed-files", temporaryFile("CHANGELOG.md\n"),
      "--base-changelog", temporaryFile("# Changelog\n\n## [Unreleased]\n\n## [1.1.6] - 2026-08-10\n\nBaseline.\n"),
      "--base-package", basePackage()
    ], { cwd: hiddenRoot, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/must also appear in CHANGELOG\.md/i);
  });

  it("requires release impact and tenant validation for runtime changes", () => {
    const releaseNote = "Add enforceable release planning and version checks for contributors.";
    const base = temporaryFile("# Changelog\n\n## [Unreleased]\n\n### Added\n\n## [1.1.6]\n\nBaseline.\n");
    const runtimeFiles = temporaryFile("CHANGELOG.md\nsrc/server.ts\n");
    const tenantResult = spawnSync("node", [
      script, "pr-check", "--body-file", temporaryFile(prBody(releaseNote)),
      "--changed-files", runtimeFiles, "--base-changelog", base, "--base-package", basePackage()
    ], { cwd: root, encoding: "utf8" });
    expect(tenantResult.status).toBe(1);
    expect(tenantResult.stderr).toMatch(/require 'Completed in test tenant'/i);

    const noneBody = prBody("N/A", "Not required", "Minor")
      .replace("- [ ] None", "- [x] None")
      .replace("- [x] Minor", "- [ ] Minor");
    const noneResult = spawnSync("node", [
      script, "pr-check", "--body-file", temporaryFile(noneBody),
      "--changed-files", runtimeFiles, "--base-changelog", base, "--base-package", basePackage()
    ], { cwd: root, encoding: "utf8" });
    expect(noneResult.status).toBe(1);
    expect(noneResult.stderr).toMatch(/None cannot be used for runtime/i);
  });

  it("treats M365 Markdown as docs and requires workflow review for CI changes", () => {
    const docs = temporaryFile("m365-agent/README.md\n");
    const docsResult = execFileSync("node", [
      script, "pr-check", "--body-file", temporaryFile(prBody("N/A", "Not required", "Minor")
        .replace("- [ ] None", "- [x] None")
        .replace("- [x] Minor", "- [ ] Minor")),
      "--changed-files", docs, "--base-package", basePackage(), "--json"
    ], { cwd: root, encoding: "utf8" });
    expect(JSON.parse(docsResult)).toMatchObject({ impact: "none", humanValidation: "Not required" });

    const workflow = temporaryFile(".github/workflows/ci.yml\n");
    const workflowResult = spawnSync("node", [
      script, "pr-check", "--body-file", temporaryFile(prBody("N/A", "Not required", "Minor")
        .replace("- [ ] None", "- [x] None")
        .replace("- [x] Minor", "- [ ] Minor")),
      "--changed-files", workflow, "--base-package", basePackage()
    ], { cwd: root, encoding: "utf8" });
    expect(workflowResult.status).toBe(1);
    expect(workflowResult.stderr).toMatch(/Completed maintainer workflow review/i);
  });

  it("allows development-only dependency maintenance to use None impact", () => {
    const basePackageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    basePackageJson.devDependencies.vitest = "0.0.1";
    const baseLockJson = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    baseLockJson.packages[""].devDependencies.vitest = "0.0.1";
    if (baseLockJson.packages["node_modules/vitest"]) {
      baseLockJson.packages["node_modules/vitest"].version = "0.0.1";
      baseLockJson.packages["node_modules/vitest"].dev = true;
    }
    const body = temporaryFile(prBody("N/A", "Not required", "Minor")
      .replace("- [ ] None", "- [x] None")
      .replace("- [x] Minor", "- [ ] Minor"));
    const output = execFileSync("node", [
      script, "pr-check", "--body-file", body,
      "--changed-files", temporaryFile("package.json\npackage-lock.json\n"),
      "--base-package", temporaryFile(`${JSON.stringify(basePackageJson, null, 2)}\n`),
      "--base-lock", temporaryFile(`${JSON.stringify(baseLockJson, null, 2)}\n`),
      "--json"
    ], { cwd: root, encoding: "utf8" });
    expect(JSON.parse(output)).toMatchObject({ impact: "none", humanValidation: "Not required" });
  });

  it("infers safe metadata only for development-only npm Dependabot updates", () => {
    const basePackageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    basePackageJson.devDependencies.vitest = "0.0.1";
    const baseLockJson = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    baseLockJson.packages[""].devDependencies.vitest = "0.0.1";
    if (baseLockJson.packages["node_modules/vitest"]) {
      baseLockJson.packages["node_modules/vitest"].version = "0.0.1";
      baseLockJson.packages["node_modules/vitest"].dev = true;
    }
    const event = temporaryFile(JSON.stringify({
      pull_request: {
        user: { login: "dependabot[bot]" },
        body: "Bumps a development dependency."
      }
    }));
    const output = execFileSync("node", [
      script, "pr-check", "--event", event,
      "--changed-files", temporaryFile("package.json\npackage-lock.json\n"),
      "--base-package", temporaryFile(`${JSON.stringify(basePackageJson, null, 2)}\n`),
      "--base-lock", temporaryFile(`${JSON.stringify(baseLockJson, null, 2)}\n`),
      "--json"
    ], { cwd: root, encoding: "utf8" });
    expect(JSON.parse(output)).toMatchObject({
      impact: "none",
      prKind: "Regular change",
      humanValidation: "Not required"
    });
  });

  it("keeps production Dependabot updates on the reviewed Patch path", () => {
    const basePackageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    basePackageJson.dependencies.axios = "0.0.1";
    const event = temporaryFile(JSON.stringify({
      pull_request: {
        user: { login: "dependabot[bot]" },
        body: "Bumps a production dependency."
      }
    }));
    const result = spawnSync("node", [
      script, "pr-check", "--event", event,
      "--changed-files", temporaryFile("package.json\npackage-lock.json\n"),
      "--base-package", temporaryFile(`${JSON.stringify(basePackageJson, null, 2)}\n`)
    ], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Production Dependabot updates require reviewed Patch metadata/i);
  });

  it("prepares a synchronized patch release and extracts its notes", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-prepare-"));
    temporaryDirectories.push(fixtureRoot);
    fs.mkdirSync(path.join(fixtureRoot, "scripts/dev"), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, "m365-agent/appPackage"), { recursive: true });
    for (const relativePath of [
      "scripts/dev/release-governance.mjs",
      "package.json",
      "package-lock.json",
      "m365-agent/appPackage/manifest.json",
      "CHANGELOG.md"
    ]) {
      fs.copyFileSync(path.join(root, relativePath), path.join(fixtureRoot, relativePath));
    }

    const fixtureScript = path.join(fixtureRoot, "scripts/dev/release-governance.mjs");
    const currentVersion = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "package.json"), "utf8")).version as string;
    const [major, minor, patch] = currentVersion.split(".").map(Number);
    const expectedVersion = `${major}.${minor}.${patch + 1}`;
    fs.writeFileSync(path.join(fixtureRoot, "CHANGELOG.md"), [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "### Added",
      "",
      "- Add enforceable release planning and version checks for contributors.",
      "<!-- release-impact: patch -->",
      "",
      `## [${currentVersion}] - 2026-08-09`,
      "",
      "### Added",
      "",
      "- Baseline release.",
      ""
    ].join("\n"));
    execFileSync("node", [fixtureScript, "prepare", "--type", "patch", "--date", "2026-08-10"], { cwd: fixtureRoot });
    const versions = [
      JSON.parse(fs.readFileSync(path.join(fixtureRoot, "package.json"), "utf8")).version,
      JSON.parse(fs.readFileSync(path.join(fixtureRoot, "package-lock.json"), "utf8")).version,
      JSON.parse(fs.readFileSync(path.join(fixtureRoot, "m365-agent/appPackage/manifest.json"), "utf8")).version
    ];
    expect(versions).toEqual([expectedVersion, expectedVersion, expectedVersion]);
    expect(execFileSync("node", [fixtureScript, "notes", "--version", expectedVersion], { cwd: fixtureRoot, encoding: "utf8" }))
      .toContain("release planning");
    const changelog = fs.readFileSync(path.join(fixtureRoot, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain(`[Unreleased]: https://github.com/pavecer/servicenow-mcp-apps-copilot/compare/v${expectedVersion}...HEAD`);
    expect(changelog).toContain(`[${expectedVersion}]: https://github.com/pavecer/servicenow-mcp-apps-copilot/releases/tag/v${expectedVersion}`);
  });

  it("refuses a release below the highest queued impact", () => {
    const fixture = governanceFixture();
    const result = spawnSync("node", [fixture.fixtureScript, "plan", "--type", "patch"], { cwd: fixture.fixtureRoot, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/understates queued minor changes/i);
    expect(execFileSync("node", [fixture.fixtureScript, "plan", "--type", "minor"], { cwd: fixture.fixtureRoot, encoding: "utf8" }))
      .toContain("requiredType: minor");
  });

  it("validates a prepared version-release PR against its SemVer delta", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-pr-"));
    temporaryDirectories.push(fixtureRoot);
    fs.mkdirSync(path.join(fixtureRoot, "scripts/dev"), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, "m365-agent/appPackage"), { recursive: true });
    for (const relativePath of [
      "scripts/dev/release-governance.mjs",
      "package.json",
      "package-lock.json",
      "m365-agent/appPackage/manifest.json",
      "CHANGELOG.md"
    ]) {
      fs.copyFileSync(path.join(root, relativePath), path.join(fixtureRoot, relativePath));
    }
    const basePackage = temporaryFile(fs.readFileSync(path.join(fixtureRoot, "package.json"), "utf8"));
    const fixtureScript = path.join(fixtureRoot, "scripts/dev/release-governance.mjs");
    const fixtureVersion = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "package.json"), "utf8")).version as string;
    fs.writeFileSync(path.join(fixtureRoot, "CHANGELOG.md"), [
      "# Changelog", "", "## [Unreleased]", "", "### Added", "", `- ${GOVERNANCE_NOTE}`,
      "<!-- release-impact: minor -->", "", `## [${fixtureVersion}] - 2026-08-09`, "", "Baseline.", ""
    ].join("\n"));
    execFileSync("node", [fixtureScript, "prepare", "--type", "minor", "--date", "2026-08-10"], { cwd: fixtureRoot });
    const releaseNote = GOVERNANCE_NOTE;
    const body = temporaryFile(prBody(releaseNote, "Completed in test tenant", "Minor", "Version release"));
    const changed = temporaryFile("CHANGELOG.md\npackage.json\npackage-lock.json\nm365-agent/appPackage/manifest.json\n");
    const output = execFileSync("node", [
      fixtureScript,
      "pr-check",
      "--body-file", body,
      "--changed-files", changed,
      "--base-package", basePackage,
      "--json"
    ], { cwd: fixtureRoot, encoding: "utf8" });
    expect(JSON.parse(output)).toMatchObject({ impact: "minor", prKind: "Version release" });

    const emptyNoteResult = spawnSync("node", [
      fixtureScript,
      "pr-check",
      "--body-file", temporaryFile(prBody("", "Completed in test tenant", "Minor", "Version release")),
      "--changed-files", changed,
      "--base-package", basePackage
    ], { cwd: fixtureRoot, encoding: "utf8" });
    expect(emptyNoteResult.status).toBe(1);
    expect(emptyNoteResult.stderr).toMatch(/meaningful user-facing Release note/i);

    const manifest = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "package.json"), "utf8"));
    const changelogPath = path.join(fixtureRoot, "CHANGELOG.md");
    fs.writeFileSync(changelogPath, fs.readFileSync(changelogPath, "utf8")
      .replace(`## [${manifest.version}] - 2026-08-10`, `## [${manifest.version}]`));
    const undatedResult = spawnSync("node", [
      fixtureScript,
      "pr-check",
      "--body-file", body,
      "--changed-files", changed,
      "--base-package", basePackage
    ], { cwd: fixtureRoot, encoding: "utf8" });
    expect(undatedResult.status).toBe(1);
    expect(undatedResult.stderr).toMatch(/must have a YYYY-MM-DD release date/i);
    const undatedTagCheck = spawnSync("node", [fixtureScript, "check"], { cwd: fixtureRoot, encoding: "utf8" });
    expect(undatedTagCheck.status).toBe(1);
    expect(undatedTagCheck.stderr).toMatch(/must have a YYYY-MM-DD release date/i);
  });

  it("rejects a version release below the impact moved into its dated section", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "understated-release-"));
    temporaryDirectories.push(fixtureRoot);
    fs.mkdirSync(path.join(fixtureRoot, "scripts/dev"), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, "m365-agent/appPackage"), { recursive: true });
    for (const relativePath of [
      "scripts/dev/release-governance.mjs", "package.json", "package-lock.json",
      "m365-agent/appPackage/manifest.json", "CHANGELOG.md"
    ]) {
      fs.copyFileSync(path.join(root, relativePath), path.join(fixtureRoot, relativePath));
    }
    const fixtureScript = path.join(fixtureRoot, "scripts/dev/release-governance.mjs");
    const basePackageFile = temporaryFile(fs.readFileSync(path.join(fixtureRoot, "package.json"), "utf8"));
    const baseVersion = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "package.json"), "utf8")).version as string;
    const [baseMajor, baseMinor, basePatch] = baseVersion.split(".").map(Number);
    const patchVersion = `${baseMajor}.${baseMinor}.${basePatch + 1}`;
    for (const relativePath of ["package.json", "package-lock.json", "m365-agent/appPackage/manifest.json"]) {
      const filePath = path.join(fixtureRoot, relativePath);
      const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
      json.version = patchVersion;
      if (relativePath === "package-lock.json") json.packages[""].version = patchVersion;
      fs.writeFileSync(filePath, `${JSON.stringify(json, null, relativePath.includes("manifest") ? 4 : 2)}\n`);
    }
    fs.writeFileSync(path.join(fixtureRoot, "CHANGELOG.md"), [
      "# Changelog", "", "## [Unreleased]", "", "### Added", "",
      `## [${patchVersion}] - 2026-08-10`, "", "### Added", "",
      "- Add enforceable release planning and version checks for contributors.",
      "<!-- release-impact: minor -->", "", `## [${baseVersion}] - 2026-08-09`, "", "Baseline.", ""
    ].join("\n"));
    const currentVersion = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "package.json"), "utf8")).version;
    const result = spawnSync("node", [
      fixtureScript, "pr-check",
      "--body-file", temporaryFile(prBody(
        "Add enforceable release planning and version checks for contributors.",
        "Completed in test tenant", "Patch", "Version release"
      )),
      "--changed-files", temporaryFile("CHANGELOG.md\npackage.json\npackage-lock.json\nm365-agent/appPackage/manifest.json\n"),
      "--base-package", basePackageFile
    ], { cwd: fixtureRoot, encoding: "utf8" });
    expect(currentVersion).toBe(patchVersion);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/understates minor changes/i);
  });
});
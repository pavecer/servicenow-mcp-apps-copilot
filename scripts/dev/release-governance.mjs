#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packagePath = path.join(root, "package.json");
const lockPath = path.join(root, "package-lock.json");
const manifestPath = path.join(root, "m365-agent/appPackage/manifest.json");
const changelogPath = path.join(root, "CHANGELOG.md");
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const impactRank = { none: 0, patch: 1, minor: 2, major: 3 };
const unreleasedTemplate = "## [Unreleased]\n\n### Added\n\n### Changed\n\n### Fixed\n\n";

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value, indentation = 2) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, indentation)}\n`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      args._.push(value);
      continue;
    }
    const [name, inlineValue] = value.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      args[name] = inlineValue;
    } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      args[name] = argv[index + 1];
      index += 1;
    } else {
      args[name] = true;
    }
  }
  return args;
}

export function bumpVersion(version, type) {
  const match = semverPattern.exec(version);
  if (!match) fail(`Invalid semantic version: ${version}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (type === "major") return `${major + 1}.0.0`;
  if (type === "minor") return `${major}.${minor + 1}.0`;
  if (type === "patch") return `${major}.${minor}.${patch + 1}`;
  fail(`Release type must be patch, minor, or major; received '${type ?? ""}'.`);
}

function getVersions() {
  const packageJson = readJson(packagePath);
  const lock = readJson(lockPath);
  const manifest = readJson(manifestPath);
  return {
    packageJson: packageJson.version,
    packageLock: lock.version,
    packageLockRoot: lock.packages?.[""]?.version,
    m365Manifest: manifest.version
  };
}

function getCanonicalVersion() {
  const versions = getVersions();
  const values = Object.values(versions);
  for (const [source, version] of Object.entries(versions)) {
    if (!semverPattern.test(version ?? "")) fail(`${source} has invalid version '${version ?? ""}'.`);
  }
  if (!values.every(version => version === values[0])) {
    fail(`Version drift detected:\n${Object.entries(versions).map(([source, version]) => `- ${source}: ${version}`).join("\n")}`);
  }
  return values[0];
}

function getSection(markdown, heading) {
  const escaped = escapeRegExp(heading);
  const match = new RegExp(`^## ${escaped}(?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`, "m").exec(markdown);
  if (!match) return "";
  const contentStart = match.index + match[0].length;
  const nextHeading = markdown.indexOf("\n## ", contentStart);
  return markdown.slice(contentStart, nextHeading < 0 ? markdown.length : nextHeading).trim();
}

function stripHtmlComments(value) {
  let output = "";
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf("<!--", cursor);
    if (start < 0) return output + value.slice(cursor);
    output += value.slice(cursor, start);
    const end = value.indexOf("-->", start + 4);
    if (end < 0) return output;
    cursor = end + 3;
  }
  return output;
}

function meaningfulSection(section) {
  return stripHtmlComments(section)
    .replace(/^\s*[-*]\s*$/gm, "")
    .trim();
}

function escapeRegExp(value) {
  const special = new Set(["\\", "^", "$", ".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|"]);
  let escaped = "";
  for (const character of value) escaped += special.has(character) ? `\\${character}` : character;
  return escaped;
}

function hasDatedVersionHeading(changelog, version) {
  const prefix = `## [${version}] - `;
  return changelog.split(/\r?\n/).some(line => {
    if (!line.startsWith(prefix)) return false;
    return /^\d{4}-\d{2}-\d{2}$/.test(line.slice(prefix.length));
  });
}

function normalizedText(value) {
  return meaningfulSection(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function sectionImpact(section) {
  const impacts = [...section.matchAll(/<!--\s*release-impact:\s*(patch|minor|major)\s*-->/gi)]
    .map(match => match[1].toLowerCase());
  return impacts.reduce((highest, impact) => impactRank[impact] > impactRank[highest] ? impact : highest, "none");
}

function queuedImpact(changelog) {
  return sectionImpact(getSection(changelog, "[Unreleased]"));
}

function markerCount(section, impact) {
  return [...section.matchAll(new RegExp(`<!--\\s*release-impact:\\s*${impact}\\s*-->`, "gi"))].length;
}

function requiresReleaseImpact(files) {
  const shippedPaths = [
    /^src\//,
    /^infra\//,
    /^m365-agent\/(?!.*\.md$)/,
    /^scripts\//,
    /^(?:azure\.yaml|Dockerfile|host\.json)$/
  ];
  return files.some(file => shippedPaths.some(pattern => pattern.test(file)));
}

function productionDependencies(lock) {
  return Object.fromEntries(Object.entries(lock.packages ?? {})
    .filter(([name, entry]) => name && !entry?.dev)
    .map(([name, entry]) => [name, entry?.version ?? null]));
}

function productionDependenciesChanged(args, event, files) {
  if (!files.some(file => file === "package.json" || file === "package-lock.json")) return false;
  try {
    const basePackage = JSON.parse(baseFile(args, event, "package.json"));
    const currentPackage = readJson(packagePath);
    if (JSON.stringify(basePackage.dependencies ?? {}) !== JSON.stringify(currentPackage.dependencies ?? {})) return true;
    const baseLock = JSON.parse(baseFile(args, event, "package-lock.json"));
    const currentLock = readJson(lockPath);
    return JSON.stringify(productionDependencies(baseLock)) !== JSON.stringify(productionDependencies(currentLock));
  } catch {
    return true;
  }
}

function requiresTenantValidation(files, args, event) {
  const runtimePaths = [
    /^src\//,
    /^infra\//,
    /^m365-agent\/(?!.*\.md$)/,
    /^scripts\/(?:deploy-|release-automate|smoke-test)/,
    /^(?:azure\.yaml|Dockerfile|host\.json)$/
  ];
  if (files.some(file => runtimePaths.some(pattern => pattern.test(file)))) return true;
  return productionDependenciesChanged(args, event, files);
}

function selectedOptions(body, labels) {
  return labels.filter(label => new RegExp(`^- \\[x\\] ${label}(?:\\s|$)`, "im").test(body));
}

function changedFiles(args, event) {
  if (args["changed-files"]) {
    return fs.readFileSync(path.resolve(args["changed-files"]), "utf8").split(/\r?\n/).filter(Boolean);
  }
  const base = event.pull_request?.base?.sha;
  const head = event.pull_request?.head?.sha;
  if (!base || !head) fail("Pull request event is missing base/head SHAs.");
  return execFileSync("git", ["diff", "--name-only", base, head], { cwd: root, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
}

function baseChangelog(args, event) {
  if (args["base-changelog"]) {
    return fs.readFileSync(path.resolve(args["base-changelog"]), "utf8");
  }
  const base = event.pull_request?.base?.sha;
  if (!base) fail("Pull request event is missing its base SHA.");
  try {
    return execFileSync("git", ["show", `${base}:CHANGELOG.md`], { cwd: root, encoding: "utf8" });
  } catch {
    fail("Unable to read CHANGELOG.md from the pull request base commit.");
  }
}

function baseFile(args, event, relativePath) {
  if (relativePath === "CHANGELOG.md" && args["base-changelog"]) {
    return fs.readFileSync(path.resolve(args["base-changelog"]), "utf8");
  }
  if (relativePath === "package.json" && args["base-package"]) {
    return fs.readFileSync(path.resolve(args["base-package"]), "utf8");
  }
  if (relativePath === "package-lock.json" && args["base-lock"]) {
    return fs.readFileSync(path.resolve(args["base-lock"]), "utf8");
  }
  const base = event.pull_request?.base?.sha;
  if (!base) fail(`Pull request event is missing its base SHA; cannot read ${relativePath}.`);
  try {
    return execFileSync("git", ["show", `${base}:${relativePath}`], { cwd: root, encoding: "utf8" });
  } catch {
    fail(`Unable to read ${relativePath} from the pull request base commit.`);
  }
}

function versionImpact(fromVersion, toVersion) {
  const from = semverPattern.exec(fromVersion);
  const to = semverPattern.exec(toVersion);
  if (!from || !to) fail("Release PR contains an invalid semantic version.");
  const [fromMajor, fromMinor, fromPatch] = from.slice(1).map(Number);
  const [toMajor, toMinor, toPatch] = to.slice(1).map(Number);
  if (toMajor === fromMajor + 1 && toMinor === 0 && toPatch === 0) return "major";
  if (toMajor === fromMajor && toMinor === fromMinor + 1 && toPatch === 0) return "minor";
  if (toMajor === fromMajor && toMinor === fromMinor && toPatch === fromPatch + 1) return "patch";
  fail(`Version change ${fromVersion} -> ${toVersion} is not one valid SemVer increment.`);
}

function inferDependabotDevelopmentPlan(args, event, body, files) {
  if (event.pull_request?.user?.login !== "dependabot[bot]") return null;
  const hasTemplateSelection = selectedOptions(body, [
    "None", "Patch", "Minor", "Major", "Regular change",
    "Version release", "Version baseline alignment"
  ]).length > 0;
  if (hasTemplateSelection) return null;
  if (!files.length || !files.every(file => file === "package.json" || file === "package-lock.json")) {
    fail("Dependabot automation without the PR template is limited to npm dependency files.");
  }
  if (productionDependenciesChanged(args, event, files)) {
    fail("Production Dependabot updates require reviewed Patch metadata, a changelog entry, and applicable human validation.");
  }
  return {
    impact: "none",
    prKind: "Regular change",
    humanValidation: "Not required",
    releaseNote: "N/A",
    changedFiles: files
  };
}

function validatePr(args) {
  const eventPath = args.event || process.env.GITHUB_EVENT_PATH;
  const event = eventPath ? readJson(path.resolve(eventPath)) : {};
  const body = args["body-file"]
    ? fs.readFileSync(path.resolve(args["body-file"]), "utf8")
    : event.pull_request?.body ?? "";
  const files = changedFiles(args, event);
  const dependabotPlan = inferDependabotDevelopmentPlan(args, event, body, files);
  if (dependabotPlan) return dependabotPlan;
  if (!body.trim()) fail("Pull request body is empty. Use the repository PR template.");

  const impacts = selectedOptions(body, ["None", "Patch", "Minor", "Major"]);
  if (impacts.length !== 1) fail("Select exactly one release impact: None, Patch, Minor, or Major.");
  const prKinds = selectedOptions(body, ["Regular change", "Version release", "Version baseline alignment"]);
  if (prKinds.length !== 1) fail("Select exactly one PR kind: Regular change, Version release, or Version baseline alignment.");
  const validations = selectedOptions(body, ["Not required", "Completed maintainer workflow review", "Completed in test tenant"]);
  if (validations.length !== 1) {
    fail("Select exactly one human-validation state: Not required, Completed maintainer workflow review, or Completed in test tenant.");
  }

  const impact = impacts[0].toLowerCase();
  const releaseNote = meaningfulSection(getSection(body, "Release note"));
  const validationEvidence = meaningfulSection(getSection(body, "Human validation evidence"));
  const isVersionRelease = prKinds[0] === "Version release";
  const isBaselineAlignment = prKinds[0] === "Version baseline alignment";
  const baseVersion = JSON.parse(baseFile(args, event, "package.json")).version;
  const currentVersion = getCanonicalVersion();

  if (isBaselineAlignment) {
    if (baseVersion !== "1.0.0" || currentVersion !== "1.1.6") {
      fail("Version baseline alignment is restricted to the one-time 1.0.0 -> 1.1.6 reconciliation.");
    }
    if (impact !== "minor") fail("Version baseline alignment must select Minor impact.");
    if (validations[0] !== "Completed maintainer workflow review") {
      fail("Version baseline alignment requires completed maintainer workflow review.");
    }
    if (requiresTenantValidation(files, args, event)) {
      fail("Version baseline alignment cannot include runtime or deployment changes.");
    }
    const currentUnreleased = getSection(fs.readFileSync(changelogPath, "utf8"), "[Unreleased]");
    const baseUnreleased = getSection(baseChangelog(args, event), "[Unreleased]");
    if (!normalizedText(currentUnreleased).includes(normalizedText(releaseNote))
      || normalizedText(baseUnreleased).includes(normalizedText(releaseNote))) {
      fail("Baseline release note must be newly added to CHANGELOG.md under Unreleased.");
    }
    if (markerCount(currentUnreleased, impact) <= markerCount(baseUnreleased, impact)) {
      fail(`Add a new '<!-- release-impact: ${impact} -->' marker beside the baseline PR note.`);
    }
    return { impact, prKind: prKinds[0], humanValidation: validations[0], releaseNote, changedFiles: files };
  }

  if (isVersionRelease) {
    if (impact === "none") fail("A Version release PR must select Patch, Minor, or Major.");
    if (validations[0] !== "Completed in test tenant") {
      fail("A Version release PR requires completed human validation in the test tenant.");
    }
    const actualImpact = versionImpact(baseVersion, currentVersion);
    if (impact !== actualImpact) {
      fail(`Version release impact ${impact} does not match ${baseVersion} -> ${currentVersion} (${actualImpact}).`);
    }
    if (releaseNote.length < 12 || /^(n\/a|none)(?:\.|\s|$)/i.test(releaseNote)) {
      fail("A Version release PR requires a meaningful user-facing Release note.");
    }
    const changelog = fs.readFileSync(changelogPath, "utf8");
    if (!hasDatedVersionHeading(changelog, currentVersion)) {
      fail(`CHANGELOG.md section [${currentVersion}] must have a YYYY-MM-DD release date.`);
    }
    const releasedNotes = normalizedText(getSection(changelog, `[${currentVersion}]`));
    const releasedImpact = sectionImpact(getSection(changelog, `[${currentVersion}]`));
    if (impactRank[actualImpact] < impactRank[releasedImpact]) {
      fail(`Version release ${actualImpact} understates ${releasedImpact} changes in [${currentVersion}].`);
    }
    if (!releasedNotes.includes(normalizedText(releaseNote))) {
      fail(`Version release note must appear in CHANGELOG.md section [${currentVersion}].`);
    }
    if (validationEvidence.length < 12) {
      fail("Human validation evidence must describe completed release validation.");
    }
    return { impact, prKind: prKinds[0], humanValidation: validations[0], releaseNote, changedFiles: files };
  }

  if (baseVersion !== currentVersion) {
    fail("Regular change PRs cannot change the canonical version; use Version release or Version baseline alignment.");
  }

  if (impact === "none") {
    if (requiresReleaseImpact(files) || productionDependenciesChanged(args, event, files)) {
      fail("Release impact None cannot be used for runtime, infrastructure, package, M365 app, or release-script changes.");
    }
    if (!/^(n\/a|none)(?:\.|\s|$)/i.test(releaseNote)) {
      fail("Release impact None requires 'N/A' or 'None' in the Release note section.");
    }
    const workflowChanged = files.some(file => file.startsWith(".github/workflows/"));
    const requiredValidation = workflowChanged ? "Completed maintainer workflow review" : "Not required";
    if (validations[0] !== requiredValidation) {
      fail(`Release impact None requires '${requiredValidation}' for the changed surfaces.`);
    }
  } else {
    const requiredValidation = requiresTenantValidation(files, args, event)
      ? "Completed in test tenant"
      : "Completed maintainer workflow review";
    if (validations[0] !== requiredValidation) {
      fail(`${impacts[0]} changes require '${requiredValidation}' for the changed surfaces.`);
    }
    if (releaseNote.length < 12 || /^(n\/a|none)(?:\.|\s|$)/i.test(releaseNote)) {
      fail(`${impacts[0]} changes require a concise user-facing Release note.`);
    }
    if (!files.includes("CHANGELOG.md")) {
      fail(`${impacts[0]} changes must update CHANGELOG.md under Unreleased.`);
    }
    const changelog = fs.readFileSync(changelogPath, "utf8");
    const currentUnreleased = getSection(changelog, "[Unreleased]");
    if (!normalizedText(currentUnreleased).includes(normalizedText(releaseNote))) {
      fail("The PR Release note must also appear in CHANGELOG.md under Unreleased.");
    }
    const baseUnreleased = getSection(baseChangelog(args, event), "[Unreleased]");
    if (normalizedText(baseUnreleased).includes(normalizedText(releaseNote))) {
      fail("The PR Release note already existed in the base changelog; add a note specific to this PR.");
    }
    const marker = `<!-- release-impact: ${impact} -->`;
    if (markerCount(currentUnreleased, impact) <= markerCount(baseUnreleased, impact)) {
      fail(`Add a new '${marker}' marker beside this PR's Unreleased entry.`);
    }
  }

  if (validationEvidence.length < 12) {
    fail("Human validation evidence must explain either the completed tenant test or why validation is not required.");
  }

  return { impact, prKind: prKinds[0], humanValidation: validations[0], releaseNote, changedFiles: files };
}

function validateRepository(args) {
  const version = getCanonicalVersion();
  const changelog = fs.readFileSync(changelogPath, "utf8");
  if (!/^## \[Unreleased\]\s*$/m.test(changelog)) fail("CHANGELOG.md must contain an [Unreleased] section.");
  if (!meaningfulSection(getSection(changelog, `[${version}]`))) {
    fail(`CHANGELOG.md must contain release notes for the canonical version ${version}.`);
  }
  if (!hasDatedVersionHeading(changelog, version)) {
    fail(`CHANGELOG.md section [${version}] must have a YYYY-MM-DD release date.`);
  }
  if (args.tag && args.tag !== `v${version}`) fail(`Tag '${args.tag}' does not match canonical version v${version}.`);
  return { version };
}

function updateChangelogLinks(changelog, version) {
  const repositoryUrl = String(readJson(packagePath).repository?.url ?? "").replace(/\.git$/, "");
  if (!repositoryUrl.startsWith("https://github.com/")) fail("package.json repository.url must be a GitHub HTTPS URL.");
  const links = {
    Unreleased: `${repositoryUrl}/compare/v${version}...HEAD`,
    [version]: `${repositoryUrl}/releases/tag/v${version}`
  };
  let updated = changelog;
  for (const [label, url] of Object.entries(links)) {
    const prefix = `[${label}]:`;
    const lines = updated.split(/\r?\n/);
    const index = lines.findIndex(line => line.startsWith(prefix));
    if (index >= 0) lines[index] = `${prefix} ${url}`;
    else lines.push(`${prefix} ${url}`);
    updated = `${lines.join("\n").trimEnd()}\n`;
  }
  return updated;
}

function planRelease(args) {
  const { version } = validateRepository(args);
  const type = args.type;
  const nextVersion = bumpVersion(version, type);
  const changelog = fs.readFileSync(changelogPath, "utf8");
  const requiredType = queuedImpact(changelog);
  if (impactRank[type] < impactRank[requiredType]) {
    fail(`Release type ${type} understates queued ${requiredType} changes.`);
  }
  const changes = meaningfulSection(getSection(changelog, "[Unreleased]"));
  if (!changes.replace(/^### .*$/gm, "").trim()) fail("CHANGELOG.md Unreleased has no release entries.");
  return { currentVersion: version, releaseType: type, requiredType, nextVersion, changes };
}

function prepareRelease(args) {
  const plan = planRelease(args);
  const date = args.date || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`Invalid release date '${date}'. Use YYYY-MM-DD.`);

  const packageJson = readJson(packagePath);
  const lock = readJson(lockPath);
  const manifest = readJson(manifestPath);
  packageJson.version = plan.nextVersion;
  lock.version = plan.nextVersion;
  lock.packages[""].version = plan.nextVersion;
  manifest.version = plan.nextVersion;
  writeJson(packagePath, packageJson, 2);
  writeJson(lockPath, lock, 2);
  writeJson(manifestPath, manifest, 4);

  const changelog = fs.readFileSync(changelogPath, "utf8");
  const start = changelog.search(/^## \[Unreleased\]\s*$/m);
  const following = changelog.slice(start).search(/^## \[(?!Unreleased\])/m);
  const end = following < 0 ? changelog.length : start + following;
  const unreleased = changelog.slice(start, end).replace(/^## \[Unreleased\]\s*\n?/, "").trim();
  const released = `${unreleasedTemplate}## [${plan.nextVersion}] - ${date}\n\n${unreleased}\n\n`;
  const nextChangelog = `${changelog.slice(0, start)}${released}${changelog.slice(end).replace(/^\s+/, "")}`;
  fs.writeFileSync(changelogPath, updateChangelogLinks(nextChangelog, plan.nextVersion));
  return { ...plan, date };
}

function releaseNotes(args) {
  const version = args.version || getCanonicalVersion();
  const changelog = fs.readFileSync(changelogPath, "utf8");
  const notes = meaningfulSection(getSection(changelog, `[${version}]`));
  if (!notes) fail(`CHANGELOG.md has no section for version ${version}.`);
  return { version, notes };
}

function printResult(result, args) {
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else if (result.notes) console.log(result.notes);
  else console.log(Object.entries(result).map(([key, value]) => `${key}: ${value}`).join("\n"));
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "check";

try {
  let result;
  if (command === "check") result = validateRepository(args);
  else if (command === "pr-check") result = validatePr(args);
  else if (command === "plan") result = planRelease(args);
  else if (command === "prepare") result = prepareRelease(args);
  else if (command === "notes") result = releaseNotes(args);
  else fail(`Unknown command '${command}'. Use check, pr-check, plan, prepare, or notes.`);
  printResult(result, args);
} catch (error) {
  console.error(`[release-governance] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import unzipper from "unzipper";
import { createSourcePackage } from "../scripts/dev/source-package.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("source deployment package", () => {
  it("includes source while excluding local, generated, and sensitive files", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "source-package-"));
    temporaryDirectories.push(fixtureRoot);
    const packagePath = path.join(fixtureRoot, "output", "source.zip");
    const files = [
      "package.json",
      "src/app.ts",
      ".github/workflows/ci.yml",
      ".git/config",
      "node_modules/package/index.js",
      "dist/app.js",
      ".tmp/previous.zip",
      ".azure/config.json",
      "local.settings.json",
      ".env",
      "env/local",
      "debug/capture.har",
      "m365-agent/appPackage/build/manifest.json"
    ];

    for (const relativePath of files) {
      const filePath = path.join(fixtureRoot, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, relativePath);
    }

    await createSourcePackage(fixtureRoot, packagePath);
    const archive = await unzipper.Open.file(packagePath);
    const entries = archive.files.filter((entry) => entry.type === "File").map((entry) => entry.path).sort();

    expect(entries).toEqual([
      ".github/workflows/ci.yml",
      "package.json",
      "src/app.ts"
    ]);
  });
});
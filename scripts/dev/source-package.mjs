import fs from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";

export const sourcePackageExclusions = [
  ".git/**",
  "node_modules/**",
  "dist/**",
  ".tmp/**",
  ".azure/**",
  "local.settings.json",
  ".env",
  "env/**",
  "debug/**",
  "m365-agent/appPackage/build/**"
];

export function createSourcePackage(sourceRoot, packagePath) {
  fs.mkdirSync(path.dirname(packagePath), { recursive: true });
  fs.rmSync(packagePath, { force: true });
  const relativePackagePath = path.relative(sourceRoot, packagePath).split(path.sep).join("/");
  const exclusions = relativePackagePath && !relativePackagePath.startsWith("../")
    ? [...sourcePackageExclusions, relativePackagePath]
    : sourcePackageExclusions;

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(packagePath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("warning", (error) => {
      if (error.code === "ENOENT") {
        console.warn(error.message);
        return;
      }
      reject(error);
    });
    archive.on("error", reject);

    archive.pipe(output);
    archive.glob("**/*", {
      cwd: sourceRoot,
      dot: true,
      ignore: exclusions
    });
    archive.finalize();
  });
}
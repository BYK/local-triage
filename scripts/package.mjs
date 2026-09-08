import { mkdir, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const artifacts = path.join(root, "artifacts");
const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const stem = `local-triage-${packageJson.version}`;
const extensionOutput = path.join(artifacts, `${stem}.xpi`);
const sourceOutput = path.join(artifacts, `${stem}-source.zip`);

await mkdir(artifacts, { recursive: true });
await rm(extensionOutput, { force: true });
await rm(sourceOutput, { force: true });
await execute("zip", ["-q", "-r", extensionOutput, "."], {
  cwd: path.join(root, "dist"),
});
await execute(
  "zip",
  [
    "-q",
    "-r",
    sourceOutput,
    ".gitignore",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "package.json",
    "package-lock.json",
    "scripts",
    "native",
    "upstream",
    "src",
    "static",
    "test",
  ],
  { cwd: root },
);

console.log(extensionOutput);
console.log(sourceOutput);

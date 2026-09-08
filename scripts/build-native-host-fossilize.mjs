import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fossilize } from "fossilize";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "native", "directml-host");
const buildRoot = path.join(root, "native-build");
const stage = path.join(buildRoot, "stage");
const tools = path.join(buildRoot, "tools");
const assetsDirectory = path.join(buildRoot, "fossil-assets");
const fossilOutput = path.join(buildRoot, "fossil-output");
const fossilCache = path.join(buildRoot, "fossil-cache");
const artifacts = path.join(root, "artifacts");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = packageJson.version;
const nodeVersion = "24.19.0";
const outputName = "LocalTriageNativeHost";
const runtimeFilenames = [
  "onnxruntime.dll",
  "onnxruntime_binding.node",
];
const extensionArtifact = path.join(artifacts, `local-triage-${version}.xpi`);
const useExistingDependencies = process.env.LOCAL_TRIAGE_USE_EXISTING_DEPENDENCIES === "1";
const existingWindowsNodeDirectory = process.env.LOCAL_TRIAGE_WINDOWS_NODE_DIRECTORY;

async function run(command, args, options = {}) {
  const result = await execute(command, args, {
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

await rm(buildRoot, { recursive: true, force: true });
await Promise.all([
  mkdir(stage, { recursive: true }),
  mkdir(tools, { recursive: true }),
  mkdir(assetsDirectory, { recursive: true }),
  mkdir(fossilCache, { recursive: true }),
  mkdir(artifacts, { recursive: true }),
]);

await cp(path.join(source, "package.json"), path.join(stage, "package.json"));
await cp(path.join(source, "host.cjs"), path.join(stage, "host.cjs"));
if (useExistingDependencies) {
  await cp(path.join(root, "node_modules"), path.join(stage, "node_modules"), {
    recursive: true,
  });
} else {
  await run(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: stage,
      env: {
        ...process.env,
        npm_config_platform: "win32",
        npm_config_arch: "x64",
      },
    },
  );
}

const ortPlatforms = path.join(
  stage,
  "node_modules",
  "onnxruntime-node",
  "bin",
  "napi-v6",
);
for (const platform of await readdir(ortPlatforms)) {
  if (platform !== "win32") {
    await rm(path.join(ortPlatforms, platform), { recursive: true, force: true });
  }
}
for (const architecture of await readdir(path.join(ortPlatforms, "win32"))) {
  if (architecture !== "x64") {
    await rm(
      path.join(ortPlatforms, "win32", architecture),
      { recursive: true, force: true },
    );
  }
}

// Transformers.js imports Sharp at module initialization even though this host
// only processes text. A tiny stub lets Fossilize bundle the JS dependency
// graph without pulling in an unrelated image-processing native addon.
await rm(path.join(stage, "node_modules", "onnxruntime-web"), {
  recursive: true,
  force: true,
});
await rm(path.join(stage, "node_modules", "@img"), { recursive: true, force: true });
await rm(path.join(stage, "node_modules", "sharp"), { recursive: true, force: true });
await mkdir(path.join(stage, "node_modules", "sharp"), { recursive: true });
await writeFile(
  path.join(stage, "node_modules", "sharp", "package.json"),
  JSON.stringify({
    name: "sharp",
    version: "0.0.0-local-triage-text-only",
    main: "index.cjs",
  }, null, 2),
);
await writeFile(
  path.join(stage, "node_modules", "sharp", "index.cjs"),
  'module.exports = function sharp() { throw new Error("Image processing is not packaged in the Local Triage text-only host."); };\n',
);

// A Windows native addon cannot execute directly from a SEA asset. The host
// extracts the two native files to a versioned local runtime directory, and
// this small binding patch loads the extracted addon through createRequire.
const bindingPath = path.join(stage, "node_modules", "onnxruntime-node", "dist", "binding.js");
const bindingSource = await readFile(bindingPath, "utf8");
const bindingRequire =
  'require(`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`)';
if (!bindingSource.includes(bindingRequire)) {
  throw new Error("onnxruntime-node's native binding loader changed; review the Fossilize patch.");
}
await writeFile(
  bindingPath,
  bindingSource.replace(
    bindingRequire,
    'require("node:module").createRequire(process.execPath)(process.env.LOCAL_TRIAGE_ORT_BINDING)',
  ),
);

const nativeRuntimeDirectory = path.join(ortPlatforms, "win32", "x64");
for (const filename of runtimeFilenames) {
  await cp(
    path.join(nativeRuntimeDirectory, filename),
    path.join(assetsDirectory, filename),
  );
}
await cp(extensionArtifact, path.join(assetsDirectory, "local-triage.xpi"));
const extensionSha256 = createHash("sha256")
  .update(await readFile(extensionArtifact))
  .digest("hex");
await writeFile(
  path.join(assetsDirectory, "installer-manifest.json"),
  JSON.stringify({ version, extensionSha256 }, null, 2),
);

// Seed Fossilize's exact-version cache so this cross-build is reproducible and
// does not depend on nodejs.org availability during packaging.
await writeFile(path.join(tools, "package.json"), JSON.stringify({ private: true }));
if (!existingWindowsNodeDirectory) {
  await run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--force",
      `node-win-x64@${nodeVersion}`,
    ],
    { cwd: tools },
  );
}
const hostPlatform = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
const hostNode = path.join(fossilCache, `node-v${nodeVersion}-${hostPlatform}`);
await cp(process.execPath, hostNode);
await chmod(hostNode, 0o755);
await cp(
  existingWindowsNodeDirectory
    ? path.join(existingWindowsNodeDirectory, "bin", "node.exe")
    : path.join(tools, "node_modules", "node-win-x64", "bin", "node.exe"),
  path.join(fossilCache, `node-v${nodeVersion}-win-x64.exe`),
);

const assetPaths = [
  ...runtimeFilenames,
  "local-triage.xpi",
  "installer-manifest.json",
].map((filename) =>
  path.posix.join("native-build", "fossil-assets", filename));
await fossilize(
  {
    nodeVersion,
    platforms: ["win-x64"],
    assets: assetPaths,
    outDir: fossilOutput,
    outputName,
    cacheDir: fossilCache,
    noBundle: false,
    noCache: false,
    noCodeCache: true,
    ignoreNodeOptions: false,
    sign: false,
    holePunch: false,
    concurrencyLimit: 1,
  },
  path.join(stage, "host.cjs"),
);

const fossilized = path.join(fossilOutput, `${outputName}-win-x64.exe`);
const output = path.join(
  artifacts,
  `local-triage-windows-installer-${version}-win-x64.exe`,
);
await rm(output, { force: true });
await cp(fossilized, output);
console.log(output);

"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const HOST_VERSION = "0.13.9";
const MODEL_ID = "onnx-community/Qwen3.5-0.8B-ONNX";
const EMBEDDING_MODEL_ID = "Xenova/multilingual-e5-small";
const EMBEDDING_DTYPE = "q8";
const DEVICE = "cpu";
// Q4 retains 4-bit weights with FP32 activations. Native CPU is deliberately
// the only production backend for this small, short-output workload.
const DTYPE = "q4";
const RUNTIME_VERSION = 30;
const APPROXIMATE_MODEL_SIZE_MB = 668;
const APPROXIMATE_EMBEDDING_MODEL_SIZE_MB = 118;
const MAX_BODY_CHARACTERS = 3500;
const MAX_DIAGNOSTICS = 250;
const NATIVE_HOST_NAME = "im.byk.local_triage";
const EXTENSION_ID = "local-triage@byk.im";
const MODEL_WORKER_MODE = process.argv.includes("--model-worker");
const MODEL_WORKER_ACTIVITY_TIMEOUT_MS = positiveIntegerEnvironmentValue(
  "LOCAL_TRIAGE_MODEL_WORKER_ACTIVITY_TIMEOUT_MS",
  2 * 60 * 1000,
);
const MODEL_WORKER_HARD_TIMEOUT_MS = positiveIntegerEnvironmentValue(
  "LOCAL_TRIAGE_MODEL_WORKER_HARD_TIMEOUT_MS",
  12 * 60 * 1000,
);
const MODEL_WORKER_HEARTBEAT_MS = positiveIntegerEnvironmentValue(
  "LOCAL_TRIAGE_MODEL_WORKER_HEARTBEAT_MS",
  5 * 1000,
);
const EMBEDDED_RUNTIME_ASSET_PREFIX = "native-build/fossil-assets";
const EMBEDDED_EXTENSION_ASSET = `${EMBEDDED_RUNTIME_ASSET_PREFIX}/local-triage.xpi`;
const EMBEDDED_INSTALLER_MANIFEST_ASSET =
  `${EMBEDDED_RUNTIME_ASSET_PREFIX}/installer-manifest.json`;
const NATIVE_RUNTIME_FILENAMES = [
  "onnxruntime.dll",
  "onnxruntime_binding.node",
];

function positiveIntegerEnvironmentValue(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const installDirectory = path.dirname(process.execPath);
const cacheDirectory = process.env.LOCAL_TRIAGE_MODEL_CACHE || path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "LocalTriage",
  "models",
);
const validationStampPath = path.join(cacheDirectory, "local-triage-cpu-validation.json");
const extractedRuntimeDirectory = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "LocalTriage",
  "native-runtime",
  HOST_VERSION,
);
let activeRuntimeDirectory = path.join(
  installDirectory,
  "node_modules",
  "onnxruntime-node",
  "bin",
  "napi-v6",
  "win32",
  process.arch,
);

function requiredRuntimeFiles() {
  return NATIVE_RUNTIME_FILENAMES.map((filename) =>
    path.join(activeRuntimeDirectory, filename));
}

function writeEmbeddedAsset(sea, key, target) {
  const data = Buffer.from(sea.getRawAsset(key));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    if (fs.statSync(target).size === data.length) return target;
  } catch {
    // Missing or stale assets are replaced atomically below.
  }
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, target);
  return target;
}

function packagedSea() {
  try {
    const sea = require("node:sea");
    return sea.isSea?.() ? sea : undefined;
  } catch {
    return undefined;
  }
}

function isNativeMessagingInvocation(argv = process.argv) {
  const argumentsAfterExecutable = argv.slice(1).map((value) => String(value));
  return argumentsAfterExecutable.some((argument) => argument === EXTENSION_ID) ||
    argumentsAfterExecutable.some((argument) => {
      const basename = argument.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
      return basename === `${NATIVE_HOST_NAME}.json`.toLowerCase();
    });
}

function isStandaloneHostExecutable(argv = process.argv) {
  const executable = String(argv[0] ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.toLowerCase() ?? "";
  return executable.startsWith("localtriagedirectmlhost") ||
    executable.startsWith("localtriagenativehost") ||
    executable.startsWith("local-triage-windows-installer-");
}

function detectLaunchMode(argv = process.argv, packaged = Boolean(packagedSea())) {
  if (argv.includes("--install")) return "install";
  if (argv.includes("--diagnostics")) return "diagnostics";
  if (argv.includes("--model-worker")) return "model-worker";
  // Node SEA/Fossilize keeps an implicit argv[1] entry, so argument count does
  // not distinguish Explorer double-clicks from native-messaging launches.
  // Firefox/Thunderbird supplies both the host manifest and extension ID when
  // it starts a registered native host; their presence is the reliable signal.
  if (
    (packaged || isStandaloneHostExecutable(argv)) &&
    !isNativeMessagingInvocation(argv)
  ) return "install";
  return "native-messaging";
}

function prepareEmbeddedRuntime() {
  const sea = packagedSea();
  if (!sea) return false;
  fs.mkdirSync(extractedRuntimeDirectory, { recursive: true });
  for (const filename of NATIVE_RUNTIME_FILENAMES) {
    writeEmbeddedAsset(
      sea,
      `${EMBEDDED_RUNTIME_ASSET_PREFIX}/${filename}`,
      path.join(extractedRuntimeDirectory, filename),
    );
  }
  activeRuntimeDirectory = extractedRuntimeDirectory;
  process.env.LOCAL_TRIAGE_ORT_BINDING = path.join(
    activeRuntimeDirectory,
    "onnxruntime_binding.node",
  );
  process.env.PATH = [activeRuntimeDirectory, process.env.PATH]
    .filter(Boolean)
    .join(path.delimiter);
  diagnostic("runtime.assets.ready", {
    directory: activeRuntimeDirectory,
    files: runtimeFiles(),
  });
  return true;
}

function assertCompleteInstallation() {
  const missing = requiredRuntimeFiles()
    .filter((filePath) => !fs.existsSync(filePath));
  if (!missing.length) return;
  diagnostic("installation.incomplete", { missing });
  throw new Error(
    `The native companion runtime is incomplete; missing ${missing.join(", ")}. ` +
    "Quit Thunderbird and reinstall the companion.",
  );
}

let pipelinePromise;
let generator;
let activeVariant;
let generationQueue = Promise.resolve();
let embeddingPipelinePromise;
let embeddingExtractor;
let embeddingSignature;
let embeddingQueue = Promise.resolve();
let transformersRuntime;
let diagnostics = [];
let activeRequestId;
let lastGenerationState = "idle";
let runtimeWorker;
let runtimeWorkerMode;
let runtimeWorkerBuffer = "";
let runtimeWorkerNextId = 1;
let runtimeWorkerState = "idle";
let runtimeWorkerLastProgress;
let runtimeWorkerActiveVariant;
let runtimeWorkerDiagnostics = [];
const runtimeWorkerPending = new Map();

function diagnostic(stage, details = {}) {
  const entry = {
    at: new Date().toISOString(),
    stage,
    details,
  };
  diagnostics.push(entry);
  if (diagnostics.length > MAX_DIAGNOSTICS) {
    diagnostics = diagnostics.slice(-MAX_DIAGNOSTICS);
  }
  if (MODEL_WORKER_MODE) {
    send({ type: "worker-diagnostic", requestId: activeRequestId, entry });
  }
  process.stderr.write(`[${stage}] ${JSON.stringify(details)}\n`);
}

function cpuValidationKey() {
  return `${MODEL_ID}|${DTYPE}|cpu|runtime-${RUNTIME_VERSION}`;
}

function hasCurrentCpuValidation() {
  try {
    const stamp = JSON.parse(fs.readFileSync(validationStampPath, "utf8"));
    return stamp?.key === cpuValidationKey();
  } catch {
    return false;
  }
}

function rememberCpuValidation() {
  const stamp = {
    key: cpuValidationKey(),
    modelId: MODEL_ID,
    dtype: DTYPE,
    runtimeVersion: RUNTIME_VERSION,
    validatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const temporary = `${validationStampPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(stamp, null, 2));
  fs.renameSync(temporary, validationStampPath);
  diagnostic("model.smoke.remembered", stamp);
}

function runtimeFiles() {
  return Object.fromEntries(
    NATIVE_RUNTIME_FILENAMES
      .map((name) => [name, fs.existsSync(path.join(activeRuntimeDirectory, name))]),
  );
}

function runRegistry(args) {
  const result = spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr || result.stdout || `reg.exe exited with ${result.status}`).trim(),
    );
  }
}

function extractEmbeddedExtension(destinationDirectory) {
  const sea = packagedSea();
  if (!sea) {
    throw new Error("The combined installer does not contain the Local Triage XPI.");
  }
  const bundleManifest = JSON.parse(Buffer.from(
    sea.getRawAsset(EMBEDDED_INSTALLER_MANIFEST_ASSET),
  ).toString("utf8"));
  if (bundleManifest.version !== HOST_VERSION) {
    throw new Error(
      `The embedded extension is version ${bundleManifest.version}; expected ${HOST_VERSION}.`,
    );
  }
  const xpiPath = writeEmbeddedAsset(
    sea,
    EMBEDDED_EXTENSION_ASSET,
    path.join(destinationDirectory, `local-triage-${HOST_VERSION}.xpi`),
  );
  const digest = crypto.createHash("sha256")
    .update(fs.readFileSync(xpiPath))
    .digest("hex");
  if (digest !== bundleManifest.extensionSha256) {
    throw new Error("The embedded Local Triage XPI failed its SHA-256 integrity check.");
  }
  return xpiPath;
}

function parseIniSections(content) {
  const sections = new Map();
  let current;
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      current = {};
      sections.set(sectionMatch[1], current);
      continue;
    }
    const separator = line.indexOf("=");
    if (!current || separator < 1) continue;
    current[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return sections;
}

function findDefaultThunderbirdProfile(appDataDirectory = process.env.APPDATA) {
  if (!appDataDirectory) return undefined;
  const thunderbirdDirectory = path.join(appDataDirectory, "Thunderbird");
  const profilesIni = path.join(thunderbirdDirectory, "profiles.ini");
  if (!fs.existsSync(profilesIni)) return undefined;
  const sections = parseIniSections(fs.readFileSync(profilesIni, "utf8"));
  const candidates = [];
  for (const [name, values] of sections) {
    if (name.startsWith("Install") && values.Default) candidates.push(values.Default);
  }
  for (const [name, values] of sections) {
    if (name.startsWith("Profile") && values.Default === "1" && values.Path) {
      candidates.push(values.Path);
    }
  }
  for (const [name, values] of sections) {
    if (name.startsWith("Profile") && values.Path) candidates.push(values.Path);
  }
  for (const candidate of [...new Set(candidates)]) {
    const profileDirectory = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(thunderbirdDirectory, candidate.replace(/\//g, path.sep));
    if (fs.existsSync(profileDirectory) && fs.statSync(profileDirectory).isDirectory()) {
      return profileDirectory;
    }
  }
  return undefined;
}

function installExtensionIntoDefaultProfile(xpiPath, appDataDirectory = process.env.APPDATA) {
  const profileDirectory = findDefaultThunderbirdProfile(appDataDirectory);
  if (!profileDirectory) return undefined;
  const extensionsDirectory = path.join(profileDirectory, "extensions");
  fs.mkdirSync(extensionsDirectory, { recursive: true });
  const destination = path.join(extensionsDirectory, `${EXTENSION_ID}.xpi`);
  fs.copyFileSync(xpiPath, destination);
  const sourceDigest = crypto.createHash("sha256").update(fs.readFileSync(xpiPath)).digest("hex");
  const installedDigest = crypto.createHash("sha256").update(fs.readFileSync(destination)).digest("hex");
  if (sourceDigest !== installedDigest) {
    throw new Error(`The extension copy failed verification at ${destination}.`);
  }
  return destination;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function verifyInstalledHostExecutable(destination) {
  if (!fs.existsSync(destination)) {
    throw new Error(`The installed companion is missing at ${destination}.`);
  }
  if (sha256File(destination) !== sha256File(process.execPath)) {
    throw new Error(`The installed companion failed its SHA-256 check at ${destination}.`);
  }
  const verification = spawnSync(destination, ["--diagnostics"], {
    encoding: "utf8",
    timeout: 60 * 1000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (verification.error || verification.status !== 0) {
    throw new Error(
      `The installed companion could not be started for verification: ${
        verification.error?.message ?? verification.stderr?.trim() ??
        `exit ${verification.status}`
      }`,
    );
  }
  let report;
  try {
    report = JSON.parse(verification.stdout);
  } catch {
    throw new Error("The installed companion returned an invalid verification report.");
  }
  if (
    report.hostVersion !== HOST_VERSION ||
    report.runtimeVersion !== RUNTIME_VERSION ||
    report.modelId !== MODEL_ID
  ) {
    throw new Error(
      `The installed companion reports ${report.hostVersion ?? "unknown"} ` +
      `(runtime ${report.runtimeVersion ?? "unknown"}); expected ${HOST_VERSION} ` +
      `(runtime ${RUNTIME_VERSION}).`,
    );
  }
  return report;
}

function stopInstalledHostProcesses(destinationDirectory) {
  let executableNames = [];
  try {
    executableNames = fs.readdirSync(destinationDirectory)
      .filter((filename) =>
        /^LocalTriage(?:DirectML|Native)Host(?:-.*)?\.exe$/i.test(filename));
  } catch {
    return [];
  }
  const currentImage = path.basename(process.execPath).toLowerCase();
  const attempted = [];
  for (const executableName of executableNames) {
    if (executableName.toLowerCase() === currentImage) continue;
    const result = spawnSync("taskkill.exe", [
      "/F",
      "/T",
      "/IM",
      executableName,
    ], {
      encoding: "utf8",
      timeout: 15 * 1000,
      windowsHide: true,
    });
    attempted.push({
      executableName,
      status: result.status,
      stopped: result.status === 0,
    });
  }
  diagnostic("installation.previous-hosts-stopped", { attempted });
  return attempted;
}

function assertThunderbirdStopped() {
  const result = spawnSync("tasklist.exe", [
    "/FI",
    "IMAGENAME eq thunderbird.exe",
    "/FO",
    "CSV",
    "/NH",
  ], {
    encoding: "utf8",
    timeout: 15 * 1000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not verify whether Thunderbird is running: ${
        result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`
      }`,
    );
  }
  if (/"thunderbird\.exe"/i.test(result.stdout)) {
    throw new Error(
      "Thunderbird is still running. Exit it completely (including any background " +
      "or tray process), then run this installer again. No files were changed.",
    );
  }
}

function installSelf() {
  if (process.platform !== "win32") {
    throw new Error("The native companion can only be installed on Windows.");
  }
  // Updating an XPI on disk while Thunderbird is alive creates a split state:
  // Add-ons Manager can show the new manifest while the old background script
  // and its native-messaging port remain active. Refuse that unsafe upgrade.
  assertThunderbirdStopped();
  if (!prepareEmbeddedRuntime()) {
    throw new Error("The combined installer does not contain its native runtime assets.");
  }
  assertCompleteInstallation();
  const destinationDirectory = path.join(
    process.env.LOCALAPPDATA,
    "LocalTriage",
    "NativeHost",
  );
  fs.mkdirSync(destinationDirectory, { recursive: true });
  const destination = path.join(
    destinationDirectory,
    `LocalTriageNativeHost-${HOST_VERSION}.exe`,
  );
  if (path.resolve(process.execPath).toLowerCase() !== path.resolve(destination).toLowerCase()) {
    fs.copyFileSync(process.execPath, destination);
  }
  const verifiedHost = verifyInstalledHostExecutable(destination);
  const manifestPath = path.join(destinationDirectory, `${NATIVE_HOST_NAME}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify({
    name: NATIVE_HOST_NAME,
    description: "Local Triage native CPU event-model companion",
    path: destination,
    type: "stdio",
    allowed_extensions: [EXTENSION_ID],
  }, null, 2));
  runRegistry([
    "ADD",
    `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    "/ve",
    "/t",
    "REG_SZ",
    "/d",
    manifestPath,
    "/f",
  ]);
  // The native host is persistent for the lifetime of Thunderbird. Replace
  // the registry target first, then stop any older versioned hosts so a
  // reconnect can only launch the just-verified executable.
  const stoppedHosts = [
    ...stopInstalledHostProcesses(destinationDirectory),
    ...stopInstalledHostProcesses(path.join(
      process.env.LOCALAPPDATA,
      "LocalTriage",
      "DirectMLHost",
    )),
  ];
  const xpiPath = extractEmbeddedExtension(destinationDirectory);
  const installedExtension = installExtensionIntoDefaultProfile(xpiPath);
  if (!installedExtension) {
    spawn("explorer.exe", [`/select,${xpiPath}`], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    }).unref();
  }
  process.stdout.write(
    `Installed Local Triage Windows companion ${HOST_VERSION}.\n` +
    `Verified runtime ${verifiedHost.runtimeVersion}; refreshed ${
      stoppedHosts.filter(({ stopped }) => stopped).length
    } running companion process(es).\n` +
    (installedExtension
      ? `Installed the matching extension into ${installedExtension}. Close and restart Thunderbird.\n`
      : `No default Thunderbird profile was found. Install ${xpiPath} from Thunderbird's Add-ons Manager.\n`),
  );
}

function diagnosticReport() {
  const report = {
    generatedAt: new Date().toISOString(),
    hostVersion: HOST_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    modelId: MODEL_ID,
    device: activeVariant?.device ?? DEVICE,
    dtype: DTYPE,
    variant: activeVariant,
    state: generator || embeddingExtractor
      ? "ready"
      : pipelinePromise || embeddingPipelinePromise
        ? "loading"
        : "idle",
    lastGenerationState,
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model,
      totalMemory: os.totalmem(),
      cacheDirectory,
      installDirectory,
      runtimeFiles: runtimeFiles(),
    },
    entries: diagnostics,
  };
  if (!MODEL_WORKER_MODE) {
    report.state = runtimeWorkerState;
    report.lastGenerationState = runtimeWorkerState === "generating"
      ? "running"
      : lastGenerationState;
    report.worker = {
      mode: runtimeWorkerMode,
      pid: runtimeWorker?.pid,
      state: runtimeWorkerState,
      lastProgress: runtimeWorkerLastProgress,
      pendingRequests: runtimeWorkerPending.size,
    };
    report.device = runtimeWorkerActiveVariant?.device ??
      runtimeWorkerLastProgress?.device ??
      (runtimeWorkerMode === "cpu" ? "cpu" : "not loaded");
    report.variant = runtimeWorkerActiveVariant;
    report.entries = [...diagnostics, ...runtimeWorkerDiagnostics]
      .sort((left, right) => String(left.at).localeCompare(String(right.at)))
      .slice(-MAX_DIAGNOSTICS);
  }
  return report;
}

function send(message) {
  if (MODEL_WORKER_MODE) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
    return;
  }
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(header);
  process.stdout.write(body);
}

function progress(phase, detail, percent, variant = activeVariant) {
  send({
    type: "progress",
    requestId: activeRequestId,
    phase,
    detail,
    percent: Number.isFinite(percent) ? percent : undefined,
    modelId: variant?.modelId ?? MODEL_ID,
    device: variant?.device ?? DEVICE,
    dtype: variant?.dtype ?? DTYPE,
    variant,
  });
}

function cleanBody(value) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/^>.*$/gm, "")
    .replace(/\n-{2,}\s*(?:original message|forwarded message).*$/is, "")
    .replace(/\n(?:from|gönderen):\s.*\n(?:sent|gönderildi):\s.*$/is, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_BODY_CHARACTERS);
}

function likelyTurkish(input) {
  const text = `${input?.subject ?? ""}\n${input?.body ?? ""}`;
  const letters = (text.match(/[çğıöşüÇĞİÖŞÜ]/g) ?? []).length;
  const words = (text.match(/\b(?:ve|ile|için|icin|toplantı|toplanti|etkinlik|tarihinde|saat|adresinde|katılım|katilim)\b/giu) ?? []).length;
  return letters + words >= 2;
}

function promptFor(input) {
  const body = cleanBody(input?.body);
  const detected = input?.detectedEvent ?? {};
  const facts = JSON.stringify({
    startDate: detected.startDate || "",
    startTime: detected.startTime || "",
    endDate: detected.endDate || "",
    endTime: detected.endTime || "",
    durationMinutes: Number.isFinite(detected.durationMinutes)
      ? detected.durationMinutes
      : null,
    location: detected.location || "",
    meetingUrl: detected.meetingUrl || "",
  });
  if (likelyTurkish(input)) {
    return [
      "You are editing a calendar event from a Turkish email.",
      "Return one line of valid JSON with exactly two keys: title and description.",
      "Write the actual title as a grammatically complete, idiomatic 3-8 word Turkish noun phrase and the actual description as one useful Turkish sentence.",
      "Do not copy the email subject verbatim. Remove reminder, confirmation, invitation, IDs, and tracking wording; name the actual event purpose.",
      "Never copy these instructions, field descriptions, or an example into the answer.",
      "Do not extract date, time, duration, or location. Do not change or repeat VERIFIED FACTS in the JSON.",
      "Ignore signatures, legal text, greetings, and unrelated email history.",
      'EXAMPLE EMAIL: Konu: Tasarım değerlendirmesi. İçerik: Yeni ana sayfa tasarımını ve yayın risklerini görüşeceğiz.',
      'EXAMPLE OUTPUT: {"title":"Ana Sayfa Tasarım Değerlendirmesi","description":"Ekip, yeni ana sayfa tasarımını ve yayın risklerini değerlendirecek."}',
      `DOĞRULANMIŞ BİLGİLER: ${facts}`,
      `E-POSTA KONUSU: ${input?.subject ?? ""}`,
      `E-POSTA İÇERİĞİ: ${body}`,
    ].join("\n");
  }
  return [
    "Write a concise calendar-event title and one useful description.",
    "Output only one line of valid JSON. Do not add prose or Markdown.",
    '{"title":"specific natural 3-8 word name","description":"one useful sentence explaining the event purpose"}',
    "Do not extract date, time, duration, or location. Do not change or repeat VERIFIED FACTS in the JSON.",
    "Ignore signatures, legal text, greetings, and unrelated email history. Use the email's language.",
    'EXAMPLE: {"title":"Product Roadmap Review","description":"The team will align next quarter’s product priorities and owners."}',
    `VERIFIED FACTS: ${facts}`,
    "TARGET EMAIL:",
    `SUBJECT: ${input?.subject ?? ""}`,
    `BODY: ${body}`,
  ].join("\n");
}

function stringValue(value) {
  if (value == null) return "";
  const text = String(value).trim();
  return /^(?:none|null|unknown|not stated|yok|belirtilmemiş|belirtilmemis|-+)$/i.test(text)
    ? ""
    : text;
}

function parseGeneratedEvent(text) {
  let source = String(text ?? "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (!source.includes("\n") && /\\[nr]/.test(source)) {
    source = source.replace(/\\n/g, "\n").replace(/\\r/g, "");
  }
  const keyMap = {
    title: "title",
    start_date: "startDate",
    start_time: "startTime",
    end_date: "endDate",
    end_time: "endTime",
    duration_minutes: "durationMinutes",
    location: "location",
    description: "description",
    baslik: "title",
    konum: "location",
    aciklama: "description",
    baslangic_tarihi: "startDate",
    baslangic_saati: "startTime",
    bitis_tarihi: "endDate",
    bitis_saati: "endTime",
    sure_dakika: "durationMinutes",
  };
  const normalizeKey = (value) => String(value)
    .toLocaleLowerCase()
    .trim()
    .replace(/[ -]+/g, "_")
    .replace(/[ç]/g, "c")
    .replace(/[ğ]/g, "g")
    .replace(/[ı]/g, "i")
    .replace(/[ö]/g, "o")
    .replace(/[ş]/g, "s")
    .replace(/[ü]/g, "u");
  let parsed;
  const firstBrace = source.indexOf("{");
  const lastBrace = source.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      parsed = JSON.parse(source.slice(firstBrace, lastBrace + 1));
      if (typeof parsed === "string") return parseGeneratedEvent(parsed);
    } catch {
      // Field-per-line output is intentionally accepted below.
    }
  }
  if (!parsed) {
    parsed = {};
    for (const line of source.split(/\r?\n/)) {
      const match = /^\s*(?:[-*]\s*)?(?:\*\*)?([\p{L}_ -]+)(?:\*\*)?\s*:\s*(.*?)\s*$/iu.exec(line);
      if (!match) continue;
      const key = normalizeKey(match[1]);
      const property = keyMap[key];
      if (property) parsed[property] = match[2];
    }
    const labels = "TITLE|START[_ -]?DATE|START[_ -]?TIME|END[_ -]?DATE|END[_ -]?TIME|DURATION[_ -]?MINUTES|LOCATION|DESCRIPTION|BAŞLIK|BASLIK|KONUM|AÇIKLAMA|ACIKLAMA|BAŞLANGIÇ[_ -]?TARİHİ|BASLANGIC[_ -]?TARIHI|BAŞLANGIÇ[_ -]?SAATİ|BASLANGIC[_ -]?SAATI|BİTİŞ[_ -]?TARİHİ|BITIS[_ -]?TARIHI|BİTİŞ[_ -]?SAATİ|BITIS[_ -]?SAATI|SÜRE[_ -]?DAKİKA|SURE[_ -]?DAKIKA";
    const inline = new RegExp(
      `(?:^|[\\s{,;|])['\"*]*(${labels})['\"*]*\\s*[:=]\\s*(.*?)(?=\\s*(?:[,;|]\\s*)?['\"*]*(?:${labels})['\"*]*\\s*[:=]|$)`,
      "giu",
    );
    const inlineParsed = {};
    for (const match of source.matchAll(inline)) {
      const property = keyMap[normalizeKey(match[1])];
      if (property) inlineParsed[property] = match[2].replace(/^["']|["'}\],]+$/g, "").trim();
    }
    if (Object.keys(inlineParsed).length > 1) {
      parsed = { ...parsed, ...inlineParsed };
    }
  }
  return {
    title: stringValue(parsed.title),
    startDate: stringValue(parsed.startDate ?? parsed.start_date),
    startTime: stringValue(parsed.startTime ?? parsed.start_time),
    endDate: stringValue(parsed.endDate ?? parsed.end_date),
    endTime: stringValue(parsed.endTime ?? parsed.end_time),
    durationMinutes: Number.parseInt(
      parsed.durationMinutes ?? parsed.duration_minutes,
      10,
    ),
    location: stringValue(parsed.location),
    description: stringValue(parsed.description),
  };
}

function scriptsIn(value) {
  const source = String(value ?? "");
  const scripts = {};
  for (const script of [
    "Han",
    "Hangul",
    "Hiragana",
    "Katakana",
    "Arabic",
    "Hebrew",
    "Cyrillic",
    "Devanagari",
    "Thai",
  ]) {
    const matches = source.match(new RegExp(`\\p{Script=${script}}`, "gu"));
    if (matches?.length) scripts[script] = matches.length;
  }
  return scripts;
}

function generatedTextSanity(text, input = {}) {
  const source = String(text ?? "").trim();
  const reasons = [];
  if (!source) reasons.push("empty output");
  if (/\uFFFD/u.test(source)) reasons.push("replacement characters");
  if (/(.{2,12})\1{4,}/u.test(source) || /(.)\1{7,}/u.test(source)) {
    reasons.push("repeated token pattern");
  }
  const inputScripts = scriptsIn(`${input?.subject ?? ""}\n${input?.body ?? ""}`);
  const outputScripts = scriptsIn(source);
  const unexpectedScripts = Object.entries(outputScripts)
    .filter(([script, count]) => count >= 3 && !inputScripts[script])
    .map(([script]) => script);
  if (unexpectedScripts.length) {
    reasons.push(`unexpected scripts: ${unexpectedScripts.join(", ")}`);
  }
  return {
    coherent: reasons.length === 0,
    reasons,
    inputScripts,
    outputScripts,
  };
}

function valueShape(value, depth = 0) {
  if (value == null) return String(value);
  if (typeof value === "string") return `string(${value.length})`;
  if (typeof value !== "object") return typeof value;
  if (depth >= 3) return Array.isArray(value) ? `array(${value.length})` : "object";
  if (Array.isArray(value)) {
    return `array(${value.length})[${value.slice(0, 3).map((item) => valueShape(item, depth + 1)).join(", ")}]`;
  }
  return `object{${Object.entries(value).slice(0, 8)
    .map(([key, item]) => `${key}:${valueShape(item, depth + 1)}`)
    .join(", ")}}`;
}

function textFromContent(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map(textFromContent).filter(Boolean).join("\n");
  }
  if (typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  for (const key of ["content", "message", "generated_text"]) {
    const text = textFromContent(value[key]);
    if (text) return text;
  }
  return "";
}

function extractGeneratedText(output) {
  const generated = output?.[0]?.generated_text ?? output?.generated_text ?? output;
  if (Array.isArray(generated)) {
    const assistant = generated.findLast?.((item) => item?.role === "assistant") ??
      [...generated].reverse().find((item) => item?.role === "assistant");
    if (assistant) return textFromContent(assistant.content ?? assistant);
    return textFromContent(generated.at(-1));
  }
  return textFromContent(generated);
}

function cpuVariant() {
  return {
    key: "cpu",
    label: "native CPU",
    device: "cpu",
    pipelineDevice: "cpu",
    executionProviders: ["cpu"],
    cacheMode: "past-key-values",
    useCache: true,
    // DirectML required conservative graph rewriting. The CPU execution
    // provider supports ONNX Runtime's complete optimization pass, including
    // the MLAS-dispatched AVX2 Q4 kernels on capable x64 processors.
    graphOptimizationLevel: "all",
  };
}

function embeddingVariant(modelId = EMBEDDING_MODEL_ID, dtype = EMBEDDING_DTYPE) {
  return {
    key: `embedding:${modelId}:${dtype}`,
    kind: "embedding",
    label: "native CPU embedding model",
    modelId,
    dtype,
    device: "cpu",
    pipelineDevice: "cpu",
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  };
}

function getTransformersRuntime() {
  if (!transformersRuntime) {
    const { env, pipeline } = require("@huggingface/transformers");
    env.cacheDir = cacheDirectory;
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    transformersRuntime = { env, pipeline };
  }
  return transformersRuntime;
}

function validateEmbeddingRequest(modelId, dtype) {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(modelId)) {
    throw new Error("The embedding model ID is invalid.");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(dtype)) {
    throw new Error("The embedding model dtype is invalid.");
  }
}

function embeddingOptions(maxLength = 256) {
  return {
    pooling: "mean",
    normalize: true,
    truncation: true,
    max_length: Math.max(32, Math.min(512, Number(maxLength) || 256)),
  };
}

function validateEmbeddingVectors(vectors, expectedCount) {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new Error("The native embedding model returned an unexpected batch size.");
  }
  const dimensions = vectors[0]?.length;
  if (!Number.isSafeInteger(dimensions) || dimensions < 32) {
    throw new Error("The native embedding model returned an invalid vector shape.");
  }
  for (const vector of vectors) {
    if (
      !Array.isArray(vector) ||
      vector.length !== dimensions ||
      vector.some((value) => !Number.isFinite(value))
    ) {
      throw new Error("The native embedding model returned non-finite or inconsistent vectors.");
    }
  }
}

async function getEmbeddingExtractor(payload = {}) {
  const modelId = String(payload.modelId || EMBEDDING_MODEL_ID);
  const dtype = String(payload.dtype || EMBEDDING_DTYPE);
  validateEmbeddingRequest(modelId, dtype);
  const signature = `${modelId}:${dtype}`;
  if (embeddingExtractor && embeddingSignature === signature) return embeddingExtractor;
  if (embeddingPipelinePromise && embeddingSignature === signature) {
    return embeddingPipelinePromise;
  }

  embeddingSignature = signature;
  const variant = embeddingVariant(modelId, dtype);
  embeddingPipelinePromise = (async () => {
    fs.mkdirSync(cacheDirectory, { recursive: true });
    const embeddedRuntime = prepareEmbeddedRuntime();
    if (!embeddedRuntime && process.platform === "win32") assertCompleteInstallation();
    const { pipeline } = getTransformersRuntime();
    const downloadedByFile = new Map();
    let lastPublishedPercent = -1;
    diagnostic("embedding.variant.begin", { variant });
    progress(
      "embedding-loading",
      "Preparing the multilingual embedding model on native CPU…",
      undefined,
      variant,
    );
    const candidate = await pipeline("feature-extraction", modelId, {
      device: variant.pipelineDevice,
      dtype,
      session_options: {
        executionProviders: variant.executionProviders,
        executionMode: "sequential",
        graphOptimizationLevel: variant.graphOptimizationLevel,
      },
      progress_callback: (item) => {
        if (item.file && Number.isFinite(item.loaded)) {
          downloadedByFile.set(
            item.file,
            Math.max(downloadedByFile.get(item.file) ?? 0, item.loaded),
          );
        }
        const loadedBytes = [...downloadedByFile.values()]
          .reduce((total, loaded) => total + loaded, 0);
        const percent = Math.min(
          99,
          loadedBytes / (APPROXIMATE_EMBEDDING_MODEL_SIZE_MB * 1_000_000) * 100,
        );
        const rounded = Math.floor(percent);
        if (rounded <= lastPublishedPercent) return;
        lastPublishedPercent = rounded;
        progress(
          "embedding-download",
          `Downloading multilingual embedding model: ${rounded}%`,
          percent,
          variant,
        );
      },
    });
    progress(
      "embedding-validating",
      "Validating English and Turkish embeddings on native CPU…",
      100,
      variant,
    );
    const validation = await candidate(
      ["query: engineering planning meeting", "query: yatırım planlama toplantısı"],
      embeddingOptions(64),
    );
    validateEmbeddingVectors(validation.tolist(), 2);
    if (embeddingExtractor && embeddingExtractor !== candidate) {
      await disposeGenerator(embeddingExtractor);
    }
    embeddingExtractor = candidate;
    diagnostic("embedding.variant.ready", {
      variant,
      dimensions: validation.tolist()[0].length,
    });
    progress(
      "embedding-ready",
      "Multilingual embedding model ready on native CPU.",
      100,
      variant,
    );
    return candidate;
  })().catch((error) => {
    diagnostic("embedding.load.error", {
      modelId,
      dtype,
      name: error?.name,
      message: error?.message ?? String(error),
      stack: error?.stack,
    });
    embeddingPipelinePromise = undefined;
    embeddingExtractor = undefined;
    throw error;
  });
  return embeddingPipelinePromise;
}

async function embedTexts(payload = {}) {
  const texts = Array.isArray(payload.texts)
    ? payload.texts.map((value) => String(value).slice(0, 20_000))
    : [];
  if (!texts.length || texts.length > 32) {
    throw new Error("Native embedding requests require between 1 and 32 texts.");
  }
  const variant = embeddingVariant(
    String(payload.modelId || EMBEDDING_MODEL_ID),
    String(payload.dtype || EMBEDDING_DTYPE),
  );
  const extractor = await getEmbeddingExtractor(payload);
  progress(
    "embedding-inference",
    `Embedding ${texts.length} text${texts.length === 1 ? "" : "s"} on native CPU…`,
    undefined,
    variant,
  );
  const tensor = await extractor(texts, embeddingOptions(payload.maxLength));
  const vectors = tensor.tolist();
  validateEmbeddingVectors(vectors, texts.length);
  diagnostic("embedding.complete", {
    count: vectors.length,
    dimensions: vectors[0].length,
  });
  progress(
    "embedding-ready",
    "Multilingual embedding model ready on native CPU.",
    100,
    variant,
  );
  return {
    vectors,
    engine: /multilingual-e5/i.test(variant.modelId) ? "multilingual-e5" : "embedding",
    modelId: variant.modelId,
    dtype: variant.dtype,
    device: variant.device,
    backend: "native",
    variant,
  };
}

function tokenProgressStreamer(variant, maximumTokens, diagnosticSafe) {
  let promptReceived = false;
  let generatedTokens = 0;
  return {
    put(batch) {
      if (!promptReceived) {
        promptReceived = true;
        return;
      }
      generatedTokens += batch?.[0]?.length ?? 0;
      if (generatedTokens !== 1 && generatedTokens % 4 !== 0) return;
      const phase = diagnosticSafe ? "native-validating" : "native-inference";
      progress(
        phase,
        `${diagnosticSafe ? "Validation" : "Event generation"} on ${variant.label}: ${generatedTokens}/${maximumTokens} tokens…`,
        undefined,
        variant,
      );
      if (generatedTokens === 1 || generatedTokens % 16 === 0) {
        diagnostic("inference.token.progress", {
          variant: variant.key,
          cacheMode: variant.cacheMode,
          generatedTokens,
          maximumTokens,
        });
      }
    },
    end() {
      diagnostic("inference.token.complete", {
        variant: variant.key,
        cacheMode: variant.cacheMode,
        generatedTokens,
        maximumTokens,
      });
    },
  };
}

async function disposeGenerator(model) {
  try {
    await model?.dispose?.();
  } catch (error) {
    diagnostic("model.dispose.error", {
      message: error?.message ?? String(error),
    });
  }
}

function validateWriterDetails(details) {
  const title = String(details?.title ?? "").trim();
  const description = String(details?.description ?? "").trim();
  if (title.length < 4 || title.length > 100 || title.split(/\s+/).length > 16) {
    throw new Error("The model returned an invalid event title.");
  }
  if (description.length < 8 || description.length > 700) {
    throw new Error("The model returned an invalid event description.");
  }
  if (/3\s*(?:-|–)\s*8|natural (?:event )?title|doğal başlık|amacını özetleyen|useful sentence/i.test(`${title}\n${description}`)) {
    throw new Error("The model copied an output-schema placeholder.");
  }
}

function normalizeWriterTitle(value) {
  return String(value ?? "")
    .replace(/^(?:reminder|confirmation|invitation|hat[ıi]rlatma(?:s[ıi])?|davet)\s*[:—–-]\s*/iu, "")
    .replace(/\s+(?:reminder|confirmation|invitation|hat[ıi]rlatma(?:s[ıi])?|onay[ıi]|daveti)\s*$/iu, "")
    .replace(/\b\d{5,}\b/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s:—–-]+$/g, "")
    .trim();
}

async function runWriter(model, input, variant, diagnosticSafe = false) {
  const startedAt = Date.now();
  const maximumTokens = 112;
  const output = await model(
    [{ role: "user", content: promptFor(input) }],
    {
      max_new_tokens: maximumTokens,
      do_sample: false,
      use_cache: true,
      streamer: tokenProgressStreamer(variant, maximumTokens, diagnosticSafe),
    },
  );
  const generated = output?.[0]?.generated_text ?? output?.generated_text;
  const raw = extractGeneratedText(output);
  const sanity = generatedTextSanity(raw, input);
  diagnostic("inference.output", {
    variant: variant.key,
    cacheMode: variant.cacheMode,
    elapsedMs: Date.now() - startedAt,
    outputShape: valueShape(output),
    generatedTextShape: valueShape(generated),
    outputCharacters: raw.length,
    lineCount: raw ? raw.split(/\r?\n/).length : 0,
    ...(diagnosticSafe ? { safeSyntheticOutput: raw.slice(0, 2000) } : {}),
  });
  diagnostic("inference.sanity", { variant: variant.key, ...sanity });
  if (!sanity.coherent) {
    throw new Error(`The model produced incoherent text (${sanity.reasons.join("; ")}).`);
  }
  const parsed = parseGeneratedEvent(raw);
  const details = {
    title: normalizeWriterTitle(parsed.title),
    description: parsed.description,
  };
  validateWriterDetails(details);
  return { ...details, raw };
}

async function smokeTest(model, variant) {
  progress(
    "native-validating",
    `Validating Qwen3.5 on ${variant.label}…`,
    100,
    variant,
  );
  diagnostic("model.smoke.begin", { variant: variant.key });
  const result = await runWriter(model, {
    _diagnosticSafe: true,
    date: "2026-09-06T08:00:00Z",
    subject: "Quarterly roadmap review",
    body: "Please join the product team to review next quarter's priorities and owners.",
    detectedEvent: {
      startDate: "2026-09-10",
      startTime: "14:00",
      endDate: "2026-09-10",
      endTime: "15:00",
      durationMinutes: 60,
      location: "Meeting Room Atlas",
    },
  }, variant, true);
  diagnostic("model.smoke.ready", {
    variant: variant.key,
    title: result.title,
    descriptionCharacters: result.description.length,
  });
  const turkish = await runWriter(model, {
    _diagnosticSafe: true,
    date: "2026-09-06T08:00:00Z",
    subject: "Yatırımcı buluşması hatırlatması",
    body: "Fonun yeni yatırım stratejisini ve yıl sonu hedeflerini görüşmek üzere yatırımcılarımızı bekliyoruz.",
    detectedEvent: {
      startDate: "2026-09-18",
      startTime: "10:00",
      endDate: "2026-09-18",
      endTime: "11:30",
      durationMinutes: 90,
      location: "Yapı Kredi Plaza",
    },
  }, variant, true);
  if (!/[çğıöşüÇĞİÖŞÜ]|\b(?:ve|için|yatırım|strateji|hedef)\b/i.test(`${turkish.title} ${turkish.description}`)) {
    throw new Error("The model failed the Turkish-language smoke test.");
  }
  diagnostic("model.smoke.turkish.ready", {
    variant: variant.key,
    title: turkish.title,
    descriptionCharacters: turkish.description.length,
  });
}

async function loadVariant(pipeline, variant) {
  const lastBuckets = new Map();
  const downloadedByFile = new Map();
  let lastPublishedPercent = -1;
  const startedAt = Date.now();
  let validating = false;
  diagnostic("model.variant.begin", {
    variant,
    modelId: MODEL_ID,
    dtype: DTYPE,
  });
  progress("native-loading", `Starting ${variant.label}…`, undefined, variant);
  const heartbeat = setInterval(() => {
    progress(
      validating ? "native-validating" : "native-initializing",
      `${validating ? "Validating" : "Initializing"} Qwen3.5 on ${variant.label}… (${Math.round((Date.now() - startedAt) / 1000)}s)`,
      undefined,
      variant,
    );
  }, 5000);
  let candidate;
  try {
    candidate = await pipeline("text-generation", MODEL_ID, {
      device: variant.pipelineDevice,
      dtype: DTYPE,
      session_options: {
        executionProviders: variant.executionProviders,
        executionMode: "sequential",
        enableMemPattern: false,
        graphOptimizationLevel: variant.graphOptimizationLevel ?? "all",
      },
      progress_callback: (item) => {
        const percent = Number.isFinite(item.progress) ? item.progress : undefined;
        const bucket = Number.isFinite(percent) ? Math.floor(percent / 5) : -1;
        const stream = `${item.status ?? "unknown"}:${item.file ?? "total"}`;
        if (bucket !== lastBuckets.get(stream)) {
          lastBuckets.set(stream, bucket);
          diagnostic("model.progress", {
            variant: variant.key,
            status: item.status,
            file: item.file,
            loaded: item.loaded,
            total: item.total,
            percent,
          });
        }
        if (item.file && Number.isFinite(item.loaded)) {
          downloadedByFile.set(
            item.file,
            Math.max(downloadedByFile.get(item.file) ?? 0, item.loaded),
          );
        }
        // Some Transformers.js versions do not emit progress_total. Derive a
        // monotonic aggregate from unique file byte counts and the known model
        // size, while reserving 100% for successful initialization.
        const loadedBytes = [...downloadedByFile.values()]
          .reduce((total, loaded) => total + loaded, 0);
        const derivedPercent = Math.min(
          99,
          loadedBytes / (APPROXIMATE_MODEL_SIZE_MB * 1_000_000) * 100,
        );
        const aggregatePercent = item.status === "progress_total" && Number.isFinite(percent)
          ? Math.min(99, percent)
          : derivedPercent;
        const rounded = Math.floor(aggregatePercent);
        if (rounded > lastPublishedPercent) {
          lastPublishedPercent = rounded;
          progress(
            "native-download",
            `Downloading Qwen3.5: ${rounded}%`,
            aggregatePercent,
            variant,
          );
        }
      },
    });
    validating = true;
    if (hasCurrentCpuValidation()) {
      diagnostic("model.smoke.skip", {
        key: cpuValidationKey(),
        reason: "This exact CPU model/runtime already passed bilingual validation.",
      });
    } else {
      await smokeTest(candidate, variant);
      rememberCpuValidation();
    }
    diagnostic("model.variant.ready", {
      variant: variant.key,
      elapsedMs: Date.now() - startedAt,
    });
    return candidate;
  } catch (error) {
    diagnostic("model.variant.error", {
      variant: variant.key,
      elapsedMs: Date.now() - startedAt,
      name: error?.name,
      message: error?.message ?? String(error),
      stack: error?.stack,
    });
    await disposeGenerator(candidate);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

async function getGenerator() {
  if (generator) return generator;
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      fs.mkdirSync(cacheDirectory, { recursive: true });
      const embeddedRuntime = prepareEmbeddedRuntime();
      if (!embeddedRuntime && process.platform === "win32") {
        assertCompleteInstallation();
      }
      const { pipeline } = getTransformersRuntime();
      const variant = cpuVariant();
      generator = await loadVariant(pipeline, variant);
      activeVariant = variant;
      progress("ready", `Qwen3.5 ready on ${variant.label}.`, 100, variant);
      return generator;
    })().catch((error) => {
      diagnostic("model.load.error", {
        name: error?.name,
        message: error?.message ?? String(error),
        stack: error?.stack,
      });
      pipelinePromise = undefined;
      generator = undefined;
      activeVariant = undefined;
      throw error;
    });
  }
  return pipelinePromise;
}

async function generate(input) {
  const model = await getGenerator();
  lastGenerationState = "running";
  progress("native-inference", `Writing event details on ${activeVariant.label}…`);
  diagnostic("inference.begin", {
    variant: activeVariant.key,
    subjectCharacters: String(input?.subject ?? "").length,
    bodyCharacters: String(input?.body ?? "").length,
    verifiedFields: Object.entries(input?.detectedEvent ?? {})
      .filter(([, value]) => value != null && value !== "")
      .map(([key]) => key),
  });
  const written = await runWriter(
    model,
    input,
    activeVariant,
    Boolean(input?._diagnosticSafe),
  );
  lastGenerationState = "ready";
  diagnostic("inference.complete", {
    variant: activeVariant.key,
    outputCharacters: written.raw.length,
    fieldsPresent: ["title", "description"],
  });
  progress("ready", `Qwen3.5 ready on ${activeVariant.label}.`, 100);
  return {
    title: written.title,
    description: written.description,
    _engine: `qwen3.5-0.8b-${activeVariant.key}`,
    _device: activeVariant.device,
    _dtype: DTYPE,
    _backend: "native",
    _raw: written.raw.slice(0, 2000),
  };
}

function clearWorkerRequestTimers(request) {
  clearTimeout(request?.activityTimer);
  clearTimeout(request?.hardTimer);
  clearInterval(request?.heartbeatTimer);
}

function workerError(message, code = "MODEL_WORKER_ERROR") {
  const error = new Error(message);
  error.code = code;
  error.workerMode = runtimeWorkerMode;
  return error;
}

function rejectRuntimeWorkerRequests(error) {
  for (const request of runtimeWorkerPending.values()) {
    clearWorkerRequestTimers(request);
    request.reject(error);
  }
  runtimeWorkerPending.clear();
}

function stopRuntimeWorker(error) {
  const child = runtimeWorker;
  runtimeWorker = undefined;
  runtimeWorkerBuffer = "";
  runtimeWorkerState = error ? "failed" : "idle";
  if (error) rejectRuntimeWorkerRequests(error);
  if (child && !child.killed) child.kill();
}

function touchRuntimeWorkerRequest(id) {
  const request = runtimeWorkerPending.get(id);
  if (!request) return;
  request.lastActivityAt = Date.now();
  clearTimeout(request.activityTimer);
  request.activityTimer = setTimeout(() => {
    if (!runtimeWorkerPending.has(id)) return;
    runtimeWorkerPending.delete(id);
    const error = workerError(
      `The ${runtimeWorkerMode} model worker produced no progress or diagnostics for three minutes.`,
      "MODEL_WORKER_STALLED",
    );
    clearWorkerRequestTimers(request);
    diagnostic("worker.stalled", {
      method: request.method,
      mode: error.workerMode,
      lastProgress: runtimeWorkerLastProgress,
    });
    request.reject(error);
    stopRuntimeWorker(error);
  }, MODEL_WORKER_ACTIVITY_TIMEOUT_MS);
}

function receiveRuntimeWorkerMessage(message) {
  if (message?.requestId != null) touchRuntimeWorkerRequest(message.requestId);
  if (message?.type === "worker-diagnostic") {
    const entry = message.entry ?? {};
    runtimeWorkerDiagnostics.push({
      ...entry,
      stage: `worker.${entry.stage ?? "unknown"}`,
    });
    runtimeWorkerDiagnostics = runtimeWorkerDiagnostics.slice(-MAX_DIAGNOSTICS);
    send({
      type: "diagnostic",
      requestId: message.requestId,
      diagnostics: diagnosticReport(),
    });
    return;
  }
  if (message?.type === "progress") {
    runtimeWorkerLastProgress = {
      at: new Date().toISOString(),
      phase: message.phase,
      detail: message.detail,
      percent: message.percent,
      device: message.device,
      dtype: message.dtype,
      variant: message.variant,
    };
    if (message.phase === "ready" && message.variant) {
      runtimeWorkerActiveVariant = message.variant;
    }
    runtimeWorkerState = message.phase === "ready"
      ? "ready"
      : message.phase === "native-inference"
        ? "generating"
        : "loading";
    send(message);
    return;
  }
  if (message?.type !== "response") return;
  const request = runtimeWorkerPending.get(message.id);
  if (!request) return;
  runtimeWorkerPending.delete(message.id);
  clearWorkerRequestTimers(request);
  if (message.ok) {
    runtimeWorkerState = "ready";
    if (message.result?.variant) runtimeWorkerActiveVariant = message.result.variant;
    request.resolve(message.result);
    return;
  }
  const error = workerError(message.error ?? "The model worker request failed.");
  if (message.diagnostics?.entries) {
    runtimeWorkerDiagnostics.push(...message.diagnostics.entries.map((entry) => ({
      ...entry,
      stage: `worker.${entry.stage ?? "unknown"}`,
    })));
    runtimeWorkerDiagnostics = runtimeWorkerDiagnostics.slice(-MAX_DIAGNOSTICS);
  }
  runtimeWorkerState = "failed";
  request.reject(error);
}

function startRuntimeWorker() {
  const requestedMode = "cpu";
  if (runtimeWorker && runtimeWorkerMode === requestedMode) return runtimeWorker;
  if (runtimeWorker) stopRuntimeWorker(workerError("The model worker was replaced."));

  let packaged = false;
  try {
    const sea = require("node:sea");
    packaged = Boolean(sea.isSea?.());
  } catch {
    // The development host runs as an ordinary Node.js script.
  }
  const args = packaged ? ["--model-worker"] : [__filename, "--model-worker"];
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      LOCAL_TRIAGE_FORCE_CPU: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  runtimeWorker = child;
  runtimeWorkerMode = requestedMode;
  runtimeWorkerState = "starting";
  runtimeWorkerBuffer = "";
  runtimeWorkerActiveVariant = undefined;
  diagnostic("worker.spawn", {
    mode: requestedMode,
    pid: child.pid,
    packaged,
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    runtimeWorkerBuffer += chunk;
    while (runtimeWorkerBuffer.includes("\n")) {
      const newline = runtimeWorkerBuffer.indexOf("\n");
      const line = runtimeWorkerBuffer.slice(0, newline);
      runtimeWorkerBuffer = runtimeWorkerBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        receiveRuntimeWorkerMessage(JSON.parse(line));
      } catch (error) {
        diagnostic("worker.protocol.error", {
          message: error?.message ?? String(error),
          line: line.slice(0, 1000),
        });
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    diagnostic("worker.stderr", {
      mode: requestedMode,
      message: String(chunk).trim().slice(0, 4000),
    });
  });
  child.on("error", (error) => {
    if (runtimeWorker !== child) return;
    const wrapped = workerError(
      `Could not start the ${requestedMode} model worker: ${error?.message ?? error}`,
    );
    diagnostic("worker.error", { mode: requestedMode, message: wrapped.message });
    stopRuntimeWorker(wrapped);
  });
  child.on("exit", (code, signal) => {
    if (runtimeWorker !== child) return;
    const error = workerError(
      `The ${requestedMode} model worker exited (${signal || (code ?? "unknown")}).`,
    );
    diagnostic("worker.exit", { mode: requestedMode, code, signal });
    stopRuntimeWorker(error);
  });
  return child;
}

function requestRuntimeWorker(method, payload) {
  const child = startRuntimeWorker();
  const id = runtimeWorkerNextId++;
  runtimeWorkerState = method === "generate" ? "generating" : "loading";
  const startedAt = Date.now();
  const embedding = method === "prepare-embedding" || method === "embed";
  const startingVariant = embedding
    ? embeddingVariant(
        String(payload?.modelId || EMBEDDING_MODEL_ID),
        String(payload?.dtype || EMBEDDING_DTYPE),
      )
    : { device: "cpu", key: "cpu", label: "native CPU" };
  progress(
    "native-worker-starting",
    `Starting the native CPU ${embedding ? "embedding " : ""}model worker (PID ${child.pid ?? "pending"})…`,
    undefined,
    startingVariant,
  );
  const response = new Promise((resolve, reject) => {
    const request = {
      method,
      resolve,
      reject,
      startedAt,
      lastActivityAt: startedAt,
      activityTimer: undefined,
      hardTimer: undefined,
      heartbeatTimer: undefined,
    };
    request.hardTimer = setTimeout(() => {
      if (!runtimeWorkerPending.has(id)) return;
      runtimeWorkerPending.delete(id);
      const error = workerError(
        `The ${runtimeWorkerMode} model worker exceeded its hard time limit.`,
        "MODEL_WORKER_TIMEOUT",
      );
      clearWorkerRequestTimers(request);
      diagnostic("worker.timeout", { method, mode: error.workerMode });
      request.reject(error);
      stopRuntimeWorker(error);
    }, MODEL_WORKER_HARD_TIMEOUT_MS);
    request.heartbeatTimer = setInterval(() => {
      if (!runtimeWorkerPending.has(id)) return;
      const elapsedSeconds = Math.round((Date.now() - request.startedAt) / 1000);
      const silentSeconds = Math.round((Date.now() - request.lastActivityAt) / 1000);
      const lastPhase = runtimeWorkerLastProgress?.phase ?? runtimeWorkerState;
      progress(
        "native-supervisor-wait",
        `Native CPU model preparation is running (${elapsedSeconds}s; last worker stage: ${lastPhase}; ${silentSeconds}s since worker activity)…`,
        runtimeWorkerLastProgress?.percent,
        runtimeWorkerLastProgress?.variant ?? startingVariant,
      );
      send({
        type: "diagnostic",
        requestId: id,
        diagnostics: diagnosticReport(),
      });
    }, MODEL_WORKER_HEARTBEAT_MS);
    runtimeWorkerPending.set(id, request);
    touchRuntimeWorkerRequest(id);
  });
  try {
    child.stdin.write(`${JSON.stringify({ id, method, payload })}\n`);
  } catch (error) {
    const request = runtimeWorkerPending.get(id);
    runtimeWorkerPending.delete(id);
    clearWorkerRequestTimers(request);
    return Promise.reject(workerError(
      `Could not send ${method} to the model worker: ${error?.message ?? error}`,
    ));
  }
  return response;
}

async function supervisedModelRequest(method, payload) {
  return requestRuntimeWorker(method, payload);
}

async function handleSupervisor(message) {
  const { id, method, payload } = message ?? {};
  activeRequestId = id;
  try {
    let result;
    switch (method) {
      case "ping":
        result = {
          hostVersion: HOST_VERSION,
          runtimeVersion: RUNTIME_VERSION,
          modelId: MODEL_ID,
          embeddingModelId: EMBEDDING_MODEL_ID,
          platform: process.platform,
          arch: process.arch,
        };
        break;
      case "prepare":
      case "generate":
      case "prepare-embedding":
      case "embed":
        if (method === "generate") lastGenerationState = "running";
        result = await supervisedModelRequest(method, payload ?? {});
        if (method === "generate") lastGenerationState = "ready";
        break;
      case "diagnostics":
        result = diagnosticReport();
        break;
      case "clear-diagnostics":
        diagnostics = [];
        runtimeWorkerDiagnostics = [];
        diagnostic("diagnostics.cleared");
        result = diagnosticReport();
        break;
      default:
        throw new Error(`Unknown native-host method: ${method}`);
    }
    send({ type: "response", id, ok: true, result });
  } catch (error) {
    if (method === "generate") lastGenerationState = "failed";
    diagnostic("request.error", {
      id,
      method,
      code: error?.code,
      name: error?.name,
      message: error?.message ?? String(error),
      stack: error?.stack,
    });
    send({
      type: "response",
      id,
      ok: false,
      error: `${error?.name ?? "Error"}: ${error?.message ?? error}`,
      diagnostics: diagnosticReport(),
    });
  } finally {
    activeRequestId = undefined;
  }
}

async function handle(message) {
  const { id, method, payload } = message ?? {};
  activeRequestId = id;
  try {
    let result;
    if (
      MODEL_WORKER_MODE &&
      process.env.LOCAL_TRIAGE_TEST_MODEL_WORKER === "silent" &&
      method === "prepare"
    ) {
      // Test-only frozen native call: the supervisor must remain observable and
      // terminate it through the inactivity watchdog.
      await new Promise(() => {});
    }
    if (
      MODEL_WORKER_MODE &&
      process.env.LOCAL_TRIAGE_TEST_MODEL_WORKER === "progress" &&
      (method === "prepare" || method === "prepare-embedding" || method === "embed")
    ) {
      const embedding = method !== "prepare";
      const variant = embedding
        ? embeddingVariant()
        : { key: "cpu", label: "native CPU", device: "cpu" };
      diagnostic(
        embedding ? "test.embedding.prepare" : "test.model.prepare",
        { variant: variant.key },
      );
      progress(
        embedding ? "embedding-validating" : "native-validating",
        `Validating the synthetic CPU ${embedding ? "embedding " : ""}worker…`,
        75,
        variant,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (!embedding) activeVariant = variant;
      result = method === "embed"
        ? {
            vectors: [[1, 0, 0], [0, 1, 0]],
            engine: "multilingual-e5",
            modelId: EMBEDDING_MODEL_ID,
            runtimeVersion: RUNTIME_VERSION,
            device: "cpu",
            dtype: EMBEDDING_DTYPE,
            backend: "native",
            variant,
          }
        : {
            engine: embedding ? "multilingual-e5" : "qwen3.5-0.8b-cpu",
            modelId: embedding ? EMBEDDING_MODEL_ID : MODEL_ID,
            activeModelId: embedding ? undefined : MODEL_ID,
            runtimeVersion: RUNTIME_VERSION,
            device: variant.device,
            dtype: embedding ? EMBEDDING_DTYPE : DTYPE,
            backend: "native",
            approximateSizeMb: embedding
              ? APPROXIMATE_EMBEDDING_MODEL_SIZE_MB
              : APPROXIMATE_MODEL_SIZE_MB,
            variant,
          };
      send({ type: "response", id, ok: true, result });
      return;
    }
    switch (method) {
      case "ping":
        result = {
          hostVersion: HOST_VERSION,
          runtimeVersion: RUNTIME_VERSION,
          modelId: MODEL_ID,
          embeddingModelId: EMBEDDING_MODEL_ID,
          platform: process.platform,
          arch: process.arch,
        };
        break;
      case "prepare":
        await getGenerator();
        result = {
          engine: `qwen3.5-0.8b-${activeVariant.key}`,
          modelId: MODEL_ID,
          activeModelId: MODEL_ID,
          runtimeVersion: RUNTIME_VERSION,
          device: activeVariant.device,
          dtype: DTYPE,
          backend: "native",
          approximateSizeMb: APPROXIMATE_MODEL_SIZE_MB,
          variant: activeVariant,
        };
        break;
      case "prepare-embedding": {
        await getEmbeddingExtractor(payload ?? {});
        const variant = embeddingVariant(
          String(payload?.modelId || EMBEDDING_MODEL_ID),
          String(payload?.dtype || EMBEDDING_DTYPE),
        );
        result = {
          engine: /multilingual-e5/i.test(variant.modelId)
            ? "multilingual-e5"
            : "embedding",
          modelId: variant.modelId,
          runtimeVersion: RUNTIME_VERSION,
          device: variant.device,
          dtype: variant.dtype,
          backend: "native",
          approximateSizeMb: APPROXIMATE_EMBEDDING_MODEL_SIZE_MB,
          variant,
        };
        break;
      }
      case "embed":
        result = await (embeddingQueue = embeddingQueue.then(
          () => embedTexts(payload ?? {}),
          () => embedTexts(payload ?? {}),
        ));
        break;
      case "generate":
        result = await (generationQueue = generationQueue.then(
          () => generate(payload),
          () => generate(payload),
        ));
        break;
      case "diagnostics":
        result = diagnosticReport();
        break;
      case "clear-diagnostics":
        diagnostics = [];
        diagnostic("diagnostics.cleared");
        result = diagnosticReport();
        break;
      default:
        throw new Error(`Unknown native-host method: ${method}`);
    }
    send({ type: "response", id, ok: true, result });
  } catch (error) {
    diagnostic("request.error", {
      id,
      method,
      name: error?.name,
      message: error?.message ?? String(error),
      stack: error?.stack,
    });
    send({
      type: "response",
      id,
      ok: false,
      error: `${error?.name ?? "Error"}: ${error?.message ?? error}`,
      diagnostics: diagnosticReport(),
    });
  } finally {
    activeRequestId = undefined;
  }
}

function runNativeMessaging(handler = handle) {
  if (packagedSea()) {
    prepareEmbeddedRuntime();
    assertCompleteInstallation();
  }
  diagnostic("host.start", diagnosticReport().environment);
  let incoming = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    incoming = Buffer.concat([incoming, chunk]);
    while (incoming.length >= 4) {
      const length = incoming.readUInt32LE(0);
      if (length > 1024 * 1024) {
        diagnostic("protocol.error", { length });
        process.exitCode = 2;
        return;
      }
      if (incoming.length < length + 4) return;
      const body = incoming.subarray(4, length + 4);
      incoming = incoming.subarray(length + 4);
      try {
        handler(JSON.parse(body.toString("utf8")));
      } catch (error) {
        diagnostic("protocol.parse.error", { message: error?.message ?? String(error) });
      }
    }
  });
  process.stdin.on("end", () => {
    if (!MODEL_WORKER_MODE) stopRuntimeWorker();
    process.exit(0);
  });
  process.stdin.resume();
}

function runModelWorkerMessaging() {
  diagnostic("worker.start", diagnosticReport().environment);
  let incoming = "";
  process.stdin.setEncoding("utf8");
  let messageQueue = Promise.resolve();
  process.stdin.on("data", (chunk) => {
    incoming += chunk;
    while (incoming.includes("\n")) {
      const newline = incoming.indexOf("\n");
      const line = incoming.slice(0, newline);
      incoming = incoming.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        messageQueue = messageQueue.then(
          () => handle(message),
          () => handle(message),
        );
      } catch (error) {
        diagnostic("worker.protocol.parse.error", {
          message: error?.message ?? String(error),
        });
      }
    }
  });
  process.stdin.on("end", async () => {
    await disposeGenerator(generator);
    process.exit(0);
  });
  process.stdin.resume();
}

if (process.env.LOCAL_TRIAGE_LAUNCH_MODE_TEST === "1") {
  let launchModeInput = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { launchModeInput += chunk; });
  process.stdin.on("end", () => {
    const request = launchModeInput ? JSON.parse(launchModeInput) : {};
    process.stdout.write(`${JSON.stringify({
      mode: detectLaunchMode(request.argv ?? [], Boolean(request.packaged)),
      nativeMessaging: isNativeMessagingInvocation(request.argv ?? []),
    })}\n`);
  });
} else if (process.env.LOCAL_TRIAGE_PROFILE_TEST === "1") {
  let profileInput = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { profileInput += chunk; });
  process.stdin.on("end", () => {
    const request = profileInput ? JSON.parse(profileInput) : {};
    const installed = request.xpiPath
      ? installExtensionIntoDefaultProfile(request.xpiPath, request.appDataDirectory)
      : undefined;
    process.stdout.write(`${JSON.stringify({
      sections: Object.fromEntries(parseIniSections(request.content ?? "")),
      profile: findDefaultThunderbirdProfile(request.appDataDirectory),
      installed,
    })}\n`);
  });
} else if (process.env.LOCAL_TRIAGE_PARSER_TEST === "1") {
  let parserInput = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { parserInput += chunk; });
  process.stdin.on("end", () => {
    process.stdout.write(`${JSON.stringify(parseGeneratedEvent(parserInput))}\n`);
  });
} else if (process.env.LOCAL_TRIAGE_PROMPT_TEST === "1") {
  let promptInput = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { promptInput += chunk; });
  process.stdin.on("end", () => {
    process.stdout.write(promptFor(JSON.parse(promptInput)));
  });
} else if (process.env.LOCAL_TRIAGE_SANITY_TEST === "1") {
  let sanityInput = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { sanityInput += chunk; });
  process.stdin.on("end", () => {
    process.stdout.write(`${JSON.stringify(generatedTextSanity(sanityInput))}\n`);
  });
} else if (detectLaunchMode() === "install") {
  try {
    installSelf();
  } catch (error) {
    process.stderr.write(`Installation failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
} else if (detectLaunchMode() === "diagnostics") {
  process.stdout.write(`${JSON.stringify(diagnosticReport(), null, 2)}\n`);
} else if (detectLaunchMode() === "model-worker") {
  runModelWorkerMessaging();
} else {
  runNativeMessaging(handleSupervisor);
}

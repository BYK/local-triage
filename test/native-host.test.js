import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const hostPath = new URL("../native/directml-host/host.cjs", import.meta.url);

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

async function detectLaunchMode(request) {
  const child = spawn(process.execPath, [hostPath.pathname], {
    env: { ...process.env, LOCAL_TRIAGE_LAUNCH_MODE_TEST: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stdin.end(JSON.stringify(request));
  await once(child, "exit");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function runNativeRequest(method, environment = {}, timeoutMs = 5000) {
  const child = spawn(process.execPath, [hostPath.pathname], {
    env: { ...process.env, ...environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  const messages = [];
  let incoming = Buffer.alloc(0);
  let settle;
  const response = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Native request ${method} timed out in the test harness.`));
    }, timeoutMs);
    settle = (value, error) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
  });
  child.stdout.on("data", (chunk) => {
    incoming = Buffer.concat([incoming, chunk]);
    while (incoming.length >= 4) {
      const length = incoming.readUInt32LE(0);
      if (incoming.length < length + 4) return;
      const message = JSON.parse(incoming.subarray(4, length + 4).toString("utf8"));
      incoming = incoming.subarray(length + 4);
      messages.push(message);
      if (message.type === "response" && message.id === 91) settle(message);
    }
  });
  child.once("error", (error) => settle(undefined, error));
  child.stdin.write(frame({ id: 91, method, payload: {} }));
  const result = await response;
  child.stdin.end();
  await exited;
  return { response: result, messages };
}

test("packaged launch routing distinguishes Explorer from Thunderbird", async () => {
  const executable = "C:\\Users\\BYK\\Downloads\\local-triage-windows-installer-0.13.9-win-x64.exe";
  assert.deepEqual(
    await detectLaunchMode({ argv: [executable, executable], packaged: true }),
    { mode: "install", nativeMessaging: false },
  );
  assert.deepEqual(
    await detectLaunchMode({ argv: [executable, executable], packaged: false }),
    { mode: "install", nativeMessaging: false },
  );
  assert.deepEqual(
    await detectLaunchMode({
      argv: [
        executable,
        executable,
        "C:\\Users\\BYK\\AppData\\Local\\LocalTriage\\NativeHost\\im.byk.local_triage.json",
        "local-triage@byk.im",
      ],
      packaged: true,
    }),
    { mode: "native-messaging", nativeMessaging: true },
  );
  assert.deepEqual(
    await detectLaunchMode({ argv: [executable, executable, "--model-worker"], packaged: true }),
    { mode: "model-worker", nativeMessaging: false },
  );
  assert.deepEqual(
    await detectLaunchMode({ argv: [executable, executable, "--diagnostics"], packaged: true }),
    { mode: "diagnostics", nativeMessaging: false },
  );
});

test("installer copies the embedded XPI into Thunderbird's default profile", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "local-triage-profile-"));
  try {
    const appData = path.join(directory, "AppData", "Roaming");
    const thunderbird = path.join(appData, "Thunderbird");
    const profile = path.join(thunderbird, "Profiles", "abc.default-release");
    const xpiPath = path.join(directory, "local-triage.xpi");
    const profilesIni = [
      "[Profile0]",
      "Name=default-release",
      "IsRelative=1",
      "Path=Profiles/abc.default-release",
      "Default=1",
      "",
      "[Install123]",
      "Default=Profiles/abc.default-release",
      "Locked=1",
      "",
    ].join("\n");
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(thunderbird, "profiles.ini"), profilesIni);
    await writeFile(xpiPath, "verified embedded extension bytes");

    const child = spawn(process.execPath, [hostPath.pathname], {
      env: { ...process.env, LOCAL_TRIAGE_PROFILE_TEST: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stdin.end(JSON.stringify({ content: profilesIni, appDataDirectory: appData, xpiPath }));
    await once(child, "exit");

    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const installed = path.join(profile, "extensions", "local-triage@byk.im.xpi");
    assert.equal(result.profile, profile);
    assert.equal(result.installed, installed);
    assert.equal(await readFile(installed, "utf8"), "verified embedded extension bytes");
    assert.equal(result.sections.Install123.Default, "Profiles/abc.default-release");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native host speaks Thunderbird's length-prefixed protocol", async () => {
  const child = spawn(process.execPath, [hostPath.pathname], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stdin.end(frame({ id: 7, method: "ping", payload: {} }));
  await once(child, "exit");

  const output = Buffer.concat(chunks);
  assert.ok(output.length >= 4);
  const length = output.readUInt32LE(0);
  const response = JSON.parse(output.subarray(4, 4 + length).toString("utf8"));
  assert.equal(response.type, "response");
  assert.equal(response.id, 7);
  assert.equal(response.ok, true);
  assert.equal(response.result.modelId, "onnx-community/Qwen3.5-0.8B-ONNX");
  assert.equal(response.result.embeddingModelId, "Xenova/multilingual-e5-small");
  assert.equal(response.result.hostVersion, "0.13.9");
  assert.equal(response.result.runtimeVersion, 30);
});

test("native embedding preparation forwards distinct progress", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "local-triage-embedding-"));
  try {
    const result = await runNativeRequest("prepare-embedding", {
      LOCALAPPDATA: directory,
      LOCAL_TRIAGE_TEST_MODEL_WORKER: "progress",
      LOCAL_TRIAGE_MODEL_WORKER_HEARTBEAT_MS: "20",
    });
    assert.equal(result.response.ok, true);
    assert.equal(result.response.result.modelId, "Xenova/multilingual-e5-small");
    assert.equal(result.response.result.device, "cpu");
    assert.ok(result.messages.some((message) =>
      message.type === "progress" &&
      message.phase === "embedding-validating" &&
      message.variant?.kind === "embedding"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native CPU preparation forwards worker stages and live diagnostics", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "local-triage-prepare-"));
  try {
    const result = await runNativeRequest("prepare", {
      LOCALAPPDATA: directory,
      LOCAL_TRIAGE_TEST_MODEL_WORKER: "progress",
      LOCAL_TRIAGE_MODEL_WORKER_HEARTBEAT_MS: "20",
    });
    assert.equal(result.response.ok, true);
    assert.equal(result.response.result.device, "cpu");
    const phases = result.messages
      .filter((message) => message.type === "progress")
      .map((message) => message.phase);
    assert.ok(phases.includes("native-worker-starting"));
    assert.ok(phases.includes("native-validating"));
    assert.ok(result.messages.some((message) =>
      message.type === "diagnostic" &&
      message.diagnostics?.entries?.some((entry) =>
        entry.stage === "worker.test.model.prepare")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("silent CPU workers report progress and fail within the inactivity limit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "local-triage-stall-"));
  try {
    const result = await runNativeRequest("prepare", {
      LOCALAPPDATA: directory,
      LOCAL_TRIAGE_TEST_MODEL_WORKER: "silent",
      LOCAL_TRIAGE_MODEL_WORKER_ACTIVITY_TIMEOUT_MS: "120",
      LOCAL_TRIAGE_MODEL_WORKER_HARD_TIMEOUT_MS: "1000",
      LOCAL_TRIAGE_MODEL_WORKER_HEARTBEAT_MS: "25",
    });
    assert.equal(result.response.ok, false);
    assert.match(result.response.error, /no progress or diagnostics/i);
    assert.ok(result.messages.some((message) =>
      message.type === "progress" &&
      message.phase === "native-supervisor-wait"));
    assert.ok(result.response.diagnostics.entries.some((entry) =>
      entry.stage === "worker.stalled"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("supervisor diagnostics do not claim a backend is ready prematurely", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "local-triage-report-"));
  try {
    const child = spawn(process.execPath, [hostPath.pathname], {
      env: { ...process.env, LOCALAPPDATA: directory },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stdin.end(frame({ id: 8, method: "diagnostics", payload: {} }));
    await once(child, "exit");

    const output = Buffer.concat(chunks);
    const length = output.readUInt32LE(0);
    const response = JSON.parse(output.subarray(4, 4 + length).toString("utf8"));
    assert.equal(response.ok, true);
    assert.equal(response.result.device, "not loaded");
    assert.equal(response.result.runtimeVersion, 30);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native writer prompt preserves parser facts and requests only prose fields", async () => {
  const child = spawn(process.execPath, [hostPath.pathname], {
    env: { ...process.env, LOCAL_TRIAGE_PROMPT_TEST: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stdin.end(JSON.stringify({
    subject: "Viewing confirmation",
    body: "Please attend the property viewing.",
    detectedEvent: {
      startDate: "2026-09-10",
      startTime: "14:00",
      endDate: "2026-09-10",
      endTime: "14:30",
      durationMinutes: 30,
      location: "Flat 8, Brunswick Court",
    },
  }));
  await once(child, "exit");

  const prompt = Buffer.concat(chunks).toString("utf8");
  assert.match(prompt, /VERIFIED FACTS/);
  assert.match(prompt, /Flat 8, Brunswick Court/);
  assert.match(prompt, /"startDate":"2026-09-10"/);
  assert.match(prompt, /Do not extract date, time, duration, or location/);
  assert.doesNotMatch(prompt, /"start_date":"YYYY-MM-DD/);
});

test("native host accepts compact inline model fields", async () => {
  const child = spawn(process.execPath, [hostPath.pathname], {
    env: { ...process.env, LOCAL_TRIAGE_PARSER_TEST: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stdin.end(
    "TITLE: Engineering Planning; START_DATE: 2026-09-10; START_TIME: 14:00; " +
    "END_TIME: 16:00; LOCATION: The Shard, Level 12; " +
    "DESCRIPTION: Review staffing and release risks.",
  );
  await once(child, "exit");

  const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal(result.title, "Engineering Planning");
  assert.equal(result.startDate, "2026-09-10");
  assert.equal(result.startTime, "14:00");
  assert.equal(result.endTime, "16:00");
  assert.equal(result.location, "The Shard, Level 12");
  assert.equal(result.description, "Review staffing and release risks.");
});

test("native host detects numerically corrupted generated text", async () => {
  const child = spawn(process.execPath, [hostPath.pathname], {
    env: { ...process.env, LOCAL_TRIAGE_SANITY_TEST: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stdin.end("TITLE: Planning 根本者根本者根本者根本者根本者");
  await once(child, "exit");

  const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal(result.coherent, false);
  assert.ok(result.reasons.some((reason) => reason.includes("unexpected scripts")));
  assert.ok(result.reasons.includes("repeated token pattern"));
});

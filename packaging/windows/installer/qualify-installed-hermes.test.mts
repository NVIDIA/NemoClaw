// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { acceptanceProcessesStopped } from "./qualify-finished-package.mts";
import {
  sanitizedFailure,
  stripInheritedAcceptanceEnvironment,
} from "./qualify-installed-openclaw.mts";
import {
  createHermesEvidenceDirectory,
  readHermesDashboardReady,
  recordedHermesTerminal,
  hermesInstalledToolCommand,
  hermesInstalledCodeCommand,
  recordedHermesCode,
  recordedHermesBrowser,
  validateHermesEdgeReceipt,
  createHermesPtyState,
  finalHermesAssistant,
  finalHermesTurn,
  hermesTurnIndex,
  hermesMessagesAfter,
  hermesTranscriptRoute,
  applyHermesSocketObservations,
  hermesPromptLines,
  hermesPromptFrames,
  sendHermesPromptFrames,
  sanitizeHermesBrowserDiagnostic,
  hermesTranscriptIdentity,
  validateHermesRetainedTranscript,
  hermesResumeChatRoute,
  validateHermesContinuedTranscript,
  captureHermesNativeFailure,
  validateHermesDashboardReady,
  validateHermesInstalledConfiguration,
  validateHermesFailureNoticeClosure,
} from "./qualify-installed-hermes.mts";

test("Hermes evidence creation never adopts another run's directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-evidence-"));
  const output = path.join(root, "nested", "output");
  try {
    createHermesEvidenceDirectory(output);
    const retained = path.join(output, "retained.txt");
    fs.writeFileSync(retained, "other run");
    assert.throws(() => createHermesEvidenceDirectory(output), { code: "EEXIST" });
    assert.equal(fs.readFileSync(retained, "utf8"), "other run");
    const competing = path.join(root, "competing");
    const mkdir = fs.mkdirSync;
    t.mock.method(fs, "mkdirSync", (target: fs.PathLike, ...options: unknown[]) => {
      if (target === competing) mkdir(competing);
      return Reflect.apply(mkdir, fs, [target, ...options]);
    });
    assert.throws(() => createHermesEvidenceDirectory(competing), { code: "EEXIST" });
    assert(fs.statSync(competing).isDirectory());
  } finally {
    t.mock.restoreAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function dashboardReadyFixture() {
  return {
    schemaVersion: 1,
    classification: "native-hermes-dashboard-qualification",
    agent: "hermes",
    sessionId: "0123456789",
    nodeProcessId: 42,
    gatewayProcessId: 43,
    agentRuntimeRoot: "C:\\NemoClawState-S-1-5-21-1000-hermes",
  };
}

test("Hermes readiness waits only for absence and rejects invalid or oversized evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-readiness-"));
  const file = path.join(root, "ready.json");
  const ready = dashboardReadyFixture();
  const read = () => readHermesDashboardReady(file, ready.agentRuntimeRoot, 42);
  try {
    assert.equal(read(), null);
    fs.writeFileSync(file, JSON.stringify(ready));
    assert.deepEqual(read(), ready);
    for (const content of ["", "{", "null", JSON.stringify({ ...ready, nodeProcessId: 99 })]) {
      fs.writeFileSync(file, content);
      assert.throws(read);
    }
    fs.writeFileSync(file, JSON.stringify(ready) + " ".repeat(1024 * 1024));
    assert.throws(read, /exceeds its limit/u);
    assert.throws(() => readHermesDashboardReady(root, ready.agentRuntimeRoot, 42));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes readiness propagates access denial instead of treating it as not ready", (t) => {
  const denied = Object.assign(new Error("controlled access denial"), { code: "EACCES" });
  t.mock.method(fs, "openSync", () => {
    throw denied;
  });
  assert.throws(
    () => readHermesDashboardReady("denied.json", "state", 42),
    (e) => e === denied,
  );
});

test("Hermes readiness rejects a replacement before identity validation and closes its handle", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-readiness-"));
  const file = path.join(root, "ready.json");
  const replacement = path.join(root, "replacement.json");
  const ready = dashboardReadyFixture();
  const lstat = fs.lstatSync;
  const close = fs.closeSync;
  try {
    fs.writeFileSync(file, JSON.stringify(ready));
    fs.writeFileSync(replacement, JSON.stringify({ ...ready, nodeProcessId: 99 }));
    const closing = t.mock.method(fs, "closeSync", close);
    t.mock.method(fs, "lstatSync", (target: fs.PathLike) => {
      if (target === file) {
        fs.renameSync(file, path.join(root, "held.json"));
        fs.renameSync(replacement, file);
      }
      return lstat(target);
    });
    assert.throws(
      () => readHermesDashboardReady(file, ready.agentRuntimeRoot, 42),
      /changed identity/u,
    );
    assert.equal(closing.mock.callCount(), 1);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes readiness reads the held file when its path changes after validation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-readiness-"));
  const file = path.join(root, "ready.json");
  const replacement = path.join(root, "replacement.json");
  const ready = dashboardReadyFixture();
  const lstat = fs.lstatSync;
  const close = fs.closeSync;
  try {
    fs.writeFileSync(file, JSON.stringify(ready));
    fs.writeFileSync(replacement, JSON.stringify({ ...ready, nodeProcessId: 99 }));
    const closing = t.mock.method(fs, "closeSync", close);
    t.mock.method(fs, "lstatSync", (target: fs.PathLike) => {
      const info = lstat(target);
      if (target === file) {
        fs.renameSync(file, path.join(root, "held.json"));
        fs.renameSync(replacement, file);
      }
      return info;
    });
    assert.deepEqual(readHermesDashboardReady(file, ready.agentRuntimeRoot, 42), ready);
    assert.equal(closing.mock.callCount(), 1);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).nodeProcessId, 99);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function failureNoticeClosureFixture() {
  const observation = {
    rootPid: 40,
    hostPid: 42,
    sessionPid: 43,
    hostStartedUtc: "2026-10-13T01:00:00.0000000Z",
  };
  const failure = {
    sourceSha256: "a".repeat(64),
    snapshot: { agent: "hermes", nodeProcessId: 42, stage: "gateway" },
  };
  const invoked = {
    kind: "failure-notice-close-invoked",
    rootPid: 40,
    sessionPid: 43,
    hostStartedUtc: observation.hostStartedUtc,
    windowHandle: 44,
    failure: {
      snapshotSha256: failure.sourceSha256,
      hostPid: 42,
      agent: "hermes",
      stage: "gateway",
      backendCleanupFinished: true,
    },
  };
  const completed = {
    kind: "failure-notice-closed",
    rootPid: 40,
    hostPid: 42,
    sessionPid: 43,
    exitCode: 1,
    failure: true,
    elapsedMs: 500,
  };
  return { invoked, completed, failure, observation };
}

test("Hermes failed notice closure remains failure and binds the held host snapshot", () => {
  const { invoked, completed, failure, observation } = failureNoticeClosureFixture();
  const result = validateHermesFailureNoticeClosure(invoked, completed, failure, observation, 1, 1);
  assert.equal(result.failure, true);
  assert.equal(result.successfulStop, false);
  assert.equal(result.sourceSha256, failure.sourceSha256);
  assert.equal(result.guardianExitCode, 1);
  assert.equal(result.observerExitCode, 1);
});

test("Hermes failed notice closure rejects successful Stop and mismatched ownership", () => {
  const fixture = failureNoticeClosureFixture();
  const check = (value: typeof fixture, guardianCode = 1, observerCode = 1) =>
    validateHermesFailureNoticeClosure(
      value.invoked,
      value.completed,
      value.failure,
      value.observation,
      guardianCode,
      observerCode,
    );
  assert.throws(() => check(fixture, 0, 1));
  assert.throws(() => check(fixture, 1, 0));
  for (const mutate of [
    (f: typeof fixture) => {
      f.invoked.kind = "stop-invoked";
    },
    (f: typeof fixture) => {
      f.completed.kind = "closed";
    },
    (f: typeof fixture) => {
      f.completed.failure = false;
    },
    (f: typeof fixture) => {
      f.completed.exitCode = 0;
    },
    (f: typeof fixture) => {
      f.invoked.rootPid = 41;
    },
    (f: typeof fixture) => {
      f.completed.hostPid = 41;
    },
    (f: typeof fixture) => {
      f.completed.sessionPid = 41;
    },
    (f: typeof fixture) => {
      f.invoked.hostStartedUtc = "different generation";
    },
    (f: typeof fixture) => {
      f.invoked.windowHandle = 0;
    },
    (f: typeof fixture) => {
      f.invoked.failure.snapshotSha256 = "b".repeat(64);
    },
    (f: typeof fixture) => {
      f.invoked.failure.backendCleanupFinished = false;
    },
    (f: typeof fixture) => {
      f.invoked.failure.stage = "runtime";
    },
    (f: typeof fixture) => {
      f.failure.sourceSha256 = "";
    },
  ]) {
    const changed = structuredClone(fixture);
    mutate(changed);
    assert.throws(() => check(changed));
  }
});

test("Hermes live configuration retains the selected model and disabled optional fallbacks", () => {
  const model = "nvidia/selected-model";
  const config = {
    model,
    web: { keyless_fallback: false },
    agent: { disabled_toolsets: ["web"] },
    security: { allow_lazy_installs: false },
  };
  assert.equal(validateHermesInstalledConfiguration(config, model), model);
  for (const change of [
    { model: "different-model" },
    { model: { default: model } },
    { model: undefined },
    { web: { keyless_fallback: true } },
    { agent: { disabled_toolsets: [] } },
    { security: { allow_lazy_installs: true } },
  ])
    assert.throws(() => validateHermesInstalledConfiguration({ ...config, ...change }, model));
});

test("Hermes dashboard readiness belongs to its observed host and retained data", () => {
  const ready = {
    schemaVersion: 1,
    classification: "native-hermes-dashboard-qualification",
    agent: "hermes",
    sessionId: "0123456789",
    nodeProcessId: 42,
    gatewayProcessId: 43,
    agentRuntimeRoot: "C:\\NemoClawState-S-1-5-21-1000-hermes",
  };
  assert.equal(validateHermesDashboardReady(ready, ready.agentRuntimeRoot, 42), ready);
  for (const change of [
    { schemaVersion: true },
    { classification: "sidecar-ready" },
    { agent: "openclaw" },
    { sessionId: "different-session" },
    { nodeProcessId: 44 },
    { gatewayProcessId: undefined },
    { agentRuntimeRoot: "C:\\DifferentData" },
  ])
    assert.throws(() =>
      validateHermesDashboardReady({ ...ready, ...change }, ready.agentRuntimeRoot, 42),
    );
  assert.throws(() => validateHermesDashboardReady(ready, ready.agentRuntimeRoot, 0));
});

function nativeFailureSnapshot() {
  return {
    schemaVersion: 1,
    classification: "native-session-failure-evidence",
    agent: "hermes",
    interface: "dashboard",
    nodeProcessId: 42,
    backendCleanupFinished: true,
    stage: "gateway",
    diagnostics: {
      schemaVersion: 1,
      classification: "native-session-failure",
      agent: "hermes",
      stage: "gateway",
      failure: { message: "Failed with nvapi-owned-secret" },
      cleanupFailures: [],
      output: { stderr: "Authorization: Bearer private-broker-token" },
    },
  };
}

test("Hermes native failure evidence retains its owned stage and redacts credentials", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-native-failure-"));
  const file = path.join(root, "session-failure.json");
  try {
    assert.equal(captureHermesNativeFailure(file, 42, "nvapi-owned-secret"), null);
    fs.writeFileSync(file, JSON.stringify(nativeFailureSnapshot()));
    const retained = captureHermesNativeFailure(file, 42, "nvapi-owned-secret");
    assert(retained);
    assert.equal(retained.snapshot.stage, "gateway");
    assert.match(retained.sourceSha256, /^[a-f0-9]{64}$/u);
    assert(!JSON.stringify(retained).includes("nvapi-owned-secret"));
    assert(!JSON.stringify(retained).includes("private-broker-token"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes native failure evidence rejects another host, agent or unfinished backend", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-native-failure-"));
  const file = path.join(root, "session-failure.json");
  try {
    for (const change of [
      { nodeProcessId: 43 },
      { agent: "openclaw" },
      { interface: "console" },
      { backendCleanupFinished: false },
      { stage: "unexpected" },
      { diagnostics: { ...nativeFailureSnapshot().diagnostics, stage: "runtime" } },
      { diagnostics: { ...nativeFailureSnapshot().diagnostics, failure: [] } },
    ]) {
      fs.writeFileSync(file, JSON.stringify({ ...nativeFailureSnapshot(), ...change }));
      assert.throws(() => captureHermesNativeFailure(file, 42, "nvapi-owned-secret"));
    }
    fs.writeFileSync(file, JSON.stringify(nativeFailureSnapshot()));
    assert.throws(() => captureHermesNativeFailure(file, 0, "nvapi-owned-secret"));
    fs.writeFileSync(file, "{");
    assert.throws(() => captureHermesNativeFailure(file, 42, "nvapi-owned-secret"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function retainedConversation() {
  return [
    { id: 1, role: "user", content: "Remember this conversation." },
    {
      id: 2,
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call-1", function: { name: "terminal", arguments: "{}" } }],
    },
    { id: 3, role: "tool", content: "saved tool output", tool_call_id: "call-1" },
    { id: 4, role: "assistant", content: "Conversation complete." },
  ];
}

test("Hermes restart preserves saved messages and tool results despite API ordering and metadata", () => {
  const messages = retainedConversation();
  const previous = hermesTranscriptIdentity("saved-session", "personal", messages);
  const restored = messages.map((row) => ({
    ...row,
    timestamp: "later API read",
    ...(row.tool_calls ? { tool_calls: JSON.stringify(row.tool_calls) } : {}),
  }));
  assert.deepEqual(
    validateHermesRetainedTranscript(previous, {
      session_id: "saved-session",
      messages: restored.reverse(),
    }),
    previous,
  );
  assert.equal(previous.messageCount, 4);
  assert.equal(previous.lastMessageId, 4);
  assert.match(previous.transcriptSha256, /^[a-f0-9]{64}$/u);
});

test("Hermes restart rejects missing, replaced, truncated or changed saved conversations", () => {
  const messages = retainedConversation();
  const previous = hermesTranscriptIdentity("saved-session", "personal", messages);
  assert.throws(() => validateHermesRetainedTranscript(undefined, {}), /no retained/u);
  assert.throws(() => validateHermesRetainedTranscript(previous, null));
  assert.throws(() =>
    validateHermesRetainedTranscript(previous, { session_id: "different", messages }),
  );
  for (const changed of [
    messages.slice(1),
    messages.map((row) => (row.id === 1 ? { ...row, content: "Replaced prompt" } : row)),
    messages.map((row) => (row.id === 3 ? { ...row, content: "Replaced tool output" } : row)),
    messages.map((row) => (row.id === 4 ? { ...row, content: "Replaced reply" } : row)),
    [...messages, { id: 5, role: "assistant", content: "Unexpected additional turn" }],
  ])
    assert.throws(() =>
      validateHermesRetainedTranscript(previous, {
        session_id: "saved-session",
        messages: changed,
      }),
    );
});

test("Hermes retention refuses incomplete transcripts and duplicate message identities", () => {
  const messages = retainedConversation();
  for (const invalid of [
    [],
    messages.slice(0, -1),
    [...messages, messages.at(-1)],
    Array.from({ length: 500 }, (_, index) => ({
      id: index + 1,
      role: index === 0 ? "user" : "assistant",
      content: "Bounded transcript",
    })),
  ])
    assert.throws(() => hermesTranscriptIdentity("saved-session", "personal", invalid));
});

test("Hermes resume opens the saved dashboard conversation without query injection", () => {
  const previous = hermesTranscriptIdentity("saved&fresh=1", "personal", retainedConversation());
  const route = new URL(hermesResumeChatRoute(previous), "http://127.0.0.1:1234");
  assert.equal(route.pathname, "/chat");
  assert.deepEqual([...route.searchParams], [["resume", "saved&fresh=1"]]);
  assert.throws(() => hermesResumeChatRoute(undefined));
  assert.throws(() => hermesResumeChatRoute({ ...previous, storedSessionId: "" }));
});

test("Hermes continuation retains the old transcript and completes a new turn in the same chat", () => {
  const messages = retainedConversation();
  const previous = hermesTranscriptIdentity("saved-session", "personal", messages);
  const continued = [
    ...messages,
    { id: 5, role: "user", content: "Continue the saved conversation." },
    { id: 6, role: "assistant", content: "New reply in the saved conversation." },
  ];
  assert.deepEqual(
    validateHermesContinuedTranscript(
      previous,
      "saved-session",
      "personal",
      [...continued].reverse(),
    ),
    hermesTranscriptIdentity("saved-session", "personal", continued),
  );
  assert.throws(() =>
    validateHermesContinuedTranscript(undefined, "saved-session", "personal", continued),
  );
  assert.throws(() =>
    validateHermesContinuedTranscript(previous, "new-session", "personal", continued),
  );
  assert.throws(() =>
    validateHermesContinuedTranscript(previous, "saved-session", "other", continued),
  );
  for (const invalid of [
    messages,
    continued.slice(1),
    continued.slice(0, -1),
    [...messages, { id: 5, role: "assistant", content: "No new user turn." }],
    continued.map((row) => (row.id === 3 ? { ...row, content: "Changed old tool output" } : row)),
  ])
    assert.throws(() =>
      validateHermesContinuedTranscript(previous, "saved-session", "personal", invalid),
    );
});

for (const existing of ["configuration", "agent-data", "unadmitted-launcher"])
  test(`fresh Hermes rejection for ${existing} does not modify existing state or credentials`, async () => {
    const source = fs.readFileSync(
      new URL("./qualify-installed-hermes.mts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("async function main() {");
    const end = source.indexOf("\nif (process.argv[1]", start);
    assert(start > 0 && end > start);
    const body = source
      .slice(start, end)
      .replaceAll("import.meta.url", '"file:///qualification.mts"');
    const calls: string[][] = [];
    const receipts: Record<string, any> = {};
    const bindings = {
      assert,
      path: path.win32,
      process: {
        platform: "win32",
        arch: "arm64",
        version: "v22.23.2",
        argv: [],
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_RUN_ID: "123456",
          GITHUB_RUN_ATTEMPT: "2",
          NVIDIA_API_KEY: "nvapi-synthetic-fixture",
          NVIDIA_INFERENCE_API_KEY: "nvapi-other-synthetic-fixture",
          NODE_OPTIONS: "--require=untrusted.cjs",
          PYTHONPATH: "C:\\Untrusted",
          LOCALAPPDATA: "C:\\UserData",
          RUNNER_TEMP: "C:\\RunnerTemp",
          SystemRoot: "C:\\Windows",
        },
      },
      argument: (name: string, fallback?: string) =>
        ({
          "--install-root": "C:\\Installed",
          "--output": "C:\\RunnerTemp\\Evidence",
          "--runtime-identity": "identity.json",
          "--package-root": "C:\\Package",
        })[name] ?? fallback,
      fs: {
        readFileSync: () => "{}",
        existsSync: (name: string) =>
          existing === "configuration" && name === "C:\\UserData\\NVIDIA\\NemoClaw\\agents\\hermes",
        mkdirSync() {},
        writeFileSync: (name: string, value: string) => {
          receipts[name] = JSON.parse(value);
        },
      },
      stripInheritedAcceptanceEnvironment,
      admitInstalledHermesLauncher: () => {
        if (existing === "unadmitted-launcher") throw new Error("Launcher admission failed");
        return { launcherSha256: "fixture-not-executed" };
      },
      randomBytes,
      nativeCredentialBinding: () => "synthetic-binding",
      acceptanceProcessesStopped,
      captureOwned: async (_launcher: string, args: string[], environment: NodeJS.ProcessEnv) => {
        calls.push(args);
        assert.deepEqual(environment, {
          LOCALAPPDATA: "C:\\UserData",
          SystemRoot: "C:\\Windows",
        });
        assert.deepEqual(args, ["--state-session", "hermes"]);
        return {
          failure: null,
          exitCode: 0,
          stdout: JSON.stringify({
            agent: "hermes",
            leaseHeld: true,
            stateRoot: "C:\\NemoClawState-S-1-5-21-1000-hermes",
            created: false,
          }),
        };
      },
      sanitizedFailure: (error: unknown) => String(error),
    };
    const main = new Function(
      ...Object.keys(bindings),
      `${createHermesEvidenceDirectory.toString()}\n${stripTypeScriptTypes(body)}\nreturn main;`,
    )(...Object.values(bindings));
    await assert.rejects(
      main(),
      /Fresh Hermes acceptance (requires no saved configuration|cannot use pre-existing agent data)|Launcher admission failed/u,
    );
    assert.deepEqual(calls, existing === "agent-data" ? [["--state-session", "hermes"]] : []);
    const receipt = receipts["C:\\RunnerTemp\\Evidence\\installed-hermes-acceptance.json"];
    assert.equal(receipt.verdict, "fail");
    assert.equal(
      receipt.failedStage,
      existing === "unadmitted-launcher" ? "launcher-input-admission" : "configuration",
    );
    assert.equal(receipt.controllerRun, "123456:2");
    assert.deepEqual(receipt.cleanupErrors, []);
    assert.deepEqual(bindings.process.env, {
      GITHUB_ACTIONS: "true",
      LOCALAPPDATA: "C:\\UserData",
      SystemRoot: "C:\\Windows",
    });
  });

test("Hermes restart rejects a different launcher, package or controller before state acquisition", () => {
  const source = fs.readFileSync(
    new URL("./qualify-installed-hermes.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    "    if (reuse)\n      assert.deepEqual(\n        previousAcceptance?.results?.launcherAdmission,",
  );
  const end = source.indexOf("    const retainedState =", start);
  assert(start > 0 && end > start);
  assert(end < source.indexOf('const ownedState = JSON.parse(await command("private state"'));
  const check = new Function(
    "assert",
    "reuse",
    "previousAcceptance",
    "results",
    "runtimeBootstrap",
    source.slice(start, end),
  );
  const admission = {
    launcherSha256: "a".repeat(64),
    packageBuildSha256: "b".repeat(64),
    artifactSourceSnapshotSha256: "c".repeat(64),
    controllerSourceRevision: "d".repeat(40),
  };
  const results = { launcherAdmission: admission, runtimeBootstrap: false };
  check(assert, true, { results: structuredClone(results) }, results, false);
  check(assert, false, undefined, results, false);
  assert.throws(
    () => check(assert, true, { results }, results, true),
    /cannot change qualification phase/u,
  );
  check(assert, true, { results: { ...results, runtimeBootstrap: true } }, results, true);
  assert.throws(() => check(assert, true, undefined, results));
  for (const name of Object.keys(admission)) {
    const previous = { results: structuredClone(results) };
    previous.results.launcherAdmission[name] = "changed";
    assert.throws(() => check(assert, true, previous, results), /different package or controller/u);
  }
});

test("Hermes dashboard browser receives only the filtered application environment", async () => {
  const source = fs.readFileSync(
    new URL("./qualify-installed-hermes.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    '    const driver = path.resolve(argument("--browser-driver-root"));',
  );
  const end = source.indexOf("    const page = await browser.newPage();", start);
  assert(start > 0 && end > start);
  const environment = { SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\UserData" };
  let launches = 0;
  const bindings = {
    assert,
    path: path.win32,
    argument: () => "C:\\Driver",
    process: { env: { ProgramFiles: "C:\\Programs", NVIDIA_API_KEY: "nvapi-not-for-browser" } },
    fs: { existsSync: () => true },
    environment,
    performance: { now: () => 1000 },
    started: 0,
    createRequire: () => () => ({
      chromium: {
        launch: async (options: Record<string, unknown>) => {
          launches++;
          assert.deepEqual(options, {
            executablePath: "C:\\Programs\\Microsoft\\Edge\\Application\\msedge.exe",
            env: environment,
            headless: true,
            timeout: 30_000,
          });
          return {};
        },
      },
    }),
  };
  await new Function(
    ...Object.keys(bindings),
    `return (async () => { let browser; ${stripTypeScriptTypes(source.slice(start, end))} })();`,
  )(...Object.values(bindings));
  assert.equal(launches, 1);
});

for (const name of ["NVIDIA_API_KEY", "NVIDIA_INFERENCE_API_KEY"])
  test(`Hermes entry point redacts ${name} after inherited environment removal`, async () => {
    const source = fs.readFileSync(
      new URL("./qualify-installed-hermes.mts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("\nif (process.argv[1]");
    assert(start > 0);
    const secret = "nvapi-synthetic-private-value";
    const fakeProcess = {
      argv: ["node", "/qualification.mts"],
      env: { [name]: secret },
      exitCode: 0,
    };
    const messages: string[] = [];
    const bindings = {
      process: fakeProcess,
      path: path.posix,
      fileURLToPath: () => "/qualification.mts",
      sanitizedFailure,
      console: { error: (message: unknown) => messages.push(JSON.stringify(message)) },
      main: async () => {
        stripInheritedAcceptanceEnvironment(fakeProcess.env);
        throw new Error(`Controller failed with ${secret}`);
      },
    };
    new Function(
      ...Object.keys(bindings),
      source.slice(start).replaceAll("import.meta.url", '"file:///qualification.mts"'),
    )(...Object.values(bindings));
    await Promise.resolve();
    assert.deepEqual(fakeProcess.env, {});
    assert.equal(fakeProcess.exitCode, 1);
    assert.equal(messages.length, 1);
    assert(!messages[0].includes(secret));
    assert.match(messages[0], /Controller failed/u);
  });

test("Hermes runtime bootstrap saves only a fresh transaction and retains failed mutation custody", async () => {
  const source = fs.readFileSync(
    new URL("./qualify-installed-hermes.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("    if (!reuse && runtimeBootstrap) {");
  const end = source.indexOf("    if (!reuse && !runtimeBootstrap) {", start);
  assert(start > 0 && end > start);
  const block = stripTypeScriptTypes(source.slice(start, end));
  for (const scenario of ["success", "failure", "reuse", "final"]) {
    const calls: unknown[][] = [];
    const configuration = { agent: "hermes" };
    const bindings = {
      reuse: scenario === "reuse",
      runtimeBootstrap: scenario !== "final",
      configuration,
      secret: "synthetic-secret",
      command: async (...args: unknown[]) => {
        calls.push(args);
        if (scenario === "failure") throw new Error("transaction failed");
      },
    };
    const observed = await new Function(
      ...Object.keys(bindings),
      `return (async () => {
      let configurationMutationUnconfirmed = false;
      try { ${block} return { pending: configurationMutationUnconfirmed, failed: false }; }
      catch { return { pending: configurationMutationUnconfirmed, failed: true }; }
    })();`,
    )(...Object.values(bindings));
    assert.deepEqual(
      observed,
      { pending: scenario === "failure", failed: scenario === "failure" },
      scenario,
    );
    assert.deepEqual(
      calls,
      ["reuse", "final"].includes(scenario)
        ? []
        : [
            [
              "save-config-transaction",
              ["--configure-native", "--agent", "hermes", "--transaction"],
              JSON.stringify({
                configuration,
                credentials: { inference: "synthetic-secret", services: {} },
              }),
            ],
          ],
      scenario,
    );
  }
});

test("Hermes onboarding retains mutation custody until its complete success receipt is validated", async () => {
  const source = fs.readFileSync(
    new URL("./qualify-installed-hermes.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("    if (!reuse && !runtimeBootstrap) {\n      const onboardPath =");
  const end = source.indexOf("    const configurationText =", start);
  assert(start > 0 && end > start);
  const block = stripTypeScriptTypes(
    source.slice(start, end).replaceAll("import.meta.url", '"file:///qualification.mts"'),
  );
  for (const scenario of [
    "capture-failed",
    "nonzero-exit",
    "invalid-json",
    "save-failed",
    "cleanup-unconfirmed",
    "drafts-missing",
    "confirmed",
    "reuse",
    "runtime-bootstrap",
  ]) {
    let calls = 0;
    const results: Record<string, any> = {};
    const bindings = {
      assert,
      path: path.win32,
      URL,
      fileURLToPath: () => "C:\\Controller\\control-installed-hermes-onboarding.ps1",
      process: { env: { ProgramFiles: "C:\\Program Files" } },
      output: "C:\\Evidence",
      install: "C:\\Installed",
      model: "test-model",
      observerEnvironment: { SystemRoot: "C:\\Windows", GITHUB_ACTIONS: "true" },
      secret: "nvapi-synthetic-fixture",
      results,
      reuse: scenario === "reuse",
      runtimeBootstrap: scenario === "runtime-bootstrap",
      captureOwned: async (
        _launcher: string,
        _args: string[],
        environment: NodeJS.ProcessEnv,
        stdin: string,
        timeout: number,
      ) => {
        calls++;
        assert.deepEqual(environment, {
          SystemRoot: "C:\\Windows",
          GITHUB_ACTIONS: "true",
          NVIDIA_API_KEY: "nvapi-synthetic-fixture",
        });
        assert.equal(stdin, "");
        assert.equal(timeout, 180_000);
        if (scenario === "capture-failed") throw new Error("fixture timeout");
        return { failure: null, exitCode: scenario === "nonzero-exit" ? 1 : 0 };
      },
      fs: {
        readFileSync: () =>
          scenario === "invalid-json"
            ? "{"
            : JSON.stringify({
                passed: scenario !== "save-failed",
                successfulConfigurationSaves: 1,
                rejectedEmptyIntegrationSave: true,
                cleanupClosed: scenario !== "cleanup-unconfirmed",
                providerDrafts:
                  scenario === "drafts-missing"
                    ? []
                    : ["nvidia", "openrouter", "compatible", "local"].map((provider) => ({
                        provider,
                        endpointRetained: true,
                        modelRetained: true,
                        fixedEndpoint: ["nvidia", "openrouter"].includes(provider),
                        saved: false,
                        providerReplyQualified: false,
                      })),
              }),
      },
    };
    const observed = await new Function(
      ...Object.keys(bindings),
      `return (async () => {
      let configurationMutationUnconfirmed = false;
      try { ${block} return { pending: configurationMutationUnconfirmed, failed: false }; }
      catch { return { pending: configurationMutationUnconfirmed, failed: true }; }
    })();`,
    )(...Object.values(bindings));
    const failed = !["confirmed", "reuse", "runtime-bootstrap"].includes(scenario);
    assert.deepEqual(observed, { pending: failed, failed }, scenario);
    assert.equal(calls, ["reuse", "runtime-bootstrap"].includes(scenario) ? 0 : 1, scenario);
  }
});

test("Hermes cleanup retains data until configuration, native cleanup and process closure are confirmed", async () => {
  const source = fs.readFileSync(
    new URL("./qualify-installed-hermes.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("    const processesStopped = acceptanceProcessesStopped(");
  const end = source.indexOf("\n  }\n  if (cleanupErrors.length)", start);
  assert(start > 0 && end > start);
  const block = stripTypeScriptTypes(source.slice(start, end));
  const finished = { exitCode: 0, signalCode: null };
  const cases = [
    {
      name: "onboarding completion unconfirmed before native launch",
      launched: false,
      cleaned: false,
      closed: true,
      owned: true,
      preserve: false,
      mutationUnconfirmed: true,
      remove: false,
      safe: false,
    },
    {
      name: "unconfirmed save cannot be cleared by a backend cleanup receipt",
      launched: true,
      cleaned: true,
      closed: true,
      owned: true,
      preserve: true,
      mutationUnconfirmed: true,
      remove: false,
      safe: false,
    },
    {
      name: "closed UI without backend evidence",
      launched: true,
      cleaned: false,
      closed: true,
      owned: true,
      preserve: false,
      remove: false,
      safe: false,
    },
    {
      name: "failed launch without backend evidence",
      launched: true,
      cleaned: false,
      closed: true,
      owned: true,
      preserve: true,
      remove: false,
      safe: false,
    },
    {
      name: "live process after backend report",
      launched: true,
      cleaned: true,
      closed: false,
      owned: true,
      preserve: false,
      remove: false,
      safe: false,
    },
    {
      name: "confirmed native Stop",
      launched: true,
      cleaned: true,
      closed: true,
      owned: true,
      preserve: false,
      remove: true,
      safe: true,
    },
    {
      name: "preserved successful cold run",
      launched: true,
      cleaned: true,
      closed: true,
      owned: true,
      preserve: true,
      remove: false,
      safe: true,
    },
    {
      name: "owned configuration before launch",
      launched: false,
      cleaned: false,
      closed: true,
      owned: true,
      preserve: false,
      remove: true,
      safe: true,
    },
    {
      name: "unowned existing configuration",
      launched: false,
      cleaned: false,
      closed: true,
      owned: false,
      preserve: false,
      remove: false,
      safe: true,
    },
  ];
  for (const row of cases) {
    const calls: string[][] = [];
    const results: Record<string, any> = {};
    const cleanupErrors: string[] = [];
    const bindings = {
      acceptanceProcessesStopped,
      guardian: row.closed ? finished : { exitCode: null, signalCode: null },
      observer: finished,
      nativeLaunchAttempted: row.launched,
      nativeCleanupConfirmed: row.cleaned,
      configurationOwned: row.owned,
      configurationMutationUnconfirmed: row.mutationUnconfirmed ?? false,
      preserve: row.preserve,
      primary: undefined,
      binding: "test-binding",
      results,
      cleanupErrors,
      command: async (_name: string, args: string[]) => {
        calls.push(args);
      },
    };
    await new Function(...Object.keys(bindings), `return (async () => {${block}\n})();`)(
      ...Object.values(bindings),
    );
    assert.deepEqual(
      calls,
      row.remove
        ? [
            ["--remove-native-data", "--agent", "hermes"],
            ["--credential-delete", "nvidia", "--binding", "test-binding"],
          ]
        : [],
      row.name,
    );
    assert.equal(results.custody.uninstallSafe, row.safe, row.name);
    assert.equal(
      results.custody.configurationMutationUnconfirmed,
      row.mutationUnconfirmed ?? false,
      row.name,
    );
    assert.equal(
      results.custody.configurationRetainedForRecovery,
      row.owned && !row.safe,
      row.name,
    );
    assert.equal(cleanupErrors.length, row.safe ? 0 : 1, row.name);
  }
});

test("Hermes Edge acceptance requires the exact browser_exec code and successful sentinel", () => {
  const code = "print('EDGE_SENTINEL')";
  const messages = [
    {
      role: "assistant",
      tool_calls: [
        { id: "browser", function: { name: "browser_exec", arguments: JSON.stringify({ code }) } },
      ],
    },
    {
      role: "tool",
      tool_call_id: "browser",
      content: JSON.stringify({ success: true, exit_code: 0, output: "EDGE_SENTINEL\n" }),
    },
  ];
  assert(recordedHermesBrowser(messages, code, "EDGE_SENTINEL"));
  assert.equal(recordedHermesBrowser(messages, "different", "EDGE_SENTINEL"), null);
  assert.equal(
    recordedHermesBrowser(
      [messages[0], { ...messages[1], content: JSON.stringify({ success: false, exit_code: 1 }) }],
      code,
      "EDGE_SENTINEL",
    ),
    null,
  );
});

test("Hermes Edge receipt is bound to the exact native session", () => {
  const receipt = {
    schemaVersion: 1,
    classification: "native-hermes-edge-browser",
    agent: "hermes",
    sessionId: "session-1",
    identity: {
      architecture: "arm64",
      machine: 0xaa64,
      signatureStatus: "Valid",
      signerSubject: "Microsoft Corporation",
      provenance: "standard-windows-microsoft-edge-installation",
      path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      sha256: "a".repeat(64),
    },
    process: { pid: 42, creationTimeFileTime: "134000000000000000" },
    endpoint: { host: "127.0.0.1", port: 49152, path: "/devtools/browser/id-1" },
    authenticatedRelay: true,
    generalHostProxy: false,
    inheritedKillOnCloseJob: true,
  };
  assert.equal(validateHermesEdgeReceipt(receipt, "session-1"), receipt);
  assert.throws(() => validateHermesEdgeReceipt(receipt, "session-2"));
  assert.throws(() =>
    validateHermesEdgeReceipt({ ...receipt, generalHostProxy: true }, "session-1"),
  );
});

test("Hermes acceptance requires an exact model tool call and matching successful tool result", () => {
  const command = "printf fixture";
  const messages = [
    {
      role: "assistant",
      content: "fixture",
      tool_calls: [
        { id: "owned", function: { name: "terminal", arguments: JSON.stringify({ command }) } },
      ],
    },
    {
      role: "tool",
      tool_call_id: "owned",
      content: JSON.stringify({ output: "fixture", exit_code: 0, error: null }),
    },
  ];
  assert(recordedHermesTerminal(messages, command, "fixture"));
  for (const changed of [
    [{ role: "assistant", content: "fixture" }],
    [messages[0], { ...messages[1], tool_call_id: "other" }],
    [
      messages[0],
      { ...messages[1], content: JSON.stringify({ output: "fixture", exit_code: 1, error: null }) },
    ],
    [
      messages[0],
      {
        ...messages[1],
        content: JSON.stringify({ output: "fixture", exit_code: 0, error: "failed" }),
      },
    ],
  ])
    assert.equal(recordedHermesTerminal(changed, command, "fixture"), null);
  assert.equal(recordedHermesTerminal(messages, "different command", "fixture"), null);
});

test(
  "the actual tool command performs its file, ripgrep and Python temporary roundtrip",
  { skip: process.platform === "win32" },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-tool-command-"));
    try {
      fs.symlinkSync(
        process.env.NEMOCLAW_TEST_PYTHON ?? "/opt/homebrew/bin/python3",
        path.join(root, "python"),
      );
      if (process.env.NEMOCLAW_TEST_RG)
        fs.symlinkSync(process.env.NEMOCLAW_TEST_RG, path.join(root, "rg"));
      const nonce = "a".repeat(20);
      const result = spawnSync("/bin/bash", ["-c", hermesInstalledToolCommand(nonce)], {
        cwd: root,
        env: { ...process.env, PATH: root + path.delimiter + process.env.PATH },
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim().split("\n").length, 3);
      assert(result.stdout.includes("NEMOCLAW_TOOLS_" + nonce));
      assert(!fs.existsSync(path.join(root, "nemoclaw-" + nonce + ".txt")));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("actual PTY readiness excludes sidecar, lazy agent and tool completion before settled turn", () => {
  const state = createHermesPtyState();
  const info = (seq: number, payload: object = {}) => ({
    method: "event",
    params: {
      type: "session.info",
      session_id: "real-runtime",
      seq,
      payload: {
        version: "0.21.1",
        lazy: false,
        running: false,
        stored_session_id: "saved-real",
        profile_name: "profile-real",
        ...payload,
      },
    },
  });
  state.bindEvents("actual-pty");
  state.bindPty("actual-pty");
  state.ptyData();
  // entry.py publishes this global before attaching the real session.
  state.receive("actual-pty", { method: "event", params: { type: "gateway.ready" } });
  // server._event_frame preserves an explicit empty session id for other
  // intentionally unsequenced global events.
  state.receive("actual-pty", {
    method: "event",
    params: { type: "sessions.changed", session_id: "", payload: {} },
  });
  state.assertHealthy();
  assert.equal(state.usable(), false);
  state.receive("sidecar", info(1));
  assert.equal(state.usable(), false);
  state.receive("actual-pty", info(1, { lazy: true }));
  assert.equal(state.usable(), false);
  state.receive("actual-pty", info(2, { running: true }));
  assert.equal(state.usable(), false);
  state.receive("actual-pty", info(3));
  assert.equal(state.usable(), true);
  assert.equal(state.storedSessionId(), "saved-real");
  assert.equal(state.profileName(), "profile-real");
  const mark = state.markTurn();
  const event = (type: string, seq: number) => ({
    method: "event",
    // prompt_turn.py emits message.start without payload; server omits None.
    params: { type, session_id: "real-runtime", seq },
  });
  state.receive("actual-pty", event("message.start", 4));
  state.receive("actual-pty", event("tool.complete", 5));
  state.receive("actual-pty", info(6));
  assert.equal(state.settledAfter(mark), false);
  state.receive("actual-pty", event("message.complete", 7));
  assert.equal(state.settledAfter(mark), false);
  state.receive("actual-pty", info(8));
  assert.equal(state.settledAfter(mark), true);
  state.beginIdle(mark);
  state.receive("actual-pty", event("message.start", 9));
  assert.throws(() => state.assertHealthy(), /idle sample/u);
});

test("live Hermes transcript polls cannot reuse a completed-turn URL", () => {
  assert.equal(
    hermesTranscriptRoute("saved-real", "profile real", 1),
    "/api/sessions/saved-real/messages?limit=500&order=latest&profile=profile%20real&poll=1",
  );
  assert.notEqual(
    hermesTranscriptRoute("saved-real", "profile real", 1),
    hermesTranscriptRoute("saved-real", "profile real", 2),
  );
  assert.throws(() => hermesTranscriptRoute("saved-real", "profile-real", 0), /poll identity/u);
});

test("multiline Hermes prompts preserve exact bytes without an asynchronous paste chunk", () => {
  const prompt = "First line\n```sh\nprintf fixture\n```\n\nLast line";
  const lines = hermesPromptLines(prompt);
  assert.deepEqual(lines, ["First line", "```sh", "printf fixture", "```", "", "Last line"]);
  assert.equal(lines.join("\n"), prompt);
  assert(lines.every((line) => !line.includes("\n")));
  assert.deepEqual(hermesPromptFrames(prompt), [
    "First line",
    "\u001b[13;2u",
    "```sh",
    "\u001b[13;2u",
    "printf fixture",
    "\u001b[13;2u",
    "```",
    "\u001b[13;2u",
    "\u001b[13;2u",
    "Last line",
    "\r",
  ]);
  assert.throws(() => hermesPromptLines("windows\r\nlines"), /canonical newlines/u);
});

function dashboardPromptSender(bindings: Record<string, unknown>): typeof sendHermesPromptFrames {
  // Exercise the actual serialized browser callback without host-module globals.
  return runInNewContext(
    `(${sendHermesPromptFrames.toString()})`,
    { URL, ...bindings },
    { timeout: 1000 },
  );
}

test("Hermes prompt submission selects only the open PTY for its exact origin and channel", async () => {
  const rejected = [
    ["ws://127.0.0.1:49153/api/pty?channel=actual", 1],
    ["ws://127.0.0.1:49152/api/events?channel=actual", 1],
    ["ws://127.0.0.1:49152/api/pty?channel=sidecar", 1],
    ["ws://127.0.0.1:49152/api/pty", 1],
    ["ws://127.0.0.1:49152/api/pty?channel=actual", 0],
    ["ws://127.0.0.1:49152/api/pty?channel=actual", 2],
    ["ws://127.0.0.1:49152/api/pty?channel=actual", 3],
    ["invalid URL", 1],
  ].map(([url, readyState]) => ({
    url,
    socket: { readyState, send: () => assert.fail("Unrelated socket received prompt input") },
  }));
  const sent: string[] = [];
  const selected = {
    url: "ws://127.0.0.1:49152/api/pty?channel=actual",
    socket: { readyState: 1, send: (frame: string) => sent.push(frame) },
  };
  const sockets = new Map([...rejected, selected].map((entry, index) => [index, entry]));
  const submit = dashboardPromptSender({ __nemoclawSocketObservation: { sockets } });
  const input = { channel: "actual", frames: ["\r"], origin: "http://127.0.0.1:49152" };
  assert.equal((await submit(input)).matches, 1);
  assert.deepEqual(sent, ["\r"]);
  sockets.delete(rejected.length);
  assert.equal((await submit(input)).matches, 0);
  assert.deepEqual(sent, ["\r"]);
});

test("Hermes prompt submission sends nothing when PTY ownership is absent or ambiguous", async () => {
  const entry = {
    url: "ws://127.0.0.1:49152/api/pty?channel=actual",
    socket: { readyState: 1, send: () => assert.fail("Ambiguous PTY received prompt input") },
  };
  for (const [observation, matches] of [
    [undefined, 0],
    [{ sockets: new Map() }, 0],
    [
      {
        sockets: new Map([
          [1, entry],
          [2, { ...entry }],
        ]),
      },
      2,
    ],
  ] as const) {
    const submit = dashboardPromptSender({ __nemoclawSocketObservation: observation });
    assert.equal(
      (
        await submit({
          channel: "actual",
          frames: ["text", "\r"],
          origin: "http://127.0.0.1:49152",
        })
      ).matches,
      matches,
    );
  }
});

test("Hermes PTY input waits 50ms between frames and submits only after the final prompt frame", async () => {
  const sent: string[] = [];
  const timers: { delay: number; release: () => void }[] = [];
  const submit = dashboardPromptSender({
    __nemoclawSocketObservation: {
      sockets: new Map([
        [
          1,
          {
            url: "ws://127.0.0.1:49152/api/pty?channel=actual",
            socket: { readyState: 1, send: (frame: string) => sent.push(frame) },
          },
        ],
      ]),
    },
    setTimeout: (release: () => void, delay: number) => timers.push({ delay, release }),
  });
  const frames = hermesPromptFrames("first\n\nlast");
  let settled = false;
  const pending = Promise.resolve(
    submit({ channel: "actual", frames, origin: "http://127.0.0.1:49152" }),
  ).then((result) => {
    settled = true;
    return result;
  });
  assert.deepEqual(sent, ["first"]);
  for (let index = 1; index < frames.length; index++) {
    assert.equal(settled, false);
    assert.equal(timers.length, 1);
    const timer = timers.shift();
    assert(timer);
    assert.equal(timer.delay, 50);
    timer.release();
    await Promise.resolve();
    assert.deepEqual(sent, frames.slice(0, index + 1));
  }
  assert.equal((await pending).matches, 1);
  assert.equal(settled, true);
  assert.equal(timers.length, 0);
  assert.equal(sent.at(-1), "\r");
});

test("Hermes PTY send failure propagates without sending later frames or reporting success", async () => {
  const sent: string[] = [];
  const failure = new Error("controlled socket closure");
  const submit = dashboardPromptSender({
    __nemoclawSocketObservation: {
      sockets: new Map([
        [
          1,
          {
            url: "ws://127.0.0.1:49152/api/pty?channel=actual",
            socket: {
              readyState: 1,
              send(frame: string) {
                sent.push(frame);
                if (sent.length === 2) throw failure;
              },
            },
          },
        ],
      ]),
    },
    setTimeout: (release: () => void) => release(),
  });
  await assert.rejects(
    Promise.resolve(
      submit({
        channel: "actual",
        frames: ["first", "second", "\r"],
        origin: "http://127.0.0.1:49152",
      }),
    ),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(sent, ["first", "second"]);
});

test("Hermes browser diagnostics redact WebSocket credentials", () => {
  assert.equal(
    sanitizeHermesBrowserDiagnostic(
      "WebSocket ws://127.0.0.1/api/pty?channel=visible&token=secret-token failed",
      ["separate-secret"],
    ),
    "WebSocket ws://127.0.0.1/api/pty?channel=visible&token=<redacted> failed",
  );
  assert.equal(
    sanitizeHermesBrowserDiagnostic(
      "ticket URL ?ticket=one-use-value and X-Hermes-Session-Token: separate-secret",
      ["separate-secret"],
    ),
    "ticket URL ?ticket=<redacted> and X-Hermes-Session-Token: <redacted>",
  );
});

test("Hermes browser diagnostic bounds cannot expose a truncated credential", () => {
  const prefix = "x".repeat(4090);
  const secret = "private-credential-value";
  const diagnostic = sanitizeHermesBrowserDiagnostic(prefix + secret, [secret]);
  assert.equal(diagnostic, (prefix + "<redacted>").slice(0, 4096));
  assert(!diagnostic.includes("privat"));
});

test("in-page Hermes socket observations preserve real PTY lifecycle evidence", () => {
  const state = createHermesPtyState();
  const channel = "actual-pty";
  const ptyUrl = `ws://127.0.0.1:49152/api/pty?channel=${channel}`;
  const eventsUrl = `ws://127.0.0.1:49152/api/events?channel=${channel}`;
  const event = (type: string, seq: number, payload?: object) =>
    JSON.stringify({
      method: "event",
      params: {
        type,
        session_id: "runtime-real",
        seq,
        ...(payload === undefined ? {} : { payload }),
      },
    });
  applyHermesSocketObservations(state, "http://127.0.0.1:49152", {
    overflow: false,
    records: [
      { kind: "open", url: ptyUrl },
      { kind: "open", url: eventsUrl },
      { kind: "message", url: ptyUrl },
      {
        kind: "message",
        url: eventsUrl,
        text: event("session.info", 1, {
          version: "0.21.1",
          lazy: false,
          running: false,
          stored_session_id: "saved-real",
          profile_name: "profile-real",
        }),
      },
    ],
  });
  state.assertHealthy();
  assert.equal(state.usable(), true);
  const mark = state.markTurn();
  applyHermesSocketObservations(state, "http://127.0.0.1:49152", {
    overflow: false,
    records: [
      { kind: "message", url: eventsUrl, text: event("message.start", 2) },
      {
        kind: "message",
        url: eventsUrl,
        text: event("message.complete", 3, { status: "complete", text: "done" }),
      },
      {
        kind: "message",
        url: eventsUrl,
        text: event("session.info", 4, {
          version: "0.21.1",
          lazy: false,
          running: false,
          stored_session_id: "saved-real",
          profile_name: "profile-real",
        }),
      },
    ],
  });
  assert.equal(state.settledAfter(mark), true);
  assert.throws(
    () =>
      applyHermesSocketObservations(state, "http://127.0.0.1:49152", {
        overflow: true,
        records: [],
      }),
    /exceeded its bound/u,
  );
});

test("closing one same-channel PTY connection preserves the remaining live connection", () => {
  const state = createHermesPtyState();
  state.bindEvents("actual-pty");
  state.bindPty("actual-pty");
  state.bindPty("actual-pty");
  state.ptyData();
  state.receive("actual-pty", {
    method: "event",
    params: {
      type: "session.info",
      session_id: "real-runtime",
      seq: 1,
      payload: {
        version: "0.21.1",
        lazy: false,
        running: false,
        stored_session_id: "saved-real",
        profile_name: "profile-real",
      },
    },
  });
  state.ptyClosed("actual-pty");
  state.assertHealthy();
  state.ptyClosed("actual-pty");
  assert.throws(() => state.assertHealthy(), /PTY socket closed/u);
});

test("pre-session PTY reconnect still requires replacement live feeds", () => {
  const state = createHermesPtyState();
  state.bindEvents("actual-pty");
  state.bindPty("actual-pty");
  state.eventsClosed("actual-pty");
  state.ptyClosed("actual-pty");
  assert.deepEqual(state.snapshot().connections, [
    { endpoint: "events", action: "open", channel: "actual-pty" },
    { endpoint: "pty", action: "open", channel: "actual-pty" },
    { endpoint: "events", action: "close", channel: "actual-pty" },
    { endpoint: "pty", action: "close", channel: "actual-pty" },
  ]);
  assert.equal(state.snapshot().eventFeedOpen, false);
  assert.equal(state.snapshot().ptyFeedOpen, false);
  assert.throws(() => state.assertHealthy(), /not live/u);
  state.bindEvents("actual-pty");
  state.bindPty("actual-pty");
  state.ptyData();
  state.receive("actual-pty", {
    method: "event",
    params: {
      type: "session.info",
      session_id: "real-runtime",
      seq: 1,
      payload: {
        version: "0.21.1",
        lazy: false,
        running: false,
        stored_session_id: "saved-real",
        profile_name: "profile-real",
      },
    },
  });
  state.assertHealthy();
  assert.equal(state.usable(), true);
});

test("settled conversation still needs a final saved assistant and a real execute_code kernel bootstrap", () => {
  const code = hermesInstalledCodeCommand("b".repeat(20));
  const sentinel = "NEMOCLAW_EXECUTE_CODE_" + "b".repeat(20);
  const prompt = "controlled prompt";
  const messages: any[] = [
    { role: "user", content: prompt },
    {
      role: "assistant",
      tool_calls: [
        {
          id: "code-call",
          function: { name: "execute_code", arguments: JSON.stringify({ code }) },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "code-call",
      content: JSON.stringify({
        status: "success",
        exit_code: 0,
        output: sentinel,
        tool_calls_made: 1,
        kernel: { mode: "session", execution_count: 1 },
      }),
    },
  ];
  assert(recordedHermesCode(messages, code, sentinel));
  assert.equal(finalHermesTurn(messages), false);
  assert.equal(finalHermesAssistant(messages, prompt), false);
  messages.push({ role: "assistant", content: "Both operations completed." });
  assert.equal(finalHermesTurn(messages), true);
  assert.equal(finalHermesAssistant(messages, prompt), true);
  const normalizedPaste = structuredClone(messages);
  normalizedPaste[0].content = "normalized paste wrapper\n" + code + "\nend wrapper";
  assert.equal(hermesTurnIndex(normalizedPaste, prompt, [code]), 0);
  assert.equal(finalHermesAssistant(normalizedPaste, prompt, [code]), true);
  assert.equal(finalHermesAssistant(normalizedPaste, prompt, ["different exact code"]), false);
  assert.deepEqual(
    hermesMessagesAfter(
      [
        { id: 4, role: "assistant" },
        { id: 1, role: "user" },
        { id: 3, role: "tool" },
      ],
      1,
    ).map((row) => row.id),
    [3, 4],
  );
  assert.throws(() => hermesMessagesAfter([{ id: 0 }], 0), /no identity/u);
  const failed = structuredClone(messages);
  failed[2].content = JSON.stringify({
    status: "success",
    exit_code: 0,
    output: sentinel,
    tool_calls_made: 0,
  });
  assert.equal(recordedHermesCode(failed, code, sentinel), null);
  const state = createHermesPtyState();
  state.bindEvents("actual");
  state.bindPty("actual");
  state.ptyData();
  state.receive("actual", {
    method: "event",
    params: {
      type: "message.error",
      session_id: "real",
      seq: 1,
      payload: { error: "controlled failure" },
    },
  });
  assert.throws(() => state.assertHealthy(), /reported an error/u);
});

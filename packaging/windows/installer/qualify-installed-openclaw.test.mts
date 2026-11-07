// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { reviewOpenClawAvailability } from "./review-openclaw-availability.mts";
import {
  captureLauncherArtifactSources,
  validateLauncherArtifactSourceSnapshot,
  validateInstalledLauncherInputs,
} from "./installed-launcher-admission.mts";
import { admitInstalledHermesLauncher } from "./qualify-installed-hermes.mts";
import {
  captureFailure,
  terminalAgentError,
  decodeDiagnosticOwnerRead,
  retainNativeSessionDiagnostics,
  childEnvironment,
  exactChatAddress,
  recordedExec,
  recordedFileTool,
  requestVisibleGateway,
  sanitizedFailure,
  toolIds,
  verifyToolOutput,
  visibleChatReady,
  openClawRestartMode,
  openClawTranscriptIdentity,
  assertRecordedOpenClawReply,
  assertRetainedOpenClawPrefix,
  validateOpenClawColdReceipt,
  validateOpenClawWarmReceipt,
  validateOpenClawInspectionInputs,
  captureOpenClawArtifactSources,
  validateOpenClawArtifactSourceSnapshot,
  openClawCleanupDisposition,
  inspectRetainedOpenClawState,
  saveFreshOpenClawConfiguration,
  stripInheritedAcceptanceEnvironment,
  completeOpenClawRestartState,
  openClawConfigurationAbsent,
} from "./qualify-installed-openclaw.mts";

test("OpenClaw restart flags preserve fresh defaults and reject ambiguous handoffs", () => {
  assert.deepEqual(openClawRestartMode([]), { preserve: false, reuse: false, restart: false });
  assert.deepEqual(openClawRestartMode(["--preserve-configuration"]), {
    preserve: true,
    reuse: false,
    restart: true,
  });
  assert.deepEqual(
    openClawRestartMode(["--reuse-configuration", "--previous-acceptance", "cold.json"]),
    { preserve: false, reuse: true, restart: true },
  );
  for (const args of [
    ["--reuse-configuration"],
    ["--previous-acceptance", "old.json"],
    ["--preserve-configuration", "--reuse-configuration", "--previous-acceptance", "cold.json"],
  ])
    assert.throws(() => openClawRestartMode(args));
});

test("OpenClaw transcript identity proves semantic retention and a new provider response", () => {
  const sessionKey = "agent:main:main";
  const history = {
    messages: [
      { role: "user", content: [{ type: "text", text: "prompt" }], timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "reply" }],
        stopReason: "stop",
        timestamp: 2,
      },
    ],
  };
  const cold = openClawTranscriptIdentity(sessionKey, history);
  const metadataChange = structuredClone(history);
  metadataChange.messages[0].timestamp = 20;
  assert.deepEqual(openClawTranscriptIdentity(sessionKey, metadataChange), cold);
  assertRecordedOpenClawReply(history, "prompt", "reply");
  const warm = {
    messages: [
      ...history.messages,
      { role: "user", content: "new prompt" },
      { role: "assistant", content: "new reply" },
    ],
  };
  assertRetainedOpenClawPrefix(cold, warm);
  assertRecordedOpenClawReply(warm, "new prompt", "new reply");
  for (const candidate of [
    { messages: history.messages },
    { messages: warm.messages.slice(1) },
    { messages: [{ role: "user", content: "replacement" }, ...warm.messages.slice(1)] },
  ])
    assert.throws(() => assertRetainedOpenClawPrefix(cold, candidate));
  for (const candidate of [
    { messages: [{ role: "user", content: "reply" }] },
    { messages: [{ role: "assistant", content: "reply" }] },
    {
      messages: [
        { role: "user", content: "prompt" },
        { role: "assistant", content: "reply", stopReason: "error" },
      ],
    },
    { messages: [...history.messages, { role: "user", content: "new prompt" }] },
  ])
    assert.throws(() => assertRecordedOpenClawReply(candidate, "new prompt", "reply"));
  for (const candidate of [
    { messages: [] },
    { messages: Array(100).fill(history.messages[0]) },
    { messages: [{ role: "user", content: "x".repeat(20001) }] },
    { messages: [{ role: "system", content: "unrecognized" }] },
  ])
    assert.throws(() => openClawTranscriptIdentity(sessionKey, candidate));
  assert.throws(() => openClawTranscriptIdentity("agent:other:main", history));
});

function coldOpenClawFixture() {
  const expected = {
    controllerRun: "123:1",
    handoff: "a".repeat(64),
    installation: "C:\\Program Files\\NVIDIA\\NemoClaw",
    runtime: {
      runtimeId: "b".repeat(64),
      manifestSha256: "c".repeat(64),
      sourceRevision: "d".repeat(40),
      nodeSha256: "e".repeat(64),
      nodeVersion: "22.23.2",
    },
    launcherSha256: "f".repeat(64),
    packageBuildSha256: "1".repeat(64),
    artifactSourceSnapshotSha256: "7".repeat(64),
    controllerSourceRevision: "8".repeat(40),
    model: "nvidia/test-model",
  };
  const receipt = {
    schemaVersion: 2,
    classification: "installed-compiled-openclaw-acceptance",
    verdict: "pass",
    runtime: expected.runtime,
    cleanupErrors: [],
    cleanupErrorDetails: [],
    primaryFailure: null,
    restart: {
      ...expected,
      runtime: undefined,
      schemaVersion: 1,
      mode: "cold-preserved",
      provider: "nvidia",
      endpoint: "https://integrate.api.nvidia.com/v1",
      configurationReused: false,
      configurationPreserved: true,
      cleanupDisposition: "retained-for-warm-run",
      processesStopped: true,
      stateOwnerReleased: true,
      backendCleanupConfirmed: true,
      mutationUnconfirmed: false,
      credentialMutationConfirmed: true,
      configurationSha256: "2".repeat(64),
      ownedState: { stateRoot: "C:\\NemoClawState-S-1-5-21-1-openclaw", device: "4", inode: "55" },
      retainedConversation: {
        sessionKey: "agent:main:main",
        messageCount: 2,
        sha256: "3".repeat(64),
      },
    },
    results: {
      response: {
        provider: "nvidia",
        model: expected.model,
        deterministicModel: false,
        visibleReply: "NEMOCLAW_NVIDIA_" + "4".repeat(24),
      },
      sessionCleanup: {
        verdict: "pass",
        sandboxDeleted: true,
        sandboxRegistryAbsent: true,
        gatewayStopped: true,
        qualificationRootsRemoved: true,
      },
    },
  };
  return { expected, receipt };
}

test("OpenClaw restart rejects stale, failed, foreign or incomplete cold receipts", () => {
  const { expected, receipt } = coldOpenClawFixture();
  assert.equal(validateOpenClawColdReceipt(receipt, expected), receipt.restart);
  const mutations: ((value: any) => void)[] = [
    (v) => (v.schemaVersion = 1),
    (v) => (v.verdict = "fail"),
    (v) => v.cleanupErrors.push("cleanup"),
    (v) => (v.primaryFailure = {}),
    (v) => (v.restart.mode = "warm-reused"),
    (v) => (v.restart.controllerRun = "122:1"),
    (v) => (v.restart.handoff = "9".repeat(64)),
    (v) => (v.restart.installation = "C:\\other"),
    (v) => (v.restart.launcherSha256 = "9".repeat(64)),
    (v) => (v.restart.packageBuildSha256 = "9".repeat(64)),
    (v) => (v.restart.artifactSourceSnapshotSha256 = "9".repeat(64)),
    (v) => (v.restart.controllerSourceRevision = "9".repeat(40)),
    (v) => (v.restart.model = "other"),
    (v) => (v.restart.provider = "compatible"),
    (v) => (v.restart.endpoint = "https://other.example/v1"),
    (v) => (v.restart.configurationReused = true),
    (v) => (v.restart.configurationPreserved = false),
    (v) => (v.restart.cleanupDisposition = "removed-owned-state"),
    (v) => (v.restart.processesStopped = false),
    (v) => (v.restart.stateOwnerReleased = false),
    (v) => (v.restart.backendCleanupConfirmed = false),
    (v) => (v.restart.mutationUnconfirmed = true),
    (v) => (v.restart.credentialMutationConfirmed = false),
    (v) => (v.restart.configurationSha256 = "bad"),
    (v) => (v.restart.ownedState.inode = "0"),
    (v) => (v.restart.ownedState.stateRoot = "C:\\NemoClawState-S-1-5-21-1-hermes"),
    (v) => (v.restart.retainedConversation.messageCount = 100),
    (v) => (v.restart.retainedConversation.sha256 = "bad"),
    (v) => (v.results.response.deterministicModel = true),
    (v) => (v.results.response.visibleReply = "old reply"),
    ...["runtimeId", "manifestSha256", "sourceRevision", "nodeSha256", "nodeVersion"].map(
      (key) => (v: any) => (v.runtime[key] = "other"),
    ),
    ...[
      "sandboxDeleted",
      "sandboxRegistryAbsent",
      "gatewayStopped",
      "qualificationRootsRemoved",
    ].map((key) => (v: any) => (v.results.sessionCleanup[key] = false)),
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(receipt);
    mutate(candidate);
    assert.throws(() => validateOpenClawColdReceipt(candidate, expected));
  }
});

test("OpenClaw warm receipt binds a new real reply to the retained cold conversation and cleanup", () => {
  const { expected, receipt: cold } = coldOpenClawFixture();
  const warm = {
    ...structuredClone(cold),
    restart: {
      ...structuredClone(cold.restart),
      mode: "warm-reused",
      configurationReused: true,
      configurationPreserved: false,
      cleanupDisposition: "removed-owned-state",
      cleanupScope: "owned-configuration-state-and-credential",
      restoredConversation: structuredClone(cold.restart.retainedConversation),
      retainedConversation: {
        ...cold.restart.retainedConversation,
        messageCount: 4,
        sha256: "5".repeat(64),
      },
    },
  };
  warm.results.response.visibleReply = "NEMOCLAW_NVIDIA_" + "6".repeat(24);
  assert.equal(validateOpenClawWarmReceipt(warm, cold, expected), warm.restart);
  const mutations: ((value: typeof warm) => void)[] = [
    (v) => (v.verdict = "fail"),
    (v) => (v.restart.mode = "cold-preserved"),
    (v) => (v.restart.configurationReused = false),
    (v) => (v.restart.configurationPreserved = true),
    (v) => (v.restart.cleanupDisposition = "retained-for-warm-run"),
    (v) => (v.restart.cleanupScope = "incomplete"),
    (v) => (v.restart.controllerRun = "123:2"),
    (v) => (v.restart.packageBuildSha256 = "7".repeat(64)),
    (v) => (v.restart.configurationSha256 = "7".repeat(64)),
    (v) => (v.restart.ownedState.inode = "99"),
    (v) => (v.restart.restoredConversation.sha256 = "7".repeat(64)),
    (v) => (v.restart.retainedConversation.sessionKey = "agent:main:other"),
    (v) =>
      (v.restart.retainedConversation.messageCount =
        cold.restart.retainedConversation.messageCount),
    (v) => (v.restart.retainedConversation.sha256 = cold.restart.retainedConversation.sha256),
    (v) => (v.results.response.visibleReply = cold.results.response.visibleReply),
    (v) => (v.results.response.deterministicModel = true),
    (v) => (v.results.sessionCleanup.gatewayStopped = false),
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(warm);
    mutate(candidate);
    assert.throws(() => validateOpenClawWarmReceipt(candidate, cold, expected));
  }
  assert.throws(() => validateOpenClawWarmReceipt(warm, { ...cold, verdict: "fail" }, expected));
});

function availabilityEvidenceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-availability-"));
  const { expected, receipt: cold } = coldOpenClawFixture();
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
  const sha = (value: unknown) => createHash("sha256").update(bytes(value)).digest("hex");
  const build = {
    schemaVersion: 1,
    classification: "finished-native-runtime-package-build",
    sourceRevision: expected.runtime.sourceRevision,
    runtime: expected.runtime,
    status: "candidate-built-for-installed-qualification",
    installedAcceptance: false,
    activationAllowed: false,
  };
  const snapshot = {
    schemaVersion: 1,
    classification: "independent-openclaw-launcher-source-snapshot",
    artifactSourceRevision: expected.runtime.sourceRevision,
    controllerSourceRevision: expected.controllerSourceRevision,
    controllerRun: expected.controllerRun,
    sources: [
      "Cargo.toml",
      "Cargo.lock",
      "src/main.rs",
      "src/state_session.rs",
      "src/runtime_lease.rs",
    ].map((file) => ({
      file: "packaging/windows/launcher/" + file,
      bytes: 10,
      sha256: "9".repeat(64),
    })),
  };
  cold.restart.packageBuildSha256 = sha(build);
  cold.restart.artifactSourceSnapshotSha256 = sha(snapshot);
  const warm = {
    ...structuredClone(cold),
    restart: {
      ...structuredClone(cold.restart),
      mode: "warm-reused",
      configurationReused: true,
      configurationPreserved: false,
      cleanupDisposition: "removed-owned-state",
      cleanupScope: "owned-configuration-state-and-credential",
      restoredConversation: structuredClone(cold.restart.retainedConversation),
      retainedConversation: {
        ...cold.restart.retainedConversation,
        messageCount: 4,
        sha256: "5".repeat(64),
      },
    },
  };
  warm.results.response.visibleReply = "NEMOCLAW_NVIDIA_" + "6".repeat(24);
  const coldPath = "installed-acceptance/installed-openclaw-acceptance.json";
  const warmPath = "installed-acceptance-warm/installed-openclaw-acceptance.json";
  const timings = {
    schemaVersion: 1,
    sourceRevision: expected.runtime.sourceRevision,
    artifactSourceRevision: expected.runtime.sourceRevision,
    controllerSourceRevision: expected.controllerSourceRevision,
    currentHeadQualification: false,
    mode: "current-build",
    measurement: "fresh-runner-installed-preview",
    agent: "openclaw",
    validationScope: "full-acceptance",
    fullInstalledQualification: true,
    hostPreparationRunBeforeInstall: false,
    installTargetMilliseconds: 30000,
    installTargetSatisfied: true,
    primaryException: null,
    nativeRuntimeFailure: null,
    startupComparisonAvailable: true,
    installationRootRemoved: true,
    stages: Object.fromEntries(
      ["-install", "-uninstall"].map((action) => [
        action,
        {
          exitCode: 0,
          transactionStopped: true,
          elapsedMilliseconds: 20000,
        },
      ]),
    ),
    firstInstalledLaunch: { exitCode: 0, receipt: coldPath, agentStateResetPerCase: false },
    warmInstalledLaunch: { exitCode: 0, receipt: warmPath, agentStateResetPerCase: false },
    restartPersistence: {
      qualified: true,
      configurationRewritten: false,
      credentialRecreated: false,
      sameConversation: true,
      sameOwnedState: true,
      coldReceipt: coldPath,
      warmReceipt: warmPath,
    },
    remainingInstallation: { entries: [], truncated: false },
  };
  const documents: Record<string, unknown> = {
    "package/immutable-package-build.json": build,
    "package/launcher-build-inputs.json": {
      schemaVersion: 1,
      classification: "package-selected-launcher-build-inputs",
      sourceRevision: expected.runtime.sourceRevision,
      workflowRunId: "123",
      workflowRunAttempt: "1",
      retainedLauncher: { sha256: expected.launcherSha256 },
    },
    "openclaw-artifact-source.json": snapshot,
    [coldPath]: cold,
    [warmPath]: warm,
    "installed-stage-timings.json": timings,
  };
  const input = {
    evidenceRoot: root,
    evidenceManifestSha256: "",
    sourceRevision: expected.runtime.sourceRevision,
    controllerSourceRevision: expected.controllerSourceRevision,
    controllerRun: expected.controllerRun,
  };
  function stage() {
    const files = Object.entries(documents).map(([relative, value]) => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes(value));
      return { path: relative, bytes: bytes(value).length, sha256: sha(value) };
    });
    const manifest = {
      schemaVersion: 1,
      classification: "accidental-runnable-free-windows-evidence",
      files,
    };
    fs.writeFileSync(path.join(root, "evidence-manifest.json"), bytes(manifest));
    input.evidenceManifestSha256 = sha(manifest);
  }
  stage();
  return { root, input, documents, stage, cold, warm, timings, expected };
}

test("reviewed OpenClaw availability binds protected full acceptance without claiming final installer approval", (t) => {
  const fixture = availabilityEvidenceFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = reviewOpenClawAvailability(fixture.input);
  assert.deepEqual(result, {
    schemaVersion: 1,
    classification: "reviewed-native-runtime-availability",
    runtime: fixture.expected.runtime,
    agents: [{ agent: "openclaw", evidenceSha256: fixture.input.evidenceManifestSha256 }],
  });
  const output = path.join(fixture.root, "reviewed-availability.json");
  const command = [
    "--experimental-strip-types",
    "--no-warnings",
    fileURLToPath(new URL("./review-openclaw-availability.mts", import.meta.url)),
    "--evidence-root",
    fixture.root,
    "--evidence-manifest-sha256",
    fixture.input.evidenceManifestSha256,
    "--source-revision",
    fixture.input.sourceRevision,
    "--controller-source-revision",
    fixture.input.controllerSourceRevision,
    "--controller-run",
    fixture.input.controllerRun,
    "--output",
    output,
  ];
  const child = spawnSync(process.execPath, command, { encoding: "utf8", timeout: 30000 });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), result);
  assert.equal(
    child.stdout.trim(),
    createHash("sha256").update(fs.readFileSync(output)).digest("hex"),
  );
  const repeated = spawnSync(process.execPath, command, { encoding: "utf8", timeout: 30000 });
  assert.notEqual(repeated.status, 0, "A reviewed decision must never overwrite existing output.");
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), result);
});

test("availability review rejects startup-only, failed, slow, reset and incomplete-cleanup evidence even with a matching manifest", (t) => {
  const fixture = availabilityEvidenceFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const original = structuredClone(fixture.documents);
  const changes: ((documents: Record<string, any>) => void)[] = [
    (d) => (d["installed-stage-timings.json"].validationScope = "startup-only"),
    (d) => (d["installed-stage-timings.json"].fullInstalledQualification = false),
    (d) => (d["installed-stage-timings.json"].installTargetMilliseconds = 40000),
    (d) => (d["installed-stage-timings.json"].stages["-install"].elapsedMilliseconds = 30000),
    (d) => (d["installed-stage-timings.json"].stages["-uninstall"].transactionStopped = false),
    (d) => (d["installed-stage-timings.json"].firstInstalledLaunch.exitCode = 1),
    (d) => (d["installed-stage-timings.json"].warmInstalledLaunch.agentStateResetPerCase = true),
    (d) => (d["installed-stage-timings.json"].remainingInstallation.entries = ["retained.exe"]),
    (d) => (d["installed-stage-timings.json"].uninstallDeferredForRecovery = true),
    (d) => (d["installed-stage-timings.json"].restartPersistence.configurationRewritten = true),
    (d) => (d["installed-stage-timings.json"].primaryException = "failed"),
    (d) => (d["installed-stage-timings.json"].controllerSourceRevision = "0".repeat(40)),
    (d) =>
      (d[
        "installed-acceptance/installed-openclaw-acceptance.json"
      ].results.response.deterministicModel = true),
    (d) =>
      (d[
        "installed-acceptance-warm/installed-openclaw-acceptance.json"
      ].restart.restoredConversation.sha256 = "0".repeat(64)),
    (d) => (d["package/launcher-build-inputs.json"].workflowRunAttempt = "2"),
    (d) => (d["package/immutable-package-build.json"].runtime.runtimeId = "0".repeat(64)),
    (d) => (d["openclaw-artifact-source.json"].controllerSourceRevision = "0".repeat(40)),
  ];
  for (const change of changes) {
    Object.assign(fixture.documents, structuredClone(original));
    change(fixture.documents);
    fixture.stage();
    assert.throws(() => reviewOpenClawAvailability(fixture.input));
  }
});

test("availability review refuses foreign run identity, changed receipt bytes and missing manifest entries", (t) => {
  const fixture = availabilityEvidenceFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  for (const change of [
    { evidenceManifestSha256: "0".repeat(64) },
    { sourceRevision: "0".repeat(40) },
    { controllerSourceRevision: "0".repeat(40) },
    { controllerRun: "123:2" },
  ])
    assert.throws(() => reviewOpenClawAvailability({ ...fixture.input, ...change }));
  fs.appendFileSync(path.join(fixture.root, "installed-stage-timings.json"), " ");
  assert.throws(() => reviewOpenClawAvailability(fixture.input));
  delete fixture.documents["installed-stage-timings.json"];
  fixture.stage();
  assert.throws(() => reviewOpenClawAvailability(fixture.input));
});

test("OpenClaw cleanup retains ambiguous mutation, process, backend and lease ownership", () => {
  const input = {
    owned: true,
    processesStopped: true,
    stateOwnerReleased: true,
    backendCleanupConfirmed: true,
    mutationUnconfirmed: false,
    preserve: true,
    successful: true,
  };
  assert.equal(openClawCleanupDisposition(input), "retained-for-warm-run");
  assert.equal(openClawCleanupDisposition({ ...input, preserve: false }), "remove-owned-state");
  assert.equal(openClawCleanupDisposition({ ...input, successful: false }), "remove-owned-state");
  assert.equal(openClawCleanupDisposition({ ...input, owned: false }), "not-owned");
  for (const change of [
    { processesStopped: false },
    { stateOwnerReleased: false },
    { backendCleanupConfirmed: false },
    { mutationUnconfirmed: true },
  ])
    assert.equal(openClawCleanupDisposition({ ...input, ...change }), "retain-unconfirmed");
});

test("OpenClaw retained inspection reads only while held and rejects absent or replaced state", async () => {
  const state = { stateRoot: "C:\\NemoClawState-S-1-5-21-1-openclaw", device: "4", inode: "55" };
  const configuration = Buffer.from("controlled config");
  const sha256 = createHash("sha256").update(configuration).digest("hex");
  for (const scenario of [
    "pass",
    "missing",
    "replaced",
    "changed-config",
    "lost-lease",
    "release-failure",
  ]) {
    let held = false,
      released = 0,
      reads = 0,
      checks = 0;
    const owner = {
      present: scenario !== "missing",
      stateRoot: state.stateRoot,
      assertHeld() {
        checks++;
        assert(held);
        if (scenario === "lost-lease" && checks > 1) throw new Error("lease lost");
      },
      async release() {
        released++;
        if (scenario === "release-failure") throw new Error("release failed");
      },
      created: false,
      removed: false,
    };
    const result = inspectRetainedOpenClawState(
      {
        launcher: "fixture-only",
        expectedState: state,
        configurationPath: "fixture-only",
        configurationSha256: sha256,
        ownerHeld: (value) => {
          held = value;
        },
      },
      {
        acquire: async () => owner,
        directoryIdentity: () => {
          assert(held);
          return { ...state, inode: scenario === "replaced" ? "56" : "55" };
        },
        read: () => {
          assert(held);
          reads++;
          return scenario === "changed-config" ? Buffer.from("changed") : configuration;
        },
      },
    );
    if (scenario === "pass") assert.deepEqual(await result, state);
    else await assert.rejects(result);
    assert.equal(released, 1);
    assert.equal(held, scenario === "release-failure");
    assert.equal(reads, ["missing", "replaced"].includes(scenario) ? 0 : 1);
  }
});

test("OpenClaw cold restart uses one credential transaction and retains ambiguity on failure", async () => {
  for (const fail of [false, true]) {
    const calls: { name: string; args: string[]; stdin: string }[] = [];
    const custody: boolean[] = [];
    let binding = "";
    const configuration = {
      agent: "openclaw",
      inference: "nvidia",
      endpoint: "https://integrate.api.nvidia.com/v1",
    };
    const operation = saveFreshOpenClawConfiguration({
      restart: true,
      configuration,
      secret: "fixture-private-key",
      rememberBinding: (value) => {
        binding = value;
      },
      mutationUnconfirmed: (value) => custody.push(value),
      command: async (name, args, stdin) => {
        calls.push({ name, args, stdin });
        if (fail) throw new Error("unconfirmed");
        return "saved";
      },
    });
    if (fail) await assert.rejects(operation, /unconfirmed/u);
    else await operation;
    assert.match(binding, /^[a-f0-9]{64}$/u);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "save-config-transaction");
    assert.deepEqual(calls[0].args, ["--configure-native", "--agent", "openclaw", "--transaction"]);
    assert(!calls[0].args.includes("fixture-private-key"));
    assert.deepEqual(JSON.parse(calls[0].stdin), {
      configuration,
      credentials: { inference: "fixture-private-key", services: {} },
    });
    assert.deepEqual(custody, fail ? [true] : [true, false]);
  }
});

test("OpenClaw native owners and automation inherit no provider key or runtime override", () => {
  const source = {
    SystemRoot: "C:\\Windows",
    GITHUB_ACTIONS: "true",
    NVIDIA_API_KEY: "private",
    NVIDIA_INFERENCE_API_KEY: "private",
    NODE_OPTIONS: "untrusted",
    NEMOCLAW_NATIVE_INSTALL_ROOT: "override",
    RUNNER_TEMP: "controller-only",
  };
  assert.deepEqual(stripInheritedAcceptanceEnvironment(source), {
    SystemRoot: "C:\\Windows",
    GITHUB_ACTIONS: "true",
  });
  assert.deepEqual(source, { SystemRoot: "C:\\Windows", GITHUB_ACTIONS: "true" });
});

test("OpenClaw restart hands off only successful cold state and proves removal before releasing cleanup custody", async () => {
  const state = { stateRoot: "C:\\NemoClawState-S-1-5-21-1-openclaw", device: "4", inode: "55" };
  for (const scenario of [
    "cold-pass",
    "cold-failure",
    "warm-pass",
    "not-owned",
    "live-process",
    "unknown-backend",
    "unknown-mutation",
    "failed-inspection",
    "failed-remove",
    "failed-key-delete",
    "state-still-present",
    "failed-release",
    "metadata-remains",
    "different-inspection-root",
  ]) {
    const events: string[] = [],
      errors: string[] = [];
    const restart = {
      processesStopped: scenario !== "live-process",
      backendCleanupConfirmed: scenario !== "unknown-backend",
      stateOwnerReleased: true,
      mutationUnconfirmed: scenario === "unknown-mutation",
      cleanupDisposition: "pending",
      configurationPreserved: false,
    };
    await completeOpenClawRestartState(
      {
        restart,
        owned: scenario !== "not-owned",
        preserve: scenario.startsWith("cold"),
        successful: scenario !== "cold-failure",
        launcher: "fixture-only",
        ownedState: state,
        configurationPath: "fixture-only",
        configurationSha256: "c".repeat(64),
        binding: "b".repeat(64),
        command: async (name) => {
          events.push(name);
          if (
            (scenario === "failed-remove" && name === "remove-configured-data") ||
            (scenario === "failed-key-delete" && name === "credential-delete")
          )
            throw new Error("controlled failure");
          return "";
        },
        cleanupFailed: (action) => errors.push(action),
      },
      {
        inspectRetained: async (input) => {
          events.push("inspect");
          assert.deepEqual(input.expectedState, state);
          input.ownerHeld(true);
          if (scenario === "failed-inspection") throw new Error("unconfirmed inspection");
          input.ownerHeld(false);
          return state;
        },
        acquire: async () => {
          events.push("confirm-absent");
          return {
            present: scenario === "state-still-present",
            stateRoot: scenario === "different-inspection-root" ? "C:\\different" : state.stateRoot,
            created: false,
            removed: false,
            assertHeld() {},
            async release() {
              events.push("release");
              if (scenario === "failed-release") throw new Error("release failed");
            },
          };
        },
        removeRoot: async () => {
          throw new Error("Configured cleanup must not use root-only removal.");
        },
        configurationAbsent: () => scenario !== "metadata-remains",
      },
    );
    const removed = ["warm-pass", "cold-failure"].includes(scenario);
    assert.equal(
      restart.cleanupDisposition,
      scenario === "cold-pass"
        ? "retained-for-warm-run"
        : removed
          ? "removed-owned-state"
          : scenario === "not-owned"
            ? "not-owned"
            : "retain-unconfirmed",
    );
    assert.equal(restart.configurationPreserved, scenario === "cold-pass");
    assert.equal(
      errors.length > 0,
      !["cold-pass", "warm-pass", "cold-failure", "not-owned"].includes(scenario),
    );
    if (["not-owned", "live-process", "unknown-backend", "unknown-mutation"].includes(scenario))
      assert.deepEqual(events, []);
    if (["cold-pass", "failed-inspection"].includes(scenario))
      assert.deepEqual(events, ["inspect"]);
    if (scenario === "failed-remove")
      assert.deepEqual(events, ["inspect", "remove-configured-data"]);
    if (scenario === "failed-key-delete")
      assert.deepEqual(events, ["inspect", "remove-configured-data", "credential-delete"]);
    if (removed)
      assert.deepEqual(events, [
        "inspect",
        "remove-configured-data",
        "credential-delete",
        "confirm-absent",
        "release",
      ]);
    assert.equal(
      restart.stateOwnerReleased,
      !["failed-inspection", "failed-release"].includes(scenario),
    );
  }
});

test("OpenClaw failure before its credential transaction removes only fresh owned private state", async () => {
  const state = { stateRoot: "C:\\NemoClawState-S-1-5-21-1-openclaw", device: "4", inode: "55" };
  for (const scenario of [
    "pass",
    "metadata-appeared",
    "configured-hash",
    "different-root",
    "not-removed",
    "release-failure",
  ]) {
    const events: string[] = [],
      errors: string[] = [];
    const restart: any = {
      processesStopped: true,
      backendCleanupConfirmed: true,
      stateOwnerReleased: true,
      mutationUnconfirmed: false,
    };
    await completeOpenClawRestartState(
      {
        restart,
        owned: true,
        preserve: true,
        successful: false,
        launcher: "fixture-only",
        ownedState: state,
        configurationPath: "fixture-only",
        configurationSha256: scenario === "configured-hash" ? "c".repeat(64) : undefined,
        command: async () => {
          throw new Error(
            "Pre-transaction cleanup must not run configuration or credential removal.",
          );
        },
        cleanupFailed: (action) => errors.push(action),
      },
      {
        inspectRetained: async (input) => {
          events.push("inspect");
          assert.deepEqual(input.expectedState, state);
          return state;
        },
        removeRoot: async () => {
          events.push("remove-root");
          return {
            stateRoot: scenario === "different-root" ? "C:\\different" : state.stateRoot,
            removed: scenario !== "not-removed",
            created: false,
            assertHeld() {},
            async release() {
              events.push("release-root");
              if (scenario === "release-failure") throw new Error("release failed");
            },
          };
        },
        acquire: async () => {
          events.push("confirm-absent");
          return {
            stateRoot: state.stateRoot,
            present: false,
            removed: false,
            created: false,
            assertHeld() {},
            async release() {
              events.push("release-inspection");
            },
          };
        },
        configurationAbsent: () => scenario !== "metadata-appeared",
      },
    );
    assert.equal(restart.credentialMutationConfirmed, false);
    assert.equal(
      restart.cleanupDisposition,
      scenario === "pass" ? "removed-owned-state" : "retain-unconfirmed",
    );
    assert.equal(errors.length === 0, scenario === "pass");
    assert.equal(restart.configurationPreserved, false);
    if (scenario === "pass") {
      assert.equal(restart.cleanupScope, "fresh-private-root-only-no-credentials-touched");
      assert.deepEqual(events, [
        "inspect",
        "remove-root",
        "release-root",
        "confirm-absent",
        "release-inspection",
      ]);
    }
    if (["metadata-appeared", "configured-hash"].includes(scenario))
      assert.deepEqual(events, ["inspect"]);
    if (["different-root", "not-removed", "release-failure"].includes(scenario))
      assert.deepEqual(events, ["inspect", "remove-root", "release-root"]);
    assert.equal(restart.stateOwnerReleased, scenario !== "release-failure");
  }
});

test("OpenClaw fresh-state and cleanup checks reject present, redirected or unreadable settings directories", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-absence-control-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = path.join(root, "agent", "native-windows.json");
  assert.equal(openClawConfigurationAbsent(configuration), true);
  fs.mkdirSync(path.dirname(configuration));
  assert.equal(openClawConfigurationAbsent(configuration), false);
  fs.rmdirSync(path.dirname(configuration));
  fs.writeFileSync(path.dirname(configuration), "not-a-directory");
  assert.equal(openClawConfigurationAbsent(configuration), false);
  const stat = fs.lstatSync(path.dirname(configuration));
  const mocked = context.mock.method(
    fs,
    "lstatSync",
    () =>
      new Proxy(stat, {
        get(target, property) {
          return property === "isSymbolicLink" ? () => true : Reflect.get(target, property);
        },
      }),
  );
  assert.equal(openClawConfigurationAbsent(configuration), false);
  mocked.mock.restore();
  const denied = context.mock.method(fs, "lstatSync", () => {
    throw Object.assign(new Error("access denied"), { code: "EACCES" });
  });
  try {
    assert.throws(() => openClawConfigurationAbsent(configuration), { code: "EACCES" });
  } finally {
    denied.mock.restore();
  }
});

function inspectionOpenClawFixture(agent: "openclaw" | "hermes" = "openclaw") {
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const bytes = (document: any) => Buffer.from(JSON.stringify(document));
  const sourceRevision = "a".repeat(40),
    controllerRun = "123:1",
    launcherBytes = Buffer.from("fixture-only-launcher");
  const row = (file: string, content: Buffer) => ({
    file,
    bytes: content.length,
    sha256: hash(content),
  });
  const sourceFiles = [
    "Cargo.toml",
    "Cargo.lock",
    "src/main.rs",
    "src/state_session.rs",
    "src/runtime_lease.rs",
    "src/other.rs",
  ].map((file) => "packaging/windows/launcher/" + file);
  const readSource = (file: string) => Buffer.from("fixture-source:" + file);
  const materialization = {
    schemaVersion: 1,
    classification: "ci-native-compiled-artifact",
    status: "materialized",
    runtimeLaunchCopy: false,
    outputSha256: hash(launcherBytes),
    sourceSha256Before: hash(launcherBytes),
    sourceSha256After: hash(launcherBytes),
    outputStat: { bytes: launcherBytes.length, links: 1 },
  };
  const materializationBytes = bytes(materialization);
  const capabilities = {
    schemaVersion: 1,
    launcherSha256: hash(launcherBytes),
    capabilities: {
      schemaVersion: 1,
      kind: "native-runtime-capabilities",
      immutableRuntime: true,
      guardianEnabled: true,
      supportedCommands: ["native-state-inspection-v1"],
    },
  };
  const capabilityBytes = bytes(capabilities);
  const source = {
    schemaVersion: 1,
    classification: "package-selected-launcher-build-inputs",
    sourceRevision,
    workflowRunId: "123",
    workflowRunAttempt: "1",
    target: "aarch64-pc-windows-msvc",
    rustToolchain: "1.95.0-aarch64-pc-windows-msvc",
    features: ["immutable-runtime"],
    lockedDependencies: true,
    staticCrt: true,
    commandSupportValidated: false,
    invocationAdmitted: false,
    installedAcceptance: false,
    retainedLauncher: row("build/compiled-native/NemoClaw.exe", launcherBytes),
    packagedLauncher: row("build/payload/bin/NemoClaw.exe", launcherBytes),
    materialization: row("compiled-launcher.json", materializationBytes),
    capabilityObservation: {
      ...row("build/launcher-capabilities.json", capabilityBytes),
      advertisedCommands: ["native-state-inspection-v1"],
    },
    sources: sourceFiles.map((file) => row(file, readSource(file))),
  };
  const sourceBytes = bytes(source);
  const artifactSourceSnapshotBytes = bytes({
    schemaVersion: 1,
    classification: `independent-${agent}-launcher-source-snapshot`,
    artifactSourceRevision: sourceRevision,
    controllerSourceRevision: "b".repeat(40),
    controllerRun,
    sources: sourceFiles.map((file) => row(file, readSource(file))),
  });
  const build = {
    schemaVersion: 1,
    classification: "finished-native-runtime-package-build",
    status: "candidate-built-for-installed-qualification",
    sourceRevision,
    launcherBuildInputs: row("launcher-build-inputs.json", sourceBytes),
    launcherCapabilitiesSha256: hash(capabilityBytes),
    compiledArtifacts: [row("compiled-launcher.json", materializationBytes)],
  };
  const input = {
    buildBytes: bytes(build),
    sourceBytes,
    capabilityBytes,
    materializationBytes,
    launcherBytes,
    packagedBytes: launcherBytes,
    installedBytes: launcherBytes,
    sourceRevision,
    controllerRun,
    artifactSourceSnapshotBytes,
    artifactSourceSnapshotSha256: hash(artifactSourceSnapshotBytes),
    controllerSourceRevision: "b".repeat(40),
  };
  const rebuild = () => {
    input.capabilityBytes = bytes(capabilities);
    input.materializationBytes = bytes(materialization);
    source.capabilityObservation = {
      ...row("build/launcher-capabilities.json", input.capabilityBytes),
      advertisedCommands: capabilities.capabilities.supportedCommands,
    };
    source.materialization = row("compiled-launcher.json", input.materializationBytes);
    input.sourceBytes = bytes(source);
    build.launcherBuildInputs = row("launcher-build-inputs.json", input.sourceBytes);
    build.launcherCapabilitiesSha256 = hash(input.capabilityBytes);
    build.compiledArtifacts = [row("compiled-launcher.json", input.materializationBytes)];
    input.buildBytes = bytes(build);
  };
  return { input, source, capabilities, materialization, build, rebuild };
}

for (const agent of ["openclaw", "hermes"] as const)
  test(`${agent} inspection admission binds package bytes, declared support and complete source/build provenance`, () => {
    const validate = (input: Parameters<typeof validateOpenClawInspectionInputs>[0]) =>
      agent === "openclaw"
        ? validateOpenClawInspectionInputs(input)
        : validateInstalledLauncherInputs({ ...input, agent });
    const fixture = inspectionOpenClawFixture(agent);
    const admitted = validate(fixture.input);
    assert.match(admitted.launcherSha256, /^[a-f0-9]{64}$/u);
    assert.match(admitted.packageBuildSha256, /^[a-f0-9]{64}$/u);
    const mutations: ((f: ReturnType<typeof inspectionOpenClawFixture>) => void)[] = [
      (f) => (f.input.installedBytes = Buffer.from("other")),
      (f) => (f.input.packagedBytes = Buffer.from("other")),
      (f) => (f.input.controllerRun = "124:1"),
      (f) => (f.source.sourceRevision = "b".repeat(40)),
      (f) => (f.source.target = "x86_64-pc-windows-msvc"),
      (f) => (f.source.rustToolchain = "other"),
      (f) => (f.source.features = []),
      (f) => (f.source.staticCrt = false),
      (f) => (f.source.invocationAdmitted = true),
      (f) => (f.source.commandSupportValidated = true),
      (f) => (f.materialization.outputSha256 = "b".repeat(64)),
      (f) => (f.materialization.runtimeLaunchCopy = true),
      (f) => (f.materialization.outputStat.links = 2),
      (f) => (f.capabilities.capabilities.supportedCommands = []),
      (f) => (f.capabilities.capabilities.guardianEnabled = false),
      (f) => f.source.sources.pop(),
      (f) => (f.source.sources[0].file = "packaging/windows/launcher/../secret"),
      (f) => f.source.sources.push(f.source.sources[0]),
      (f) => (f.source.sources[0].sha256 = "b".repeat(64)),
      (f) => (f.input.artifactSourceSnapshotBytes = Buffer.from("{}")),
      (f) => (f.input.artifactSourceSnapshotSha256 = "b".repeat(64)),
      (f) => (f.input.controllerSourceRevision = "c".repeat(40)),
      (f) => (f.build.sourceRevision = "b".repeat(40)),
    ];
    for (const mutate of mutations) {
      const candidate = inspectionOpenClawFixture(agent);
      mutate(candidate);
      candidate.rebuild();
      assert.throws(() => validate(candidate.input));
    }
    fixture.input.sourceBytes = Buffer.concat([fixture.input.sourceBytes, Buffer.from(" ")]);
    assert.throws(() => validate(fixture.input));
  });

test("Hermes installed admission reads the selected package and rejects changed installed bytes or another agent's snapshot", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-launcher-admission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = inspectionOpenClawFixture("hermes").input;
  const packageRoot = path.join(root, "package");
  const launcher = path.join(root, "installed", "NemoClaw.exe");
  const artifactSourceSnapshot = path.join(root, "snapshot.json");
  for (const [relative, bytes] of [
    ["immutable-package-build.json", input.buildBytes],
    ["launcher-build-inputs.json", input.sourceBytes],
    ["compiled-launcher.json", input.materializationBytes],
    ["build/launcher-capabilities.json", input.capabilityBytes],
    ["build/compiled-native/NemoClaw.exe", input.launcherBytes],
    ["build/payload/bin/NemoClaw.exe", input.packagedBytes],
  ] as const) {
    const file = path.join(packageRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  fs.mkdirSync(path.dirname(launcher));
  fs.writeFileSync(launcher, input.installedBytes);
  fs.writeFileSync(artifactSourceSnapshot, input.artifactSourceSnapshotBytes);
  const request = {
    packageRoot,
    launcher,
    artifactSourceSnapshot,
    sourceRevision: input.sourceRevision,
    controllerRun: input.controllerRun,
    controllerSourceRevision: input.controllerSourceRevision,
    artifactSourceSnapshotSha256: input.artifactSourceSnapshotSha256,
  };
  assert.deepEqual(
    admitInstalledHermesLauncher(request),
    validateInstalledLauncherInputs({ ...input, agent: "hermes" }),
  );
  fs.writeFileSync(launcher, "changed inert launcher fixture");
  assert.throws(() => admitInstalledHermesLauncher(request), /package-selected launcher/u);
  fs.writeFileSync(launcher, input.installedBytes);
  const foreign = inspectionOpenClawFixture().input;
  fs.writeFileSync(artifactSourceSnapshot, foreign.artifactSourceSnapshotBytes);
  assert.throws(() =>
    admitInstalledHermesLauncher({
      ...request,
      artifactSourceSnapshotSha256: foreign.artifactSourceSnapshotSha256,
    }),
  );
});

for (const agent of ["openclaw", "hermes"] as const)
  test(`${agent} source capture verifies Git bytes without executing candidate code`, (context) => {
    const capture = (input: Parameters<typeof captureOpenClawArtifactSources>[0]) =>
      agent === "openclaw"
        ? captureOpenClawArtifactSources(input)
        : captureLauncherArtifactSources({ ...input, agent });
    const validate = (input: Parameters<typeof validateOpenClawArtifactSourceSnapshot>[0]) =>
      agent === "openclaw"
        ? validateOpenClawArtifactSourceSnapshot(input)
        : validateLauncherArtifactSourceSnapshot({ ...input, agent });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-source-capture-"));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const controller = path.join(root, "controller");
    const artifact = path.join(root, "artifact");
    const git = (directory: string, ...args: string[]) => {
      const result = spawnSync("git", ["-c", "core.hooksPath=", "-C", directory, ...args], {
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
        encoding: "utf8",
        timeout: 10000,
        windowsHide: true,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const create = (directory: string) => {
      fs.mkdirSync(directory);
      git(directory, "init", "--quiet");
      fs.writeFileSync(path.join(directory, ".gitattributes"), "* text=auto eol=lf\n");
    };
    create(controller);
    git(controller, "add", ".");
    git(controller, "commit", "--quiet", "-m", "Controller fixture");
    create(artifact);
    const launcher = path.join(artifact, "packaging", "windows", "launcher");
    fs.mkdirSync(path.join(launcher, "src"), { recursive: true });
    for (const file of [
      "Cargo.toml",
      "Cargo.lock",
      "src/main.rs",
      "src/state_session.rs",
      "src/runtime_lease.rs",
    ])
      fs.writeFileSync(path.join(launcher, file), "fixture source: " + file + "\n");
    fs.writeFileSync(
      path.join(launcher, "README.md"),
      "Data only. Never execute candidate scripts.\n",
    );
    git(artifact, "add", ".");
    git(artifact, "commit", "--quiet", "-m", "Artifact fixture");
    const input = {
      artifactSourceRoot: artifact,
      controllerSourceRoot: controller,
      artifactSourceRevision: git(artifact, "rev-parse", "HEAD"),
      controllerSourceRevision: git(controller, "rev-parse", "HEAD"),
      controllerRun: "123:1",
    };
    const captured = capture(input);
    if (agent === "hermes") {
      const output = path.join(root, "hermes-captured.json");
      const result = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          fileURLToPath(new URL("./qualify-installed-hermes.mts", import.meta.url)),
          "--capture-artifact-source",
          "--artifact-source-root",
          artifact,
          "--controller-source-root",
          controller,
          "--artifact-source-revision",
          input.artifactSourceRevision,
          "--controller-source-revision",
          input.controllerSourceRevision,
          "--controller-run",
          input.controllerRun,
          "--output",
          output,
        ],
        { encoding: "utf8", timeout: 10000, windowsHide: true },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const capturedBytes = fs.readFileSync(output);
      assert.equal(result.stdout.trim(), createHash("sha256").update(capturedBytes).digest("hex"));
      assert.deepEqual(JSON.parse(capturedBytes.toString("utf8")), captured);
    }
    assert.equal(captured.sources.length, 5);
    assert.equal(captured.classification, `independent-${agent}-launcher-source-snapshot`);
    assert.throws(() =>
      validateLauncherArtifactSourceSnapshot({
        agent: agent === "hermes" ? "openclaw" : "hermes",
        bytes: Buffer.from(JSON.stringify(captured)),
        sha256: createHash("sha256").update(JSON.stringify(captured)).digest("hex"),
        sourceRevision: input.artifactSourceRevision,
        controllerSourceRevision: input.controllerSourceRevision,
        controllerRun: input.controllerRun,
      }),
    );
    assert.notEqual(captured.artifactSourceRevision, captured.controllerSourceRevision);
    const original = fs.readFileSync(path.join(launcher, "src/main.rs"));
    fs.writeFileSync(path.join(launcher, "src/main.rs"), "modified\n");
    assert.throws(() => capture(input), /authorized Git tree/);
    fs.writeFileSync(path.join(launcher, "src/main.rs"), original);
    fs.unlinkSync(path.join(launcher, "src/main.rs"));
    assert.throws(() => capture(input), /missing/);
    fs.writeFileSync(path.join(launcher, "src/main.rs"), original);
    const unexpected = path.join(launcher, "untracked.rs");
    fs.writeFileSync(unexpected, "untracked\n");
    assert.throws(() => capture(input), /unexpected file/);
    fs.unlinkSync(unexpected);
    fs.mkdirSync(path.join(launcher, "target"));
    assert.throws(() => capture(input), /generated output/);
    fs.rmdirSync(path.join(launcher, "target"));
    assert.throws(() => capture({ ...input, artifactSourceRevision: "a".repeat(40) }));
    assert.throws(() => capture({ ...input, controllerSourceRevision: "b".repeat(40) }));
    assert.throws(
      () => capture({ ...input, artifactSourceRoot: controller }),
      /separate checkouts/,
    );
    const alias = path.join(launcher, "hardlink.rs");
    fs.linkSync(path.join(launcher, "src/main.rs"), alias);
    assert.throws(() => capture(input));
    fs.unlinkSync(alias);
    assert.deepEqual(capture(input), captured);
    const bytes = Buffer.from(JSON.stringify(captured));
    const snapshot = {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sourceRevision: input.artifactSourceRevision,
      controllerSourceRevision: input.controllerSourceRevision,
      controllerRun: input.controllerRun,
    };
    assert.equal(validate(snapshot).size, 5);
    fs.writeFileSync(path.join(launcher, "src/main.rs"), "changed after capture\n");
    assert.equal(validate(snapshot).size, 5);
  });

test("source snapshots reject changes, foreign identities and malformed inventories", () => {
  const fixture = inspectionOpenClawFixture().input;
  const input = {
    bytes: fixture.artifactSourceSnapshotBytes,
    sha256: fixture.artifactSourceSnapshotSha256,
    sourceRevision: fixture.sourceRevision,
    controllerSourceRevision: fixture.controllerSourceRevision,
    controllerRun: fixture.controllerRun,
  };
  const original = JSON.parse(input.bytes.toString("utf8"));
  for (const mutate of [
    (v: any) => {
      v.artifactSourceRevision = "b".repeat(40);
    },
    (v: any) => {
      v.controllerSourceRevision = "c".repeat(40);
    },
    (v: any) => {
      v.controllerRun = "122:1";
    },
    (v: any) => {
      v.invocationAdmitted = true;
    },
    (v: any) => {
      v.sources.pop();
      v.sources.pop();
    },
    (v: any) => {
      v.sources.push(v.sources[0]);
    },
    (v: any) => {
      v.sources[0].file = "packaging/windows/launcher/../secret.rs";
    },
    (v: any) => {
      v.sources[0].bytes = 0;
    },
    (v: any) => {
      v.sources[0].bytes = "1";
    },
    (v: any) => {
      v.sources[0].sha256 = "bad";
    },
    (v: any) => {
      v.sources[0].execute = true;
    },
  ]) {
    const document = structuredClone(original);
    mutate(document);
    const bytes = Buffer.from(JSON.stringify(document));
    assert.throws(() =>
      validateOpenClawArtifactSourceSnapshot({
        ...input,
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
  }
  assert.throws(() =>
    validateOpenClawArtifactSourceSnapshot({ ...input, bytes: Buffer.from("{}") }),
  );
});

test("the browser RPC uses the connected OpenClaw9.2 snapshot and rejects stale clients", async () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const request = new Function(
    `return (${requestVisibleGateway.toString()});`,
  )() as typeof requestVisibleGateway;
  const params = { agentId: "main", includePlugins: true };
  const result = { agentId: "main", groups: [] };
  const calls: unknown[][] = [];
  const client = {
    async request(method: string, input: unknown) {
      calls.push([method, input]);
      return result;
    },
  };
  let app: unknown;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelector(selector: string) {
        assert.equal(selector, "openclaw-app");
        return app;
      },
    },
  });
  try {
    for (const snapshot of [
      undefined,
      { connected: true, client },
      { phase: "connected", client: null },
      ...["stopped", "connecting", "reconnecting", "offline", "reload-required"].map((phase) => ({
        phase,
        connected: true,
        client,
      })),
    ]) {
      app = { context: { gateway: { snapshot } } };
      await assert.rejects(request({ method: "tools.catalog", params }), /disconnected/u);
    }
    app = null;
    await assert.rejects(request({ method: "tools.catalog", params }), /disconnected/u);
    assert.deepEqual(calls, []);
    app = { context: { gateway: { snapshot: { phase: "connected", client } } } };
    assert.equal(await request({ method: "tools.catalog", params }), result);
    assert.deepEqual(calls, [["tools.catalog", params]]);
    assert.equal(calls[0][1], params);
    const failure = new Error("actual gateway request failed");
    client.request = async () => {
      throw failure;
    };
    await assert.rejects(request({ method: "chat.history", params }), (error) => error === failure);
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("an enabled composer waits for its actual session identity", () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const oldTextarea = Object.getOwnPropertyDescriptor(globalThis, "HTMLTextAreaElement");
  class Textarea {
    disabled = false;
  }
  const input = new Textarea();
  const shell: { activeSessionKey?: string } = {};
  Object.defineProperty(globalThis, "HTMLTextAreaElement", { configurable: true, value: Textarea });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelector: (selector: string) => (selector === "openclaw-app-shell" ? shell : input),
    },
  });
  try {
    assert.equal(visibleChatReady(), false);
    shell.activeSessionKey = "agent:other:main";
    assert.equal(visibleChatReady(), false);
    shell.activeSessionKey = "agent:main:main";
    assert.equal(visibleChatReady(), true);
    input.disabled = true;
    assert.equal(visibleChatReady(), false);
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (oldTextarea) Object.defineProperty(globalThis, "HTMLTextAreaElement", oldTextarea);
    else Reflect.deleteProperty(globalThis, "HTMLTextAreaElement");
  }
});

test("only the intended dashboard path accepts its session query", () => {
  assert.equal(
    exactChatAddress(
      "http://127.0.0.1:32145/chat?session=agent%3Amain%3Amain",
      "http://127.0.0.1:32145",
    ),
    true,
  );
});
for (const address of [
  "http://localhost:32145/chat",
  "http://127.0.0.1:32146/chat",
  "http://127.0.0.1:32145/chat/",
  "http://127.0.0.1:32145/login",
  "https://127.0.0.1:32145/chat",
  "http://user@127.0.0.1:32145/chat",
])
  test("the browser rejects a different origin or route: " + address, () => {
    assert.equal(exactChatAddress(address, "http://127.0.0.1:32145"), false);
  });

test("provider and credential environment is absent from application children", () => {
  assert.deepEqual(
    childEnvironment({
      SystemRoot: "C:\\Windows",
      PATH: "owned",
      GITHUB_ACTIONS: "true",
      NVIDIA_API_KEY: "private",
      NVIDIA_INFERENCE_API_KEY: "private",
      TAVILY_API_KEY: "private",
      NODE_OPTIONS: "unreviewed",
      NODE_PATH: "source-shadow",
      NEMOCLAW_NATIVE_RUNTIME_ROOT: "unreviewed",
    }),
    { SystemRoot: "C:\\Windows", PATH: "owned", GITHUB_ACTIONS: "true" },
  );
});

test("effective tools retain actual IDs from the selected gateway agent", () => {
  assert.deepEqual(
    toolIds({ agentId: "main", groups: [{ tools: [{ id: "exec" }, { id: "read" }] }] }),
    ["exec", "read"],
  );
});
for (const value of [
  { agentId: "foreign", groups: [] },
  { agentId: "main", groups: null },
  { agentId: "main", groups: [{ tools: [{ id: null }] }] },
])
  test("invalid effective-tool identities fail", () => assert.throws(() => toolIds(value)));

test("actual completed tool output carries its controlled result", () => {
  verifyToolOutput(
    {
      ok: true,
      output: {
        content: [{ type: "text", text: "sentinel:42" }],
        details: { status: "completed", exitCode: 0 },
      },
    },
    "sentinel:42",
  );
});
for (const value of [
  { ok: false, output: { content: [{ type: "text", text: "sentinel:42" }] } },
  { ok: true, output: { isError: true, content: [{ type: "text", text: "sentinel:42" }] } },
  {
    ok: true,
    output: { content: [{ type: "text", text: "sentinel:42" }], details: { exitCode: 1 } },
  },
  {
    ok: true,
    output: { content: [{ type: "text", text: "sentinel:42" }], details: { status: "running" } },
  },
  { ok: true, output: { content: [{ type: "text", text: "different" }] } },
])
  test("a rejected, failed, incomplete or incorrect tool result cannot qualify", () =>
    assert.throws(() => verifyToolOutput(value, "sentinel:42")));

const call = {
  role: "assistant",
  content: [
    { type: "toolCall", id: "call-owned", name: "exec", arguments: { command: "exact command" } },
  ],
};
for (const name of ["write", "read"] as const) {
  const file = "owned-nonce.txt",
    content = "owned-content";
  const fileCall = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        name,
        id: "file-owned",
        arguments: { path: file, ...(name === "write" ? { content } : {}) },
      },
    ],
  };
  const fileResult = {
    role: "toolResult",
    toolName: name,
    toolCallId: "file-owned",
    isError: false,
    content: [
      { type: "text", text: name === "write" ? "Successfully wrote 13 bytes to " + file : content },
    ],
  };
  test(
    name + " proof requires exact agent arguments followed by its successful tool result",
    () => {
      assert.deepEqual(
        recordedFileTool({ messages: [fileCall, fileResult] }, name, file, content),
        fileResult,
      );
    },
  );
  for (const [label, messages] of [
    ["assistant claim", [fileCall, { ...fileResult, role: "assistant" }]],
    ["foreign call", [fileCall, { ...fileResult, toolCallId: "foreign" }]],
    [
      "foreign file",
      [
        {
          ...fileCall,
          content: [{ ...fileCall.content[0], arguments: { path: "foreign.txt", content } }],
        },
        fileResult,
      ],
    ],
    ["missing call", [fileResult]],
    ["result before call", [fileResult, fileCall]],
    ["failed tool", [fileCall, { ...fileResult, isError: true }]],
    ["wrong output", [fileCall, { ...fileResult, content: [{ type: "text", text: "different" }] }]],
  ] as const)
    test(name + " proof rejects " + label, () => {
      assert.throws(() => recordedFileTool({ messages: [...messages] }, name, file, content));
    });
  if (name === "write")
    test("a write of different content cannot qualify", () => {
      assert.throws(() =>
        recordedFileTool(
          {
            messages: [
              {
                ...fileCall,
                content: [
                  { ...fileCall.content[0], arguments: { path: file, content: "foreign" } },
                ],
              },
              fileResult,
            ],
          },
          name,
          file,
          content,
        ),
      );
    });
}
const result = {
  role: "toolResult",
  toolCallId: "call-owned",
  toolName: "exec",
  content: [{ type: "text", text: "sentinel:42" }],
  details: { exitCode: 0, status: "completed" },
};
test("shell proof requires the actual matching tool call and successful result", () => {
  assert.deepEqual(
    recordedExec({ messages: [call, result] }, "exact command", "sentinel:42"),
    result,
  );
});
for (const messages of [
  [call, { ...result, role: "assistant" }],
  [call, { ...result, toolCallId: "foreign" }],
  [call, { ...result, toolName: "read" }],
  [result],
  [call, { ...result, isError: true }],
  [call, { ...result, details: { exitCode: 1 } }],
])
  test("assistant claims, foreign calls and unsuccessful shell results fail", () => {
    assert.throws(() => recordedExec({ messages }, "exact command", "sentinel:42"));
  });

test("failure stacks and causes are retained with the provider key removed", () => {
  const secret = "nvapi-private-control";
  const cause = new Error("state lease release: " + secret);
  const primary = new Error("dashboard: " + secret, { cause });
  const result = sanitizedFailure(primary, secret);
  assert.equal(result.chain.length, 2);
  assert.ok(result.chain[0].stack?.includes("dashboard: [REDACTED]"));
  assert.ok(result.chain[1].stack?.includes("state lease release: [REDACTED]"));
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("cyclic and oversized diagnostic causes remain bounded", () => {
  const primary = new Error("x".repeat(100000));
  primary.cause = primary;
  const result = sanitizedFailure(primary, "");
  assert.equal(result.chain.length, 1);
  assert.equal(result.truncatedOrCyclicCause, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 9000);
});

test("a failure screenshot is awaited before cleanup can continue", async () => {
  const primary = new Error("original dashboard failure");
  let completed = false;
  const result = await captureFailure(
    primary,
    {
      async screenshot(options) {
        assert.equal(options.timeout, 5000);
        await new Promise((resolve) => setTimeout(resolve, 1));
        completed = true;
      },
    },
    "/owned/failure.png",
    "",
  );
  assert.equal(completed, true);
  assert.equal(result.screenshot, "failure.png");
  assert.equal(result.primary.chain[0].message, primary.message);
});

test("screenshot failure retains the original failure and a separate sanitized cause", async () => {
  const primary = new Error("original dashboard failure");
  const result = await captureFailure(
    primary,
    {
      async screenshot() {
        throw new Error("screenshot nvapi-private-control");
      },
    },
    "/owned/failure.png",
    "nvapi-private-control",
  );
  assert.equal(result.primary.chain[0].message, primary.message);
  assert.equal(result.screenshot, null);
  assert.equal(result.screenshotError?.chain[0].message, "screenshot [REDACTED]");
});

test("native diagnostic framing admits only the bounded canonical read and close reply", () => {
  const bytes = Buffer.from('{"owned":"ready"}');
  assert.deepEqual(
    decodeDiagnosticOwnerRead(`READY\nOK\t${bytes.toString("base64")}\nOK\n`),
    bytes,
  );
  assert.equal(decodeDiagnosticOwnerRead("READY\nMISS\nOK\n"), null);
  for (const value of [
    "READY\nOK\tYQ==\nOK",
    "READY\nOK\tYQ=\nOK\n",
    "READY\nERR\tread\nOK\n",
    "READY\nMISS\nOK\nextra\n",
  ])
    assert.throws(() => decodeDiagnosticOwnerRead(value));
  assert.throws(() =>
    decodeDiagnosticOwnerRead(
      `READY\nOK\t${Buffer.alloc(1024 * 1024 + 1).toString("base64")}\nOK\n`,
    ),
  );
});

test("native diagnostic retention copies and redacts closed documents before state removal", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installed-diagnostics-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const name = "session-diagnostics-" + "a".repeat(20);
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(root, "native-windows.json"), "must not read configuration");
  const data = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      classification: "native-session-success",
      agent: "openclaw",
      output: { gateway: "Bearer private-value\nknown-secret" },
    }),
  );
  fs.writeFileSync(path.join(directory, "ready"), data);
  const saved: { name: string; value: unknown }[] = [];
  const result = await retainNativeSessionDiagnostics(
    root,
    async (value) => {
      assert.equal(value, directory);
      return fs.readFileSync(path.join(value, "ready"));
    },
    (name, value) => {
      saved.push({ name, value });
    },
    "known-secret",
  );
  assert.equal(result.status, "retained");
  assert.equal(result.retained.length, 1);
  assert.equal(saved[0].name, "native-session-diagnostic-0.json");
  assert(!JSON.stringify(saved).includes("known-secret"));
  assert(!JSON.stringify(saved).includes("private-value"));
  assert.deepEqual(fs.readFileSync(path.join(directory, "ready")), data);
});

test("native diagnostic enumeration refuses linked directories and invalid documents", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installed-diagnostics-refuse-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "actual");
  fs.mkdirSync(target);
  const linked = path.join(root, "session-diagnostics-" + "b".repeat(20));
  fs.symlinkSync(target, linked, "junction");
  let reads = 0;
  await assert.rejects(
    retainNativeSessionDiagnostics(
      root,
      async () => {
        reads++;
        return null;
      },
      () => {},
      "",
    ),
  );
  assert.equal(reads, 0);
  fs.unlinkSync(linked);
  fs.mkdirSync(linked);
  await assert.rejects(
    retainNativeSessionDiagnostics(
      root,
      async () => Buffer.from("not JSON with private bytes"),
      () => {},
      "",
    ),
    /document is malformed/u,
  );
  await assert.rejects(
    retainNativeSessionDiagnostics(
      root,
      async () =>
        Buffer.from(
          JSON.stringify({ schemaVersion: 1, classification: "foreign", agent: "openclaw" }),
        ),
      () => {},
      "",
    ),
  );
});

const ownPrompt = "Reply exactly NEMOCLAW_NVIDIA_0123456789abcdef";
const ownUser = { role: "user", content: [{ type: "text", text: ownPrompt }] };
const actualMissing = "⚠️ Agent failed before reply: Cannot find module 'undici'";
test("terminal error keeps the actual cause after this exact fresh prompt", () => {
  assert.equal(
    terminalAgentError(
      {
        messages: [
          ownUser,
          { role: "assistant", stopReason: "error", errorMessage: "Cannot find module 'undici'" },
        ],
      },
      ownPrompt,
    ),
    "Cannot find module 'undici'",
  );
  assert.equal(
    terminalAgentError(
      {
        messages: [
          ownUser,
          { role: "assistant", content: [{ type: "text", text: actualMissing }] },
        ],
      },
      ownPrompt,
    ),
    actualMissing,
  );
});
test("earlier, unrelated, user and tool failures cannot end this reply wait", () => {
  const failure = { role: "assistant", stopReason: "error", errorMessage: "old" };
  for (const messages of [
    [failure, ownUser],
    [{ ...ownUser, content: "foreign" }, failure],
    [ownUser, { ...failure, role: "user" }],
    [ownUser, { ...failure, role: "toolResult" }],
    [ownUser, { role: "user", content: "later" }, failure],
  ]) {
    assert.equal(terminalAgentError({ messages }, ownPrompt), null);
  }
});
test("ordinary or incomplete assistant output is never a terminal failure", () => {
  for (const value of [
    null,
    {},
    { messages: [ownUser, { role: "assistant", content: "working" }] },
    { messages: [ownUser, { role: "assistant", stopReason: "error" }] },
  ])
    assert.equal(terminalAgentError(value, ownPrompt), null);
});

const projectedError = {
  role: "assistant",
  stopReason: "error",
  content: [{ type: "text", text: "The agent run failed before producing a reply." }],
};
test("canonical projected terminal errors retain failure without errorMessage", () => {
  assert.equal(
    terminalAgentError({ messages: [ownUser, projectedError] }, ownPrompt),
    projectedError.content[0].text,
  );
});
test("projected-error display prose alone cannot terminate an ordinary reply", () => {
  assert.equal(
    terminalAgentError(
      { messages: [ownUser, { ...projectedError, stopReason: "end_turn" }] },
      ownPrompt,
    ),
    null,
  );
});
test("projected terminal errors still require the exact current prompt", () => {
  for (const messages of [
    [projectedError, ownUser],
    [{ ...ownUser, content: "foreign" }, projectedError],
    [ownUser, { role: "user", content: "later" }, projectedError],
    [ownUser, { ...projectedError, role: "toolResult" }],
  ])
    assert.equal(terminalAgentError({ messages }, ownPrompt), null);
});

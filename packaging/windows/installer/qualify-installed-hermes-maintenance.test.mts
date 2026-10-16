// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { hermesTranscriptIdentity } from "./qualify-installed-hermes.mts";
import {
  validateHermesMaintenanceBaseline,
  runHermesMaintenanceSequence,
  verifyMaintenanceConversation,
  observeHermesMaintenanceProcess,
  validateHermesMaintenancePackageBytes,
  validateHermesMaintenanceCandidateContract,
  HERMES_MAINTENANCE_CANDIDATE_POLICY,
  hermesMaintenanceWindowsObserverSource,
  validateHermesInspectionHelperContract,
  validateHermesInspectionReadiness,
  validateHermesInspectionRelease,
  HERMES_INSPECTION_COMMAND,
  type MaintenanceBindings,
  type MaintenanceAction,
} from "./qualify-installed-hermes-maintenance.mts";

function inspectionFixture() {
  const { context } = candidateTrustFixture();
  const identity = { bytes: 50, sha256: "a".repeat(64) };
  return {
    context,
    transport: { kind: "actions-artifact" as const, artifactId: "789" },
    helper: identity,
    compiledLauncher: { ...identity },
    buildReceipt: { bytes: 500, sha256: "b".repeat(64) },
    commandSupportEvidence: { bytes: 600, sha256: "c".repeat(64) },
    command: HERMES_INSPECTION_COMMAND,
    arguments: ["--state-inspect", "hermes"],
    target: "aarch64-pc-windows-msvc",
    architecture: "arm64",
    features: ["immutable-runtime"],
    lockedDependencies: true,
    staticCrt: true,
    sources: [
      "src/main.rs",
      "src/state_session.rs",
      "src/runtime_lease.rs",
      "Cargo.toml",
      "Cargo.lock",
    ].map((file) => ({
      file: "packaging/windows/launcher/" + file,
      bytes: 10,
      sha256: "d".repeat(64),
    })),
  };
}

test("inspection contract requires package-selected launcher bytes and explicit source/build command evidence", () => {
  const expected = inspectionFixture();
  const result = validateHermesInspectionHelperContract(expected, structuredClone(expected));
  assert.equal(result.contractValidated, true);
  assert.equal(result.invocationAdmitted, false);
  assert.equal(result.authenticatedProducerImplemented, false);
  assert.deepEqual(result.arguments, ["--state-inspect", "hermes"]);
  assert.throws(() =>
    validateHermesInspectionHelperContract(expected, {
      immutableRuntime: true,
      guardianEnabled: true,
    } as any),
  );
});

test("inspection contract rejects missing support, changed helper/source/run/architecture and post-uninstall substitution", () => {
  for (const mutate of [
    (x: ReturnType<typeof inspectionFixture>) => {
      x.command = "native-state-session";
    },
    (x: ReturnType<typeof inspectionFixture>) => {
      x.arguments = ["--state-configure", "hermes"];
    },
    (x: ReturnType<typeof inspectionFixture>) => {
      x.helper.sha256 = "0".repeat(64);
    },
    (x: ReturnType<typeof inspectionFixture>) => {
      x.architecture = "x64";
    },
    (x: ReturnType<typeof inspectionFixture>) => {
      x.context.runId = "999";
    },
    (x: ReturnType<typeof inspectionFixture>) => {
      x.context.candidateRevision = "0".repeat(40);
    },
    (x: ReturnType<typeof inspectionFixture>) => {
      x.sources.pop();
    },
    (x: ReturnType<typeof inspectionFixture>) => {
      x.sources[0].sha256 = "0".repeat(64);
    },
    (x: ReturnType<typeof inspectionFixture>) => {
      x.lockedDependencies = false;
    },
  ]) {
    const expected = inspectionFixture();
    const observed = structuredClone(expected);
    mutate(observed);
    assert.throws(() => validateHermesInspectionHelperContract(expected, observed));
  }
});

test("inspection readiness refuses absent, wrong-agent/root, creating and malformed leases", () => {
  const root = fixture().input.acceptance.results.stateRoot;
  const value = {
    schemaVersion: 1,
    kind: "native-state-inspection",
    agent: "hermes",
    stateRoot: root,
    present: true,
    leaseHeld: true,
  };
  assert.equal(validateHermesInspectionReadiness(value, root).present, true);
  for (const change of [
    { present: false },
    { present: "true" },
    { agent: "openclaw" },
    { stateRoot: root + "-foreign" },
    { leaseHeld: false },
    { kind: "native-state-session" },
    { created: true },
  ])
    assert.throws(() => validateHermesInspectionReadiness({ ...value, ...change }, root));
});

test("inspection release requires the same held helper generation and normal confirmed EOF closure", () => {
  const expected = { processId: 123, creationFileTime: "133000000000000000" };
  const value = {
    ...expected,
    releaseRequested: true,
    exitConfirmed: true,
    exitCode: 0,
    signalCode: null,
    forced: false,
    outputTruncated: false,
  };
  assert.equal(validateHermesInspectionRelease(value, expected).ownerClosed, true);
  for (const change of [
    { processId: 124 },
    { creationFileTime: "133000000000000001" },
    { exitConfirmed: false },
    { releaseRequested: false },
    { exitCode: 1 },
    { signalCode: "SIGTERM" },
    { forced: true },
    { outputTruncated: true },
  ])
    assert.throws(() => validateHermesInspectionRelease({ ...value, ...change }, expected));
});

test(
  "maintenance observer parses in actual PowerShell without executing Windows inspection",
  {
    skip: !process.env.NEMOCLAW_TEST_PWSH && process.platform !== "win32",
  },
  () => {
    const parse =
      "$source=[Console]::In.ReadToEnd();$tokens=$null;$errors=$null;$null=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Observer syntax invalid'};[Console]::WriteLine('parsed')";
    const result = spawnSync(
      process.env.NEMOCLAW_TEST_PWSH ?? "pwsh.exe",
      ["-NoProfile", "-NonInteractive", "-Command", parse],
      {
        input: hermesMaintenanceWindowsObserverSource(),
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 65536,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "parsed");
  },
);

function candidateTrustFixture() {
  const x = packageFixture();
  const context = {
    repository: "NVIDIA/NemoClaw",
    workflow: ".github/workflows/windows-native-installer-v2.yaml",
    runId: "123",
    runAttempt: "1",
    transport: { kind: "actions-artifact" as const, artifactId: "456" },
    controllerRevision: "0".repeat(40),
    candidateRevision: x.pins.sourceRevision,
    observerSha256: "9".repeat(64),
  };
  const authorization = {
    ...context,
    policyId: HERMES_MAINTENANCE_CANDIDATE_POLICY,
    purpose: "internal-candidate-maintenance-qualification",
    buildReceipt: x.pins.buildReceipt,
    assemblyReceipt: x.pins.assemblyReceipt,
  };
  const packageIdentity = validateHermesMaintenancePackageBytes(
    x.pins,
    x.buildBytes,
    x.assemblyBytes,
    x.files,
  );
  const observations = x.files.map((file) => ({
    ...file,
    controllerRevision: context.controllerRevision,
    controllerRun: "123:1",
    observerSha256: context.observerSha256,
    signatureStatus: "NotSigned",
    signerSubject: null as string | null,
    productVersion: "0.1.10",
    productMetadataVerified: true,
  }));
  return { ...x, context, authorization, packageIdentity, observations };
}

test("explicit unsigned-candidate contract never implies authenticated provenance or customer acceptance", () => {
  const x = candidateTrustFixture();
  const result = validateHermesMaintenanceCandidateContract(
    x.context,
    x.authorization,
    x.pins,
    x.packageIdentity,
    x.observations,
  );
  assert.equal(result.contractValidated, true);
  assert.equal(result.installationAdmitted, false);
  assert.equal(result.customerDownloadAcceptance, false);
  assert.equal(result.releaseAcceptance, false);
  assert.equal(result.authenticatedProvenanceProducerImplemented, false);
  assert.equal(result.windowsObserverSourceImplemented, true);
  assert.equal(result.windowsObserverIntegrated, false);
});

test("unsigned policy rejects missing, failed, signed, foreign, changed-byte or Edge signature observations", () => {
  for (const status of [
    "Valid",
    "HashMismatch",
    "NotTrusted",
    "UnknownError",
    "NotSupportedFileFormat",
    "",
  ]) {
    const x = candidateTrustFixture();
    x.observations[0].signatureStatus = status;
    assert.throws(
      () =>
        validateHermesMaintenanceCandidateContract(
          x.context,
          x.authorization,
          x.pins,
          x.packageIdentity,
          x.observations,
        ),
      status,
    );
  }
  for (const change of [
    (x: ReturnType<typeof candidateTrustFixture>) => {
      x.observations.pop();
    },
    (x: ReturnType<typeof candidateTrustFixture>) => {
      x.observations[0].file = "msedge.exe";
    },
    (x: ReturnType<typeof candidateTrustFixture>) => {
      x.observations[0].sha256 = "8".repeat(64);
    },
    (x: ReturnType<typeof candidateTrustFixture>) => {
      x.observations[0].controllerRun = "124:1";
    },
    (x: ReturnType<typeof candidateTrustFixture>) => {
      x.observations[0].observerSha256 = "8".repeat(64);
    },
    (x: ReturnType<typeof candidateTrustFixture>) => {
      x.observations[0].signerSubject = "Microsoft Corporation";
    },
    (x: ReturnType<typeof candidateTrustFixture>) => {
      x.observations[0].productMetadataVerified = false;
    },
    (x: ReturnType<typeof candidateTrustFixture>) => {
      x.observations[0].productVersion = "0.1.9";
    },
  ]) {
    const x = candidateTrustFixture();
    change(x);
    assert.throws(() =>
      validateHermesMaintenanceCandidateContract(
        x.context,
        x.authorization,
        x.pins,
        x.packageIdentity,
        x.observations,
      ),
    );
  }
});

test("unsigned candidate policy cannot self-authorize a different controller, source or receipt pin", () => {
  for (const field of [
    "policyId",
    "purpose",
    "repository",
    "workflow",
    "runId",
    "runAttempt",
    "transport",
    "controllerRevision",
    "candidateRevision",
  ]) {
    const x = candidateTrustFixture();
    (x.authorization as any)[field] = "foreign";
    assert.throws(
      () =>
        validateHermesMaintenanceCandidateContract(
          x.context,
          x.authorization,
          x.pins,
          x.packageIdentity,
          x.observations,
        ),
      field,
    );
  }
  const x = candidateTrustFixture();
  x.authorization.buildReceipt = { bytes: 1, sha256: "8".repeat(64) };
  assert.throws(() =>
    validateHermesMaintenanceCandidateContract(
      x.context,
      x.authorization,
      x.pins,
      x.packageIdentity,
      x.observations,
    ),
  );
});

function packageFixture() {
  const { input } = fixture();
  const files = [
    { file: "NemoClaw-0.1.10-windows-arm64.msi", bytes: 40, sha256: "e".repeat(64) },
    { file: "NemoClawSetup-0.1.10-windows-arm64.exe", bytes: 50, sha256: "f".repeat(64) },
  ];
  const build = {
    schemaVersion: 1,
    classification: "finished-native-runtime-package-build",
    status: "candidate-built-for-installed-qualification",
    sourceRevision: input.runtime.sourceRevision,
    runtime: input.runtime,
    files,
  };
  const assembly = {
    schemaVersion: 1,
    classification: "windows-immutable-runtime-assembly",
    deliveryContract: "finished-native-app-v1",
    buildCompleteForSelectedAgents: true,
    runtime: input.runtime,
    agents: [{ agent: "hermes" }],
  };
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
  const identity = (value: Buffer) => ({
    bytes: value.length,
    sha256: createHash("sha256").update(value).digest("hex"),
  });
  const buildBytes = bytes(build),
    assemblyBytes = bytes(assembly);
  const pins = {
    sourceRevision: input.runtime.sourceRevision,
    productVersion: "0.1.10",
    runtime: input.runtime,
    buildReceipt: identity(buildBytes),
    assemblyReceipt: identity(assemblyBytes),
  };
  return {
    pins,
    build,
    assembly,
    buildBytes,
    assemblyBytes,
    files: structuredClone(files),
    bytes,
    identity,
  };
}

test("maintenance package byte binding uses actual producer schemas without claiming signer or installer admission", () => {
  const x = packageFixture();
  const result = validateHermesMaintenancePackageBytes(
    x.pins,
    x.buildBytes,
    x.assemblyBytes,
    x.files,
  );
  assert.equal(result.byteIdentitiesBound, true);
  assert.equal(result.signerQualified, false);
  assert.equal(result.productMetadataVerified, false);
  assert.equal(result.installationAdmitted, false);
});

test("maintenance package binding rejects changed receipt bytes despite matching receipt-only claims", () => {
  const x = packageFixture();
  assert.throws(() =>
    validateHermesMaintenancePackageBytes(
      x.pins,
      Buffer.concat([x.buildBytes, Buffer.from(" ")]),
      x.assemblyBytes,
      x.files,
    ),
  );
  assert.throws(() =>
    validateHermesMaintenancePackageBytes(
      x.pins,
      x.buildBytes,
      Buffer.concat([x.assemblyBytes, Buffer.from(" ")]),
      x.files,
    ),
  );
  x.files[0].sha256 = "0".repeat(64);
  assert.throws(() =>
    validateHermesMaintenancePackageBytes(x.pins, x.buildBytes, x.assemblyBytes, x.files),
  );
});

test("maintenance package binding rejects foreign agents, source/runtime changes, duplicate or redirected files and wrong versions", () => {
  for (const kind of [
    "agent",
    "extra-agent",
    "source",
    "runtime",
    "duplicate",
    "redirect",
    "version",
    "status",
    "size",
  ]) {
    const x = packageFixture();
    if (kind === "agent") x.assembly.agents[0].agent = "openclaw";
    if (kind === "extra-agent") x.assembly.agents.push({ agent: "openclaw" });
    if (kind === "source") x.build.sourceRevision = "0".repeat(40);
    if (kind === "runtime")
      x.assembly.runtime = { ...x.assembly.runtime, runtimeId: "0".repeat(64) };
    if (kind === "duplicate") x.build.files[1] = { ...x.build.files[0] };
    if (kind === "redirect") x.build.files[0].file = "../NemoClaw-0.1.10-windows-arm64.msi";
    if (kind === "version") x.pins.productVersion = "0.1.11";
    if (kind === "status") x.build.status = "failed";
    if (kind === "size") x.files[0].bytes++;
    const buildBytes = x.bytes(x.build),
      assemblyBytes = x.bytes(x.assembly);
    x.pins.buildReceipt = x.identity(buildBytes);
    x.pins.assemblyReceipt = x.identity(assemblyBytes);
    assert.throws(
      () => validateHermesMaintenancePackageBytes(x.pins, buildBytes, assemblyBytes, x.files),
      kind,
    );
  }
});

test("maintenance process deadline never kills the owned fixture or overlaps another operation", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  try {
    const observation = await observeHermesMaintenanceProcess(child, 50);
    assert.equal(observation.processId, child.pid);
    assert.equal(observation.processExitConfirmed, false);
    assert.equal(observation.failure, "deadline");
    assert.equal(child.killed, false);
    assert.equal(child.exitCode, null);
  } finally {
    // Only this test-owned Node fixture is killed, never an installer transaction.
    const closed = once(child, "close");
    child.kill();
    await closed;
  }
});

test("maintenance process observation records actual owned process closure and nonzero status", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
  const observation = await observeHermesMaintenanceProcess(child, 5000);
  assert.equal(observation.processExitConfirmed, true);
  assert.equal(observation.exitCode, 7);
  assert.equal(observation.signalCode, null);
  assert.equal(observation.failure, null);
  assert.equal(child.killed, false);
});

function fixture() {
  const configuration = JSON.stringify({ agent: "hermes", model: "selected/model" });
  const messages = [
    { id: 1, role: "user", content: "real conversation fixture" },
    { id: 2, role: "assistant", content: "completed fixture" },
  ];
  const conversation = hermesTranscriptIdentity("saved-session", "default", messages);
  const runtime = {
    runtimeId: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    sourceRevision: "c".repeat(40),
    nodeSha256: "d".repeat(64),
    nodeVersion: "22.23.2",
  };
  const stateRoot = "C:\\NemoClawState-S-1-5-21-1-2-3-1001-hermes";
  const acceptance = {
    schemaVersion: 1,
    classification: "installed-canonical-hermes-acceptance",
    verdict: "pass",
    controllerRun: "123:1",
    runtime,
    cleanupErrors: [],
    results: {
      configurationReused: false,
      configurationPreserved: true,
      configurationSha256: createHash("sha256").update(configuration).digest("hex"),
      stateRoot,
      dashboardModel: "selected/model",
      configuration: { nativeOnboardingUsed: true },
      cleanup: { cleanupSucceeded: true, stateRetained: true },
      nvidia: { value: { role: "assistant", content: "NEMOCLAW_NVIDIA_" + "1".repeat(20) } },
      toolsScope: { executeCodeToolBootstrap: true, fileWriteReadDeleteViaTerminal: true },
      browserToolScope: { localBundledBrowserExecuted: false },
      retainedConversation: conversation,
    },
  };
  return { input: { acceptance, runtime, configuration, controllerRun: "123:1" }, messages };
}

function bindings(input: ReturnType<typeof fixture>["input"]) {
  const calls: string[] = [];
  let reply = 1;
  const snapshot = {
    stateRoot: input.acceptance.results.stateRoot,
    configurationSha256: input.acceptance.results.configurationSha256,
    historySha256: "f".repeat(64),
    inspectionOwnerClosed: true,
    runtimeOwnerClosed: true,
    applicationProcessesClosed: true,
  };
  const api: MaintenanceBindings = {
    async verifyPrerequisites() {
      calls.push("prerequisites");
    },
    async checkpoint() {
      calls.push("checkpoint");
      return { ...snapshot };
    },
    async transact(action) {
      calls.push(action);
      return { completion: "confirmed", exitCode: 0, elapsedMs: 10 };
    },
    async verifyInstallation(present) {
      calls.push("installed:" + present);
    },
    async warm(previous) {
      calls.push("warm");
      const value: any = structuredClone(previous);
      value.results.configurationReused = true;
      value.results.restoredConversation = structuredClone(value.results.retainedConversation);
      value.results.nvidia.value.content = "NEMOCLAW_NVIDIA_" + String(++reply).repeat(20);
      value.results.retainedConversation.messageCount += 2;
      value.results.retainedConversation.lastMessageId += 2;
      value.results.retainedConversation.transcriptSha256 = createHash("sha256")
        .update(value.results.nvidia.value.content)
        .digest("hex");
      return value;
    },
  };
  return { api, calls, snapshot };
}

test("maintenance baseline binds the cold runtime/configuration and completed transcript", () => {
  const { input, messages } = fixture();
  const baseline = validateHermesMaintenanceBaseline(input);
  assert.equal(baseline.selectedModel, "selected/model");
  assert.deepEqual(
    verifyMaintenanceConversation(baseline, { session_id: "saved-session", messages }),
    baseline.conversation,
  );
  assert.throws(() =>
    verifyMaintenanceConversation(baseline, {
      session_id: "saved-session",
      messages: messages.slice(0, 1),
    }),
  );
});

test("maintenance rejects foreign, failed, unpreserved, changed-runtime and synthetic-provider receipts", () => {
  for (const mutate of [
    (x: any) => {
      x.acceptance.classification = "finished-package-smoke";
    },
    (x: any) => {
      x.acceptance.verdict = "fail";
    },
    (x: any) => {
      x.acceptance.results.configurationPreserved = false;
    },
    (x: any) => {
      x.acceptance.results.configurationReused = true;
    },
    (x: any) => {
      x.controllerRun = "999:1";
    },
    (x: any) => {
      x.runtime = { ...x.runtime, runtimeId: "e".repeat(64) };
    },
    (x: any) => {
      x.acceptance.results.nvidia.value.content = "NATIVE_HERMES_OK";
    },
    (x: any) => {
      delete x.acceptance.results.retainedConversation;
    },
    (x: any) => {
      x.acceptance.results.dashboardModel = "other/model";
    },
    (x: any) => {
      x.acceptance.results.cleanup.cleanupSucceeded = false;
    },
  ]) {
    const { input } = fixture();
    mutate(input);
    assert.throws(() => validateHermesMaintenanceBaseline(input));
  }
});

test("maintenance carries the completed repair conversation into reinstall qualification", async () => {
  const { input } = fixture();
  const { api } = bindings(input);
  const original = api.warm;
  let expected: Record<string, any> = input.acceptance;
  let calls = 0;
  api.warm = async (previous) => {
    assert.deepEqual(
      previous,
      expected,
      "Each warm launch must receive the latest completed receipt",
    );
    expected = await original(previous);
    calls++;
    return expected;
  };
  const receipt = await runHermesMaintenanceSequence(input, api);
  assert.equal(receipt.failure, null);
  assert.equal(calls, 2);
  assert.equal(
    expected.results.retainedConversation.messageCount,
    input.acceptance.results.retainedConversation.messageCount + 4,
  );
});

test("maintenance rejects stale or changed continuation evidence at either checkpoint", async () => {
  for (const afterRepair of [false, true]) {
    for (const kind of [
      "restored",
      "session",
      "profile",
      "count",
      "last",
      "hash",
      "state",
      "configuration",
      "model",
    ]) {
      const { input } = fixture();
      const { api, calls } = bindings(input);
      const original = api.warm;
      let count = 0;
      api.warm = async (previous) => {
        const result = await original(previous);
        if (++count !== (afterRepair ? 2 : 1)) return result;
        const retained = result.results.retainedConversation;
        switch (kind) {
          case "restored":
            result.results.restoredConversation.transcriptSha256 = "0".repeat(64);
            break;
          case "session":
            retained.storedSessionId = "other-session";
            break;
          case "profile":
            retained.profileName = "other-profile";
            break;
          case "count":
            retained.messageCount = previous.results.retainedConversation.messageCount;
            break;
          case "last":
            retained.lastMessageId = previous.results.retainedConversation.lastMessageId;
            break;
          case "hash":
            retained.transcriptSha256 = previous.results.retainedConversation.transcriptSha256;
            break;
          case "state":
            result.results.stateRoot = "C:\\foreign";
            break;
          case "configuration":
            result.results.configurationSha256 = "0".repeat(64);
            break;
          case "model":
            result.results.dashboardModel = "other/model";
            break;
        }
        return result;
      };
      const receipt = await runHermesMaintenanceSequence(input, api);
      assert(receipt.failure, `${afterRepair}/${kind}`);
      assert.equal(receipt.failedStage, "warm-qualification");
      assert.equal(receipt.uninstallReinstall, "unqualified");
      assert.equal(receipt.repair, afterRepair ? "sequence-verified" : "unqualified");
      assert.equal(calls.at(-1), "warm");
    }
  }
});

test("repair and default-uninstall/reinstall checkpoints precede replies without claiming live qualification", async () => {
  const { input } = fixture();
  const { api, calls } = bindings(input);
  const receipt = await runHermesMaintenanceSequence(input, api);
  assert.equal(receipt.failure, null);
  assert.deepEqual(calls, [
    "prerequisites",
    "checkpoint",
    "repair",
    "installed:true",
    "checkpoint",
    "warm",
    "checkpoint",
    "uninstall",
    "installed:false",
    "checkpoint",
    "reinstall",
    "installed:true",
    "checkpoint",
    "warm",
  ]);
  assert.equal(receipt.upgrade, "unqualified-no-bound-package-pair");
  assert.equal(receipt.maintenanceAcceptance, false);
  assert.equal(receipt.liveBindingsImplemented, false);
  assert.equal(receipt.dataRemovalRequested, false);
});

for (const action of ["repair", "uninstall", "reinstall"] as MaintenanceAction[])
  test(
    "unconfirmed " +
      action +
      " stops all subsequent operations without a retry or cleanup transaction",
    async () => {
      const { input } = fixture();
      const { api, calls } = bindings(input);
      const original = api.transact;
      api.transact = async (value) =>
        value === action
          ? (calls.push(value), { completion: "unconfirmed", exitCode: null, elapsedMs: 30 })
          : original(value);
      const receipt = await runHermesMaintenanceSequence(input, api);
      assert.match(receipt.failure!, /unconfirmed/u);
      assert.equal(calls.at(-1), action);
      assert.equal(calls.filter((value) => value === action).length, 1);
      assert.equal(receipt.maintenanceAcceptance, false);
    },
  );

test("lost transaction observation retains unconfirmed status and excludes raw callback errors", async () => {
  const { input } = fixture();
  const { api, calls } = bindings(input);
  api.transact = async (action) => {
    calls.push(action);
    throw new Error("private-token-canary");
  };
  const receipt = await runHermesMaintenanceSequence(input, api);
  assert.match(receipt.failure!, /unconfirmed/u);
  assert.equal(receipt.failedStage, "repair");
  assert(!JSON.stringify(receipt).includes("private-token-canary"));
  assert.equal(calls.at(-1), "repair");
});

test("lost leases, changed retained bytes, absent helper, failed installation and reused replies remain failures", async () => {
  for (const kind of ["lease", "history", "helper", "transaction", "installation", "reply"]) {
    const { input } = fixture();
    const { api, calls } = bindings(input);
    if (kind === "lease")
      api.checkpoint = async () => ({
        stateRoot: input.acceptance.results.stateRoot,
        configurationSha256: "a".repeat(64),
        historySha256: "f".repeat(64),
        inspectionOwnerClosed: false,
        runtimeOwnerClosed: true,
        applicationProcessesClosed: true,
      });
    if (kind === "history") {
      const original = api.checkpoint;
      let count = 0;
      api.checkpoint = async () => ({
        ...(await original()),
        historySha256: (++count === 1 ? "a" : "b").repeat(64),
      });
    }
    if (kind === "helper")
      api.verifyPrerequisites = async () => {
        throw new Error("Native inspection helper unavailable");
      };
    if (kind === "transaction")
      api.transact = async () => ({ completion: "confirmed", exitCode: 1603, elapsedMs: 10 });
    if (kind === "installation")
      api.verifyInstallation = async () => {
        throw new Error("Registration still present");
      };
    if (kind === "reply")
      api.warm = async () => ({
        ...input.acceptance,
        results: {
          ...input.acceptance.results,
          configurationReused: true,
          restoredConversation: input.acceptance.results.retainedConversation,
        },
      });
    const receipt = await runHermesMaintenanceSequence(input, api);
    assert(receipt.failure, kind);
    assert.equal(receipt.maintenanceAcceptance, false);
    assert(!calls.includes("uninstall"), kind);
  }
});

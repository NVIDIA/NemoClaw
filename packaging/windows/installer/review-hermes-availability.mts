// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Only an independently approved protected controller may use this decision.
// Document validation does not authenticate a run or approve a final installer.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { validateLauncherArtifactSourceSnapshot } from "./installed-launcher-admission.mts";
import {
  hermesInstalledCodeCommand,
  hermesInstalledToolCommand,
  hermesResumeChatRoute,
  validateHermesEdgeReceipt,
} from "./qualify-installed-hermes.mts";
import { readAvailabilityDocuments } from "./runtime-availability-evidence.mts";

const object = (value: unknown): Record<string, unknown> => {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  assert.equal(typeof value, "string");
  return value as string;
};
const hash = (value: unknown) => assert.match(text(value), /^[a-f0-9]{64}$/u);
const boundedTime = (value: unknown, limit: number) => {
  assert(typeof value === "number" && Number.isFinite(value) && value >= 0 && value < limit);
};

function conversation(value: unknown) {
  const row = object(value);
  hermesResumeChatRoute(row);
  for (const key of ["storedSessionId", "profileName"])
    assert(text(row[key]).length > 0 && text(row[key]).length <= 128);
  assert(
    Number.isSafeInteger(row.messageCount) &&
      Number(row.messageCount) >= 2 &&
      Number(row.messageCount) < 500,
  );
  assert(
    Number.isSafeInteger(row.lastMessageId) &&
      Number(row.lastMessageId) >= Number(row.messageCount),
  );
  hash(row.transcriptSha256);
  return row;
}

function completedTurn(value: unknown) {
  const turn = object(value);
  boundedTime(turn.conversationElapsedMs, 120000);
  assert.equal(
    turn.measurement,
    "end-to-end conversation interval including model, tools and UI/protocol",
  );
  assert.equal(turn.isolatedProviderLatencyMs, null);
  return object(turn.value);
}

function validateCase(
  receipt: Record<string, unknown>,
  expected: {
    controllerRun: string;
    runtime: Record<string, unknown>;
    launcherAdmission: Record<string, unknown>;
  },
  cold?: Record<string, unknown>,
) {
  const warm = cold !== undefined;
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.classification, "installed-canonical-hermes-acceptance");
  assert.equal(receipt.verdict, "pass");
  assert.equal(receipt.failedStage, null);
  assert.equal(receipt.error, null);
  assert.equal(receipt.controllerRun, expected.controllerRun);
  assert.deepEqual(receipt.runtime, expected.runtime);
  assert.deepEqual(receipt.cleanupErrors, []);
  assert.equal(receipt.fullInstalledQualification, false);
  const results = object(receipt.results);
  assert.equal(results.runtimeBootstrap, true);
  assert.deepEqual(results.launcherAdmission, expected.launcherAdmission);
  assert.equal(results.configurationReused, warm);
  assert.equal(results.configurationPreserved, !warm);
  hash(results.configurationSha256);
  assert.match(text(results.stateRoot), /^[A-Z]:\\NemoClawState-S-1-(?:\d+-)*\d+-hermes$/u);
  assert(!Object.hasOwn(results, "nativeFailure") && !Object.hasOwn(results, "failedTurn"));
  assert.deepEqual(results.configuration, {
    reused: warm,
    configuredThisCase: !warm,
    nativeOnboardingUsed: false,
    searchRequested: false,
    messagingRequested: false,
  });
  assert(
    !Object.hasOwn(results, "onboarding"),
    "Runtime bootstrap cannot claim native onboarding.",
  );
  assert(text(results.dashboardModel).length > 0 && text(results.dashboardModel).length <= 256);
  for (const [key, value] of Object.entries(expected.runtime))
    assert.equal(object(results.runtime)[key], value);
  boundedTime(object(results.startup).usablePromptElapsedMs, 120000);
  const edge = object(results.edgeBrowser);
  assert.match(text(edge.sessionId), /^[a-f0-9]{10}$/u);
  validateHermesEdgeReceipt(edge, text(edge.sessionId));
  const reply = completedTurn(results.nvidia);
  assert.equal(reply.role, "assistant");
  const match = /^NEMOCLAW_NVIDIA_([a-f0-9]{20})$/u.exec(text(reply.content).trim());
  assert(match, "The real provider response lacks its current-turn sentinel.");
  const nonce = match[1];
  const tools = completedTurn(results.tools);
  const terminal = object(tools.terminal);
  const code = object(tools.executeCode);
  assert(text(terminal.toolCallId).length > 0 && text(code.toolCallId).length > 0);
  assert.equal(terminal.command, hermesInstalledToolCommand(nonce));
  assert.equal(code.code, hermesInstalledCodeCommand(nonce));
  for (const [record, sentinel] of [
    [terminal, "NEMOCLAW_TOOLS_"],
    [code, "NEMOCLAW_EXECUTE_CODE_"],
  ] as const) {
    const result = object(record.result);
    assert.equal(result.exit_code, 0);
    assert(result.error == null);
    assert(text(result.output).includes(sentinel + nonce));
  }
  const execution = object(code.result);
  assert.equal(execution.status, "success");
  assert(Number.isInteger(execution.tool_calls_made) && Number(execution.tool_calls_made) >= 1);
  const kernel = object(execution.kernel);
  assert.equal(kernel.mode, "session");
  assert(Number.isInteger(kernel.execution_count) && Number(kernel.execution_count) >= 1);
  assert.deepEqual(results.toolsScope, {
    bash: true,
    fileWriteReadDeleteViaTerminal: true,
    canonicalRipgrep: true,
    terminalPythonTemporaryCode: true,
    executeCodeToolBootstrap: true,
  });
  const browser = completedTurn(results.browserTool);
  assert(text(browser.toolCallId).length > 0);
  assert.equal(
    browser.code,
    [
      'expected="Example Domain"',
      "new_tab('https://example.com/')",
      "assert wait_for_element('h1', timeout=15.0, visible=True) is True",
      "actual=js(\"document.querySelector('h1').textContent\")",
      "assert actual == expected",
      "print(expected)",
    ].join("\n"),
  );
  assert.equal(object(browser.result).success, true);
  assert.equal(object(browser.result).exit_code, 0);
  assert(text(object(browser.result).output).includes("Example Domain"));
  assert.deepEqual(results.browserToolScope, {
    browser: "native-arm64-microsoft-edge",
    transport: "authenticated-session-cdp-relay",
    localBundledBrowserExecuted: false,
    visibleSentinel: "Example Domain",
  });
  const idle = object(results.idle);
  for (const [key, value] of Object.entries({
    schemaVersion: 1,
    classification: "installed-windows-idle-process-observation",
    status: "measured",
    error: null,
    agent: "hermes",
    stateRoot: results.stateRoot,
    acceptedAsIdle: true,
    applicationInstrumentationEnabled: false,
    requestedIdleMs: 30000,
    observerWorkBoundMs: 40000,
    observerCleanupBoundMs: 5000,
    qualificationClaim: false,
  }))
    assert.equal(idle[key], value);
  for (const key of ["runtimeId", "manifestSha256", "sourceRevision"])
    assert.equal(object(idle.runtime)[key], expected.runtime[key]);
  const custody = object(results.custody);
  for (const key of [
    "nativeLaunchAttempted",
    "nativeCleanupConfirmed",
    "processesStopped",
    "uninstallSafe",
  ])
    assert.equal(custody[key], true);
  for (const key of ["configurationMutationUnconfirmed", "configurationRetainedForRecovery"])
    assert.equal(custody[key], false);
  const cleanup = object(results.cleanup);
  assert.equal(cleanup.schemaVersion, 1);
  assert.equal(cleanup.classification, "native-hermes-dashboard-qualification");
  assert.equal(cleanup.agent, "hermes");
  for (const key of [
    "sandboxDeleted",
    "gatewayStopped",
    "ephemeralRootsRemoved",
    "stateRetained",
    "leaseReleased",
    "cleanupSucceeded",
    "guardianClosed",
    "observerClosed",
    "runtimeLeaseOwnerClosedWithGuardian",
  ])
    assert.equal(cleanup[key], true);
  for (const key of ["runtimeId", "manifestSha256", "sourceRevision"])
    assert.equal(object(cleanup.runtimeIdentity)[key], expected.runtime[key]);
  assert.equal(cleanup.runtimeCounterSource, "held-runtime-session");
  assert.equal(cleanup.runtimeBytesCopied, 0);
  assert.equal(cleanup.runtimeFilesHashedAtLaunch, 0);
  assert.equal(cleanup.retainedPrivateGatewayRoot, null);
  const retained = conversation(results.retainedConversation);
  if (cold) {
    const previous = object(cold.results);
    for (const key of ["stateRoot", "configurationSha256", "dashboardModel"])
      assert.equal(results[key], previous[key]);
    const restored = conversation(results.restoredConversation);
    const original = conversation(previous.retainedConversation);
    for (const key of [
      "storedSessionId",
      "profileName",
      "messageCount",
      "lastMessageId",
      "transcriptSha256",
    ])
      assert.equal(restored[key], original[key]);
    for (const key of ["storedSessionId", "profileName"])
      assert.equal(retained[key], original[key]);
    assert(Number(retained.messageCount) > Number(original.messageCount));
    assert(Number(retained.lastMessageId) > Number(original.lastMessageId));
    assert.notEqual(retained.transcriptSha256, original.transcriptSha256);
    assert.notEqual(
      text(reply.content).trim(),
      text(completedTurn(previous.nvidia).content).trim(),
    );
  }
}

export function reviewHermesAvailability(input: {
  evidenceRoot: string;
  evidenceManifestSha256: string;
  sourceRevision: string;
  controllerSourceRevision: string;
  controllerRun: string;
}) {
  assert.match(input.sourceRevision, /^[a-f0-9]{40}$/u);
  assert.match(input.controllerSourceRevision, /^[a-f0-9]{40}$/u);
  assert.match(input.controllerRun, /^[1-9]\d*:[1-9]\d*$/u);
  const document = readAvailabilityDocuments(input);
  const build = document("package/immutable-package-build.json");
  assert.equal(build.value.schemaVersion, 1);
  assert.equal(build.value.classification, "finished-native-runtime-package-build");
  assert.equal(build.value.sourceRevision, input.sourceRevision);
  assert.equal(build.value.status, "candidate-built-for-installed-qualification");
  assert.equal(build.value.installedAcceptance, false);
  assert.equal(build.value.activationAllowed, false);
  const runtime = object(build.value.runtime);
  assert.deepEqual(Object.keys(runtime).sort(), [
    "manifestSha256",
    "nodeSha256",
    "nodeVersion",
    "runtimeId",
    "sourceRevision",
  ]);
  for (const key of ["manifestSha256", "nodeSha256", "runtimeId"]) hash(runtime[key]);
  assert.equal(runtime.nodeVersion, "22.23.2");
  assert.equal(runtime.sourceRevision, input.sourceRevision);
  const launcher = document("package/launcher-build-inputs.json").value;
  assert.equal(launcher.classification, "package-selected-launcher-build-inputs");
  assert.equal(launcher.sourceRevision, input.sourceRevision);
  assert.equal(`${launcher.workflowRunId}:${launcher.workflowRunAttempt}`, input.controllerRun);
  const snapshot = document("hermes-artifact-source.json");
  validateLauncherArtifactSourceSnapshot({
    agent: "hermes",
    bytes: snapshot.bytes,
    sha256: snapshot.sha256,
    sourceRevision: input.sourceRevision,
    controllerSourceRevision: input.controllerSourceRevision,
    controllerRun: input.controllerRun,
  });
  const launcherSha256 = object(launcher.retainedLauncher).sha256;
  hash(launcherSha256);
  const expected = {
    runtime,
    controllerRun: input.controllerRun,
    launcherAdmission: {
      launcherSha256,
      packageBuildSha256: build.sha256,
      artifactSourceSnapshotSha256: snapshot.sha256,
      controllerSourceRevision: input.controllerSourceRevision,
    },
  };
  const coldPath = "installed-acceptance/installed-hermes-acceptance.json";
  const warmPath = "installed-acceptance-warm/installed-hermes-acceptance.json";
  const cold = document(coldPath).value;
  const warm = document(warmPath).value;
  validateCase(cold, expected);
  validateCase(warm, expected, cold);
  const timings = document("installed-stage-timings.json").value;
  for (const [key, value] of Object.entries({
    schemaVersion: 1,
    sourceRevision: input.sourceRevision,
    artifactSourceRevision: input.sourceRevision,
    controllerSourceRevision: input.controllerSourceRevision,
    currentHeadQualification: input.sourceRevision === input.controllerSourceRevision,
    mode: "current-build",
    measurement: "fresh-runner-installed-preview",
    agent: "hermes",
    validationScope: "full-acceptance",
    runtimeBootstrap: true,
    runtimeQualified: true,
    fullInstalledQualification: false,
    hostPreparationRunBeforeInstall: false,
    installTargetMilliseconds: 30000,
    installTargetSatisfied: true,
    primaryException: null,
    nativeRuntimeFailure: null,
    startupComparisonAvailable: true,
    installationRootRemoved: true,
  }))
    assert.equal(timings[key], value, `Incomplete Hermes acceptance: ${key}`);
  for (const key of ["uninstallDeferredForRecovery", "uninstallDeferredForSetupTransaction"])
    if (Object.hasOwn(timings, key)) assert.equal(timings[key], false);
  for (const action of ["-install", "-uninstall"]) {
    const stage = object(object(timings.stages)[action]);
    assert.equal(stage.exitCode, 0);
    assert.equal(stage.transactionStopped, true);
    assert(
      Number.isSafeInteger(stage.elapsedMilliseconds) && Number(stage.elapsedMilliseconds) >= 0,
    );
    if (action === "-install") boundedTime(stage.elapsedMilliseconds, 30000);
  }
  for (const [name, receipt] of [
    ["firstInstalledLaunch", coldPath],
    ["warmInstalledLaunch", warmPath],
  ]) {
    const stage = object(timings[name]);
    assert.equal(stage.exitCode, 0);
    assert.equal(stage.receipt, receipt);
    assert.equal(stage.agentStateResetPerCase, false);
  }
  assert.deepEqual(timings.restartPersistence, {
    qualified: true,
    configurationUnchanged: true,
    sameConversation: true,
    sameStateRoot: true,
    coldReceipt: coldPath,
    warmReceipt: warmPath,
  });
  assert.deepEqual(object(timings.remainingInstallation).entries, []);
  assert.equal(object(timings.remainingInstallation).truncated, false);
  return {
    schemaVersion: 1,
    classification: "reviewed-native-runtime-availability",
    runtime,
    agents: [{ agent: "hermes", evidenceSha256: input.evidenceManifestSha256 }],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: Object.fromEntries(
      [
        "evidence-root",
        "evidence-manifest-sha256",
        "source-revision",
        "controller-source-revision",
        "controller-run",
        "output",
      ].map((name) => [name, { type: "string" as const }]),
    ),
  });
  const decision = reviewHermesAvailability({
    evidenceRoot: text(values["evidence-root"]),
    evidenceManifestSha256: text(values["evidence-manifest-sha256"]),
    sourceRevision: text(values["source-revision"]),
    controllerSourceRevision: text(values["controller-source-revision"]),
    controllerRun: text(values["controller-run"]),
  });
  const bytes = Buffer.from(JSON.stringify(decision, null, 2) + "\n");
  fs.writeFileSync(text(values.output), bytes, { flag: "wx" });
  process.stdout.write(createHash("sha256").update(bytes).digest("hex") + "\n");
}

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  hermesInstalledCodeCommand,
  hermesInstalledToolCommand,
} from "./qualify-installed-hermes.mts";
import { reviewHermesAvailability } from "./review-hermes-availability.mts";

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const digest = (value: unknown) => createHash("sha256").update(bytes(value)).digest("hex");
const coldPath = "installed-acceptance/installed-hermes-acceptance.json";
const warmPath = "installed-acceptance-warm/installed-hermes-acceptance.json";

// Synthetic receipts exercise content admission; they are never installed proof.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-availability-fixture-"));
  const runtime = {
    sourceRevision: "a".repeat(40),
    runtimeId: "b".repeat(64),
    manifestSha256: "c".repeat(64),
    nodeSha256: "d".repeat(64),
    nodeVersion: "22.23.2",
  };
  const input = {
    evidenceRoot: root,
    evidenceManifestSha256: "",
    sourceRevision: runtime.sourceRevision,
    controllerSourceRevision: "e".repeat(40),
    controllerRun: "123:1",
  };
  const build = {
    schemaVersion: 1,
    classification: "finished-native-runtime-package-build",
    sourceRevision: input.sourceRevision,
    runtime,
    status: "candidate-built-for-installed-qualification",
    installedAcceptance: false,
    activationAllowed: false,
  };
  const snapshot = {
    schemaVersion: 1,
    classification: "independent-hermes-launcher-source-snapshot",
    artifactSourceRevision: input.sourceRevision,
    controllerSourceRevision: input.controllerSourceRevision,
    controllerRun: input.controllerRun,
    sources: [
      "Cargo.toml",
      "Cargo.lock",
      "src/main.rs",
      "src/state_session.rs",
      "src/runtime_lease.rs",
    ].map((file) => ({
      file: "packaging/windows/launcher/" + file,
      bytes: 10,
      sha256: "f".repeat(64),
    })),
  };
  const conversation = {
    storedSessionId: "fixture-session",
    profileName: "default",
    messageCount: 10,
    lastMessageId: 10,
    transcriptSha256: "1".repeat(64),
  };
  function turn(value: unknown) {
    return {
      conversationElapsedMs: 1000,
      measurement: "end-to-end conversation interval including model, tools and UI/protocol",
      isolatedProviderLatencyMs: null,
      value,
    };
  }
  function receipt(warm: boolean) {
    const nonce = (warm ? "3" : "2").repeat(20);
    return {
      schemaVersion: 1,
      classification: "installed-canonical-hermes-acceptance",
      verdict: "pass",
      failedStage: null,
      error: null,
      controllerRun: input.controllerRun,
      runtime,
      cleanupErrors: [],
      fullInstalledQualification: false,
      results: {
        runtimeBootstrap: true,
        launcherAdmission: {
          launcherSha256: "4".repeat(64),
          packageBuildSha256: digest(build),
          artifactSourceSnapshotSha256: digest(snapshot),
          controllerSourceRevision: input.controllerSourceRevision,
        },
        configurationReused: warm,
        configurationPreserved: !warm,
        configurationSha256: "5".repeat(64),
        stateRoot: "C:\\NemoClawState-S-1-5-21-1000-hermes",
        dashboardModel: "fixture-model",
        runtime,
        configuration: {
          reused: warm,
          configuredThisCase: !warm,
          nativeOnboardingUsed: false,
          searchRequested: false,
          messagingRequested: false,
        },
        startup: { usablePromptElapsedMs: 1000 },
        edgeBrowser: {
          schemaVersion: 1,
          classification: "native-hermes-edge-browser",
          agent: "hermes",
          sessionId: (warm ? "8" : "7").repeat(10),
          identity: {
            architecture: "arm64",
            machine: 0xaa64,
            signatureStatus: "Valid",
            signerSubject: "Microsoft Corporation",
            provenance: "standard-windows-microsoft-edge-installation",
            path: "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
            sha256: "9".repeat(64),
          },
          process: { pid: 100, creationTimeFileTime: "133000000000000000" },
          endpoint: { host: "127.0.0.1", port: 12345, path: "/devtools/browser/fixture" },
          authenticatedRelay: true,
          generalHostProxy: false,
          inheritedKillOnCloseJob: true,
        },
        nvidia: turn({ role: "assistant", content: "NEMOCLAW_NVIDIA_" + nonce }),
        tools: turn({
          terminal: {
            toolCallId: "terminal-fixture",
            command: hermesInstalledToolCommand(nonce),
            result: { exit_code: 0, output: "NEMOCLAW_TOOLS_" + nonce },
          },
          executeCode: {
            toolCallId: "code-fixture",
            code: hermesInstalledCodeCommand(nonce),
            result: {
              status: "success",
              exit_code: 0,
              output: "NEMOCLAW_EXECUTE_CODE_" + nonce,
              tool_calls_made: 1,
              kernel: { mode: "session", execution_count: 1 },
            },
          },
        }),
        toolsScope: {
          bash: true,
          fileWriteReadDeleteViaTerminal: true,
          canonicalRipgrep: true,
          terminalPythonTemporaryCode: true,
          executeCodeToolBootstrap: true,
        },
        browserTool: turn({
          toolCallId: "browser-fixture",
          code: [
            'expected="Example Domain"',
            "new_tab('https://example.com/')",
            "assert wait_for_element('h1', timeout=15.0, visible=True) is True",
            "actual=js(\"document.querySelector('h1').textContent\")",
            "assert actual == expected",
            "print(expected)",
          ].join("\n"),
          result: { success: true, exit_code: 0, output: "Example Domain" },
        }),
        browserToolScope: {
          browser: "native-arm64-microsoft-edge",
          transport: "authenticated-session-cdp-relay",
          localBundledBrowserExecuted: false,
          visibleSentinel: "Example Domain",
        },
        idle: {
          schemaVersion: 1,
          classification: "installed-windows-idle-process-observation",
          status: "measured",
          acceptedAsIdle: true,
          error: null,
          agent: "hermes",
          stateRoot: "C:\\NemoClawState-S-1-5-21-1000-hermes",
          applicationInstrumentationEnabled: false,
          requestedIdleMs: 30000,
          observerWorkBoundMs: 40000,
          observerCleanupBoundMs: 5000,
          qualificationClaim: false,
          runtime: {
            runtimeId: runtime.runtimeId,
            sourceRevision: runtime.sourceRevision,
            manifestSha256: runtime.manifestSha256,
          },
        },
        custody: {
          nativeLaunchAttempted: true,
          nativeCleanupConfirmed: true,
          processesStopped: true,
          uninstallSafe: true,
          configurationMutationUnconfirmed: false,
          configurationRetainedForRecovery: false,
        },
        cleanup: {
          schemaVersion: 1,
          classification: "native-hermes-dashboard-qualification",
          agent: "hermes",
          sandboxDeleted: true,
          gatewayStopped: true,
          ephemeralRootsRemoved: true,
          stateRetained: true,
          leaseReleased: true,
          cleanupSucceeded: true,
          guardianClosed: true,
          observerClosed: true,
          runtimeLeaseOwnerClosedWithGuardian: true,
          runtimeCounterSource: "held-runtime-session",
          runtimeBytesCopied: 0,
          runtimeFilesHashedAtLaunch: 0,
          retainedPrivateGatewayRoot: null,
          runtimeIdentity: {
            runtimeId: runtime.runtimeId,
            manifestSha256: runtime.manifestSha256,
            sourceRevision: runtime.sourceRevision,
          },
        },
        retainedConversation: warm
          ? {
              ...conversation,
              messageCount: 20,
              lastMessageId: 20,
              transcriptSha256: "6".repeat(64),
            }
          : { ...conversation },
        ...(warm ? { restoredConversation: { ...conversation } } : {}),
      },
    };
  }
  const timings = {
    schemaVersion: 1,
    sourceRevision: input.sourceRevision,
    artifactSourceRevision: input.sourceRevision,
    controllerSourceRevision: input.controllerSourceRevision,
    currentHeadQualification: false,
    mode: "current-build",
    measurement: "fresh-runner-installed-preview",
    agent: "hermes",
    validationScope: "full-acceptance",
    fullInstalledQualification: false,
    runtimeBootstrap: true,
    runtimeQualified: true,
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
      configurationUnchanged: true,
      sameConversation: true,
      sameStateRoot: true,
      coldReceipt: coldPath,
      warmReceipt: warmPath,
    },
    remainingInstallation: { entries: [], truncated: false },
  };
  const documents: Record<string, any> = Object.fromEntries(
    Object.entries({
      "package/immutable-package-build.json": build,
      "package/launcher-build-inputs.json": {
        classification: "package-selected-launcher-build-inputs",
        sourceRevision: input.sourceRevision,
        workflowRunId: "123",
        workflowRunAttempt: "1",
        retainedLauncher: { sha256: "4".repeat(64) },
      },
      "hermes-artifact-source.json": snapshot,
      [coldPath]: receipt(false),
      [warmPath]: receipt(true),
      "installed-stage-timings.json": timings,
    }).map(([name, value]) => [name, structuredClone(value)]),
  );
  function stage() {
    const files = Object.entries(documents).map(([relative, value]) => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes(value));
      return { path: relative, bytes: bytes(value).length, sha256: digest(value) };
    });
    const manifest = {
      schemaVersion: 1,
      classification: "accidental-runnable-free-windows-evidence",
      files,
    };
    fs.writeFileSync(path.join(root, "evidence-manifest.json"), bytes(manifest));
    input.evidenceManifestSha256 = digest(manifest);
  }
  stage();
  return { root, input, runtime, documents, stage };
}

test("Hermes availability binds cold and warm evidence without approving the final installer", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const result = reviewHermesAvailability(f.input);
  assert.deepEqual(result, {
    schemaVersion: 1,
    classification: "reviewed-native-runtime-availability",
    runtime: f.runtime,
    agents: [{ agent: "hermes", evidenceSha256: f.input.evidenceManifestSha256 }],
  });
  const output = path.join(f.root, "reviewed.json");
  const command = [
    "--experimental-strip-types",
    "--no-warnings",
    fileURLToPath(new URL("./review-hermes-availability.mts", import.meta.url)),
    "--evidence-root",
    f.root,
    "--evidence-manifest-sha256",
    f.input.evidenceManifestSha256,
    "--source-revision",
    f.input.sourceRevision,
    "--controller-source-revision",
    f.input.controllerSourceRevision,
    "--controller-run",
    f.input.controllerRun,
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
  assert.notEqual(
    spawnSync(process.execPath, command, { encoding: "utf8", timeout: 30000 }).status,
    0,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), result);
});

test("Hermes availability rejects rehashed failures, foreign state and incomplete real turns", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const original = structuredClone(f.documents);
  const mutations: Array<(d: Record<string, any>) => void> = [
    (d) => {
      d[coldPath].verdict = "fail";
    },
    (d) => {
      d[coldPath].failedStage = "nvidia-model";
    },
    (d) => {
      d[coldPath].error = "unconfirmed";
    },
    (d) => {
      d[coldPath].controllerRun = "123:2";
    },
    (d) => {
      d[coldPath].cleanupErrors = ["live process"];
    },
    (d) => {
      d[coldPath].results.launcherAdmission.launcherSha256 = "0".repeat(64);
    },
    (d) => {
      d[coldPath].results.custody.configurationMutationUnconfirmed = true;
    },
    (d) => {
      d[coldPath].results.custody.nativeCleanupConfirmed = false;
    },
    (d) => {
      d[coldPath].results.cleanup.observerClosed = false;
    },
    (d) => {
      d[coldPath].results.cleanup.runtimeIdentity.runtimeId = "0".repeat(64);
    },
    (d) => {
      d[coldPath].results.cleanup.runtimeBytesCopied = 1;
    },
    (d) => {
      d[coldPath].results.cleanup.runtimeFilesHashedAtLaunch = 1;
    },
    (d) => {
      d[coldPath].results.cleanup.retainedPrivateGatewayRoot = "C:\\retained";
    },
    (d) => {
      d[coldPath].results.runtime.runtimeId = "0".repeat(64);
    },
    (d) => {
      d[coldPath].runtime.runtimeId = "0".repeat(64);
    },
    (d) => {
      d[coldPath].results.runtimeBootstrap = false;
    },
    (d) => {
      d[coldPath].results.configuration.nativeOnboardingUsed = true;
    },
    (d) => {
      d["installed-stage-timings.json"].fullInstalledQualification = true;
    },
    (d) => {
      d["installed-stage-timings.json"].runtimeQualified = false;
    },
    (d) => {
      d["installed-stage-timings.json"].runtimeBootstrap = false;
    },
    (d) => {
      d[coldPath].results.nvidia.value.role = "user";
    },
    (d) => {
      d[coldPath].results.nvidia.value.content = "model claims success";
    },
    (d) => {
      d[coldPath].results.nvidia.conversationElapsedMs = 120000;
    },
    (d) => {
      d[coldPath].results.tools.value.terminal.command = "echo success";
    },
    (d) => {
      d[coldPath].results.tools.value.terminal.result.error = "failure";
    },
    (d) => {
      d[coldPath].results.tools.value.executeCode.result.kernel.mode = "fake";
    },
    (d) => {
      d[coldPath].results.tools.value.executeCode.result.tool_calls_made = 0;
    },
    (d) => {
      d[coldPath].results.browserTool.value.result.success = false;
    },
    (d) => {
      delete d[coldPath].results.edgeBrowser;
    },
    (d) => {
      d[coldPath].results.edgeBrowser.identity.architecture = "x64";
    },
    (d) => {
      d[coldPath].results.edgeBrowser.authenticatedRelay = false;
    },
    (d) => {
      d[coldPath].results.edgeBrowser.generalHostProxy = true;
    },
    (d) => {
      d[coldPath].results.browserToolScope.localBundledBrowserExecuted = true;
    },
    (d) => {
      d[coldPath].results.toolsScope.canonicalRipgrep = false;
    },
    (d) => {
      d[coldPath].results.idle.acceptedAsIdle = false;
    },
    (d) => {
      d[coldPath].results.idle.error = "observer did not close";
    },
    (d) => {
      d[coldPath].results.idle.runtime.runtimeId = "0".repeat(64);
    },
    (d) => {
      d[coldPath].results.idle.stateRoot = "C:\\different-state";
    },
    (d) => {
      d[coldPath].results.retainedConversation.storedSessionId = "../foreign";
    },
    (d) => {
      d[coldPath].results.startup.usablePromptElapsedMs = 120000;
    },
    (d) => {
      d[warmPath].results.configurationSha256 = "0".repeat(64);
    },
    (d) => {
      d[warmPath].results.stateRoot = "C:\\NemoClawState-S-1-5-21-2000-hermes";
    },
    (d) => {
      d[warmPath].results.dashboardModel = "other-model";
    },
    (d) => {
      d[warmPath].results.onboarding = { passed: true };
    },
    (d) => {
      d[warmPath].results.restoredConversation.transcriptSha256 = "0".repeat(64);
    },
    (d) => {
      d[warmPath].results.retainedConversation.storedSessionId = "another-session";
    },
    (d) => {
      d[warmPath].results.retainedConversation = structuredClone(
        d[coldPath].results.retainedConversation,
      );
    },
    (d) => {
      d[warmPath].results.nvidia = structuredClone(d[coldPath].results.nvidia);
    },
    (d) => {
      d["installed-stage-timings.json"].validationScope = "build-only";
    },
    (d) => {
      d["installed-stage-timings.json"].stages["-install"].elapsedMilliseconds = 30000;
    },
    (d) => {
      d["installed-stage-timings.json"].stages["-uninstall"].transactionStopped = false;
    },
    (d) => {
      d["installed-stage-timings.json"].warmInstalledLaunch.agentStateResetPerCase = true;
    },
    (d) => {
      d["installed-stage-timings.json"].restartPersistence.configurationUnchanged = false;
    },
    (d) => {
      d["installed-stage-timings.json"].remainingInstallation.entries = ["retained.exe"];
    },
    (d) => {
      d["installed-stage-timings.json"].uninstallDeferredForRecovery = true;
    },
    (d) => {
      d["hermes-artifact-source.json"].classification =
        "independent-openclaw-launcher-source-snapshot";
    },
    (d) => {
      d["package/launcher-build-inputs.json"].workflowRunAttempt = "2";
    },
  ];
  for (const mutate of mutations) {
    Object.assign(f.documents, structuredClone(original));
    mutate(f.documents);
    f.stage();
    assert.throws(() => reviewHermesAvailability(f.input), mutate.toString());
  }
});

test("Hermes evidence rejects rehashed malformed and ambiguous manifests", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const manifestPath = path.join(f.root, "evidence-manifest.json");
  const original = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const mutations: Array<(value: any) => void> = [
    (value) => {
      value.schemaVersion = 2;
    },
    (value) => {
      value.classification = "unverified";
    },
    (value) => {
      value.files = [];
    },
    (value) => {
      value.files.push({ ...value.files[0], path: value.files[0].path.toUpperCase() });
    },
    (value) => {
      value.files[0].path = "../outside.json";
    },
    (value) => {
      value.files[0].path = "package\\receipt.json";
    },
    (value) => {
      value.files[0].bytes = -1;
    },
    (value) => {
      value.files[0].sha256 = "not-a-digest";
    },
  ];
  for (const mutate of mutations) {
    const manifest = structuredClone(original);
    mutate(manifest);
    fs.writeFileSync(manifestPath, bytes(manifest));
    assert.throws(
      () => reviewHermesAvailability({ ...f.input, evidenceManifestSha256: digest(manifest) }),
      mutate.toString(),
    );
  }
});

test("Hermes evidence rejects hard-linked and oversized receipts with valid content hashes", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const alias = path.join(f.root, "cold-alias.json");
  fs.linkSync(path.join(f.root, coldPath), alias);
  assert.throws(() => reviewHermesAvailability(f.input));
  fs.unlinkSync(alias);
  assert.doesNotThrow(() => reviewHermesAvailability(f.input));
  f.documents[coldPath].oversized = "x".repeat(2 * 1024 * 1024);
  f.stage();
  assert.throws(() => reviewHermesAvailability(f.input));
});

test("Hermes evidence rejects changed bytes, missing entries and foreign controller inputs", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  for (const changed of [
    { evidenceManifestSha256: "0".repeat(64) },
    { sourceRevision: "0".repeat(40) },
    { controllerSourceRevision: "0".repeat(40) },
    { controllerRun: "123:2" },
  ])
    assert.throws(() => reviewHermesAvailability({ ...f.input, ...changed }));
  fs.appendFileSync(path.join(f.root, coldPath), " ");
  assert.throws(() => reviewHermesAvailability(f.input));
  f.stage();
  delete f.documents[warmPath];
  f.stage();
  assert.throws(() => reviewHermesAvailability(f.input));
});

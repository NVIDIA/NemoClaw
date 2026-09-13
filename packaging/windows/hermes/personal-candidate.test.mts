// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  personalRequest,
  directBrowserRequest,
  primaryDebugRequest,
  directBrowserDiagnostic,
  stockBrowserEnvironment,
  validateHermesDesktopMask,
  inspectHermesDesktopCleanup,
  desktopAbsenceRequest,
  validateStockBrowserExecutor,
  validateBrowserUseLaunch,
  hostBrowserCompletion,
  stockDebugCompletion,
  validateJobOnlyConfiguration,
  primaryComparisonMetadata,
  completedPersonalReplayPin,
  validatePersonalReplayInput,
  verifyPersonalReplayInventory,
  removePersonalRoots,
  publishPersonalReceipt,
} from "./probe-personal-candidate.mts";
import { parseComponent, personalCommand } from "./probe-personal-workload.mts";

const browserRuntime = "C:\\NemoClawHermesProbe-274d797050ea";
const browserOriginalNonce = "00112233445566778899aabb";
const browserNewNonce = "ffeeddccbbaa998877665544";
const browserController = "C:\\NemoClawPersonalNode-001122334455";

test("Browser Use launch binds current helper bytes and the packaged module command", () => {
  const source = {
    path: path.win32.join(browserController, "nemoclaw_browser_use.py"),
    bytes: 123,
    sha256: "a".repeat(64),
    peMachine: null,
    architecture: "non-PE-or-unknown",
  };
  const observed = {
    classification: "owned-browser-use-module-launch",
    source: { path: source.path, bytes: source.bytes, sha256: source.sha256 },
    command: [
      path.win32.join(browserRuntime, "tools/browser-use/Scripts/python.exe"),
      "-I",
      "-B",
      "-m",
      "browser_use.cli",
    ],
    modulePath: path.win32.join(
      browserRuntime,
      "tools/browser-use/Lib/site-packages/browser_use/cli.py",
    ),
    moduleSha256: "9a52306f028230fa471b0887e81b0ab4eccc15dc26be4b0b152bb001ba2977ef",
    entryPointsSha256: "444f604c01aadb261d692bf944e9ebc2e39398ef77dcf0a32d550eb25e32e0e1",
    trampolineBypassed: true,
    runtimeBytesModified: false,
  };
  assert.equal(validateBrowserUseLaunch(observed, source, browserRuntime), observed);
  assert.throws(() =>
    validateBrowserUseLaunch(
      { ...observed, source: { ...observed.source, sha256: "b".repeat(64) } },
      source,
      browserRuntime,
    ),
  );
  assert.throws(() =>
    validateBrowserUseLaunch(
      { ...observed, command: ["C:\\host\\python.exe", ...observed.command.slice(1)] },
      source,
      browserRuntime,
    ),
  );
  assert.throws(() =>
    validateBrowserUseLaunch({ ...observed, runtimeBytesModified: true }, source, browserRuntime),
  );
});

const desktopOwnerBinding = {
  executable: "C:\\native\\wxc-exec.exe",
  policyFile: "C:\\owned\\personal-request.json",
  requestSha256: "a".repeat(64),
  containerId: "nm-0123456789ab-start",
};
const desktopOwnerSid = "S-1-15-2-123-456-789";
const desktopOwnerLine = (row: any) => "NEMOCLAW_HERMES_DESKTOP=" + JSON.stringify(row) + "\n";
function desktopOwnerRows(): any[] {
  const prepared = ["default", "low"].map((labelVariant) => ({
    schemaVersion: 1,
    classification: "owned-Hermes-desktop",
    stage: "prepared",
    rootPid: 400,
    appContainerSid: desktopOwnerSid,
    actualJobAndAppContainerBound: true,
    hostSession: 2,
    stationName: "WinSta0",
    hostUserSid: "S-1-5-21-123-456-789-500",
    hostDesktopSelected: false,
    existingObjectSecurityChanged: false,
    desktopName: `NemoClawHermesDesktop-${desktopOwnerSid}-${labelVariant}`,
    labelVariant,
    requestedAccess: 0xe0083,
    inheritHandle: false,
    createAttempted: true,
    openedOrCreated: true,
  }));
  return [
    ...prepared,
    ...prepared.map(({ desktopName }) => ({
      schemaVersion: 1,
      classification: "owned-Hermes-desktop",
      stage: "owner-close",
      clock: "GetTickCount64",
      absenceCheckedTickMilliseconds: 100,
      desktopName,
      closed: true,
      closeError: 0,
      absentAfterOwnerClose: true,
      absenceError: 2,
      presenceHandleClosed: true,
      hostDesktopSelected: false,
    })),
  ];
}
function desktopOwnerExecution(
  rows = desktopOwnerRows(),
): Awaited<ReturnType<typeof personalCommand>> {
  return {
    executable: desktopOwnerBinding.executable,
    args: [desktopOwnerBinding.policyFile, "--log-file", "C:\\owned\\mxc.log"],
    pid: 42,
    exitCode: 0,
    signal: null,
    childClosed: true,
    timedOut: false,
    outputExceeded: false,
    stdout: "",
    stderr: rows.map(desktopOwnerLine).join(""),
    elapsedMs: 1,
    error: null,
    nativeStderr:
      "NEMOCLAW_MSYS_HOST_TOKEN_INSPECTION=" +
      JSON.stringify({
        exactJobAndGenerationsBound: true,
        rootPid: 400,
        appContainerSid: desktopOwnerSid,
      }) +
      "\n",
    nativeStderrBytes: 0,
    nativeStderrSha256: "",
    nativeRecordCount: 1,
    nativeOutputExceeded: false,
    nativeParseErrors: [],
  };
}

test("closed-executor desktop cleanup binds both constructor variants and actual token identity", () => {
  const execution = desktopOwnerExecution();
  const result = inspectHermesDesktopCleanup(execution, desktopOwnerBinding);
  assert.equal(result.passed, true);
  assert.equal(result.ownedNames.length, 2);
  assert.equal(result.rootIdentityCrossChecked, true);
  assert.equal(result.binding.executorPid, 42);
  // Primary-debug retains the token rows in its combined stderr instead.
  const debug = {
    ...execution,
    stderr: execution.stderr + execution.nativeStderr,
    nativeStderr: "",
  };
  assert.equal(inspectHermesDesktopCleanup(debug, desktopOwnerBinding).passed, true);
  assert.equal(
    inspectHermesDesktopCleanup(
      { ...debug, nativeStderr: execution.nativeStderr },
      desktopOwnerBinding,
    ).passed,
    true,
  );
  for (const changed of [
    { childClosed: false },
    { pid: null },
    { executable: "C:\\other\\wxc-exec.exe" },
    { args: ["C:\\unrelated\\request.json", "--log-file", "C:\\owned\\mxc.log"] },
    { outputExceeded: true },
    { nativeOutputExceeded: true },
    { nativeStderr: execution.nativeStderr.replace('"rootPid":400', '"rootPid":401') },
    { nativeStderr: execution.nativeStderr.replace(desktopOwnerSid, "S-1-15-2-999") },
  ])
    assert.equal(
      inspectHermesDesktopCleanup({ ...execution, ...changed }, desktopOwnerBinding).passed,
      false,
    );
  assert.equal(
    inspectHermesDesktopCleanup({ ...execution, childClosed: false }, desktopOwnerBinding).rows
      .length,
    0,
  );
});

test("desktop close and observed absence are mandatory for every prepared handle", () => {
  for (const change of [
    { closed: false, closeError: 5 },
    { closeError: 5 },
    { presenceHandleClosed: false },
    { absentAfterOwnerClose: false },
    { absenceError: 5 },
    { absenceError: null },
    { desktopName: "NemoClawHermesDesktop-S-1-15-2-999-default" },
  ]) {
    const rows = desktopOwnerRows();
    rows[2] = { ...rows[2], ...change };
    const result = inspectHermesDesktopCleanup(desktopOwnerExecution(rows), desktopOwnerBinding);
    assert.equal(result.passed, false);
    assert.equal(result.rows.length, 4);
    assert(result.error);
  }
  for (const rows of [
    desktopOwnerRows().slice(0, 3),
    [...desktopOwnerRows().slice(0, 3), desktopOwnerRows()[2]],
    [],
  ])
    assert.equal(
      inspectHermesDesktopCleanup(desktopOwnerExecution(rows), desktopOwnerBinding).passed,
      false,
    );
});

test("failed desktop constructors need no close while partial and global preparation stay explicit", () => {
  const rows = desktopOwnerRows();
  rows[1] = {
    ...rows[1],
    stage: "prepare-failed",
    openedOrCreated: false,
    error: "CreateDesktopW: Win32 5",
  };
  rows.pop();
  const result = inspectHermesDesktopCleanup(desktopOwnerExecution(rows), desktopOwnerBinding);
  assert.equal(result.passed, true);
  assert.deepEqual(result.ownedNames, [rows[0].desktopName]);
  const failed = rows
    .slice(0, 2)
    .map((row) => ({ ...row, stage: "prepare-failed", openedOrCreated: false }));
  const none = inspectHermesDesktopCleanup(desktopOwnerExecution(failed), desktopOwnerBinding);
  assert.equal(none.passed, true);
  assert.equal(none.provisioning, "constructors-failed-without-handles");
  assert.equal(
    inspectHermesDesktopCleanup(
      desktopOwnerExecution([{ ...failed[0], stage: "host-context", openedOrCreated: false }]),
      desktopOwnerBinding,
    ).passed,
    true,
  );
  failed[0].preexistingOpened = true;
  failed[0].preexistingHandleClosed = false;
  assert.equal(
    inspectHermesDesktopCleanup(desktopOwnerExecution(failed), desktopOwnerBinding).passed,
    false,
  );
  const lateFailure = desktopOwnerRows();
  lateFailure[0].stage = "prepare-failed";
  assert.equal(
    inspectHermesDesktopCleanup(desktopOwnerExecution(lateFailure), desktopOwnerBinding).passed,
    true,
  );
  assert.equal(
    inspectHermesDesktopCleanup(desktopOwnerExecution(lateFailure.slice(0, 2)), desktopOwnerBinding)
      .passed,
    false,
  );
});

test("desktop and token parser bounds accommodate actual source rows and reject ambiguous ownership", () => {
  const rows = desktopOwnerRows();
  rows[0].baselineDaclHex = "aa".repeat(20_000);
  assert.equal(
    inspectHermesDesktopCleanup(desktopOwnerExecution(rows), desktopOwnerBinding).passed,
    true,
  );
  rows[0].baselineDaclHex = "a".repeat(64 * 1024);
  assert.equal(
    inspectHermesDesktopCleanup(desktopOwnerExecution(rows), desktopOwnerBinding).passed,
    false,
  );
  assert.equal(
    inspectHermesDesktopCleanup(
      desktopOwnerExecution([...desktopOwnerRows(), desktopOwnerRows()[0]]),
      desktopOwnerBinding,
    ).passed,
    false,
  );
  const mismatched = desktopOwnerRows();
  mismatched[1].appContainerSid = "S-1-15-2-999";
  assert.equal(
    inspectHermesDesktopCleanup(desktopOwnerExecution(mismatched), desktopOwnerBinding).passed,
    false,
  );
  const execution = desktopOwnerExecution();
  const token = {
    exactJobAndGenerationsBound: true,
    rootPid: 400,
    appContainerSid: desktopOwnerSid,
    padding: "",
  };
  token.padding = "x".repeat(16 * 1024 - Buffer.byteLength(JSON.stringify(token)));
  execution.nativeStderr = "NEMOCLAW_MSYS_HOST_TOKEN_INSPECTION=" + JSON.stringify(token) + "\n";
  assert.equal(inspectHermesDesktopCleanup(execution, desktopOwnerBinding).passed, true);
});

test("a desktop cleanup failure remains secondary in the published component failure receipt", () => {
  const rows = desktopOwnerRows();
  rows[2].absenceError = 5;
  rows[2].absentAfterOwnerClose = false;
  const primary = new Error("original browser component failure");
  const execution = {
    ...desktopOwnerExecution(rows),
    exitCode: 1,
    error: { message: primary.message },
  };
  const cleanup = inspectHermesDesktopCleanup(execution, desktopOwnerBinding);
  assert.equal(cleanup.passed, false);
  assert.equal(execution.error.message, primary.message);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-cleanup-receipt-"));
  try {
    const file = path.join(root, "receipt.json");
    const reports: unknown[] = [];
    const receipt = {
      error: primary.message,
      hostDesktopCleanup: cleanup,
      cleanupErrors: [{ hostDesktopCleanup: cleanup.error }],
      feasibilityPassed: false,
    };
    assert.equal(
      publishPersonalReceipt(file, receipt, primary, (row) => reports.push(row)),
      true,
    );
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).error, primary.message);
    assert.match(JSON.stringify(reports[0]), /original browser component failure/u);
    assert.equal(receipt.cleanupErrors.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("primary debugger keeps current native bytes and four-component command while rebinding only owned controller/state", () => {
  const native = "C:\\NemoClawPersonalCompat-001122334455";
  const primary = personalRequest(
    path.win32.join(browserController, "node.exe"),
    path.win32.join(browserController, "probe-personal-workload.mts"),
    browserRuntime,
    "C:\\NemoClawMsysProof-001122334455-state-start",
    browserOriginalNonce,
    "C:\\Windows",
    native,
  );
  const before = structuredClone(primary);
  const plan = primaryDebugRequest(
    primary,
    browserRuntime,
    path.win32.join(browserController, "probe-personal-python.py"),
    browserNewNonce,
  );
  assert.deepEqual(primary, before);
  assert.equal(plan.nativeRoot, native);
  assert.equal(plan.originalNonce, browserOriginalNonce);
  assert.equal(plan.controller, "C:\\NemoClawPersonalNode-ffeeddccbbaa");
  assert.deepEqual(plan.request.filesystem.readonlyPaths, [
    browserRuntime,
    plan.controller,
    native,
  ]);
  assert.deepEqual(plan.request.filesystem.readwritePaths, [
    "C:\\NemoClawMsysProof-ffeeddccbbaa-state-start",
  ]);
  assert(
    plan.request.process.commandLine.startsWith(
      `"${native}\\NemoClawMsysLauncher.exe" "--" "${plan.controller}\\node.exe"`,
    ),
  );
  assert(
    plan.request.process.commandLine.includes(`"${plan.controller}\\probe-personal-workload.mts"`),
  );
  assert.equal(plan.request.process.timeout, primary.process.timeout);
  for (const key of ["network", "ui", "processContainer", "lifecycle"] as const)
    assert.deepEqual(plan.request[key], primary[key]);
  assert.throws(() =>
    primaryDebugRequest(
      {
        ...primary,
        process: {
          ...primary.process,
          commandLine: primary.process.commandLine.replace('"--no-warnings"', '"--eval"'),
        },
      },
      browserRuntime,
      path.win32.join(browserController, "probe-personal-python.py"),
      browserNewNonce,
    ),
  );
});
const browserProbe = path.win32.join(browserController, "probe-personal-python.py");
const browserShare = "C:\\NemoClawMsysProof-ffeeddccbbaa-state-start";
function browserPrimary() {
  return personalRequest(
    path.win32.join(browserController, "node.exe"),
    path.win32.join(browserController, "probe-personal-workload.mts"),
    browserRuntime,
    "C:\\NemoClawMsysProof-001122334455-state-start",
    browserOriginalNonce,
    "C:\\Windows",
    "C:\\NemoClawPersonalCompat-001122334455",
  );
}

test("direct browser comparison preserves policy and environment except fresh owned state and command", () => {
  const primary = browserPrimary();
  const before = structuredClone(primary);
  const diagnostic = directBrowserRequest(primary, browserRuntime, browserProbe, browserNewNonce);
  assert.deepEqual(primary, before);
  assert.equal(diagnostic.process.cwd, browserShare);
  assert.deepEqual(diagnostic.filesystem.readwritePaths, [browserShare]);
  assert.equal(
    diagnostic.process.commandLine,
    `"${browserRuntime}\\hermes-agent\\venv\\Scripts\\python.exe" "-I" "-B" "${browserProbe}" "browser" "${browserRuntime}" "${browserNewNonce}"`,
  );
  assert.deepEqual(diagnostic.filesystem.readonlyPaths, primary.filesystem.readonlyPaths);
  assert.equal(diagnostic.process.timeout, 120_000);
  for (const entry of primary.process.env) {
    const key = entry.slice(0, entry.indexOf("="));
    if (
      ![
        "HOME",
        "HERMES_HOME",
        "NEMOCLAW_AGENT_HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
      ].includes(key)
    )
      assert(diagnostic.process.env.includes(entry));
  }
  const restored = structuredClone(diagnostic);
  restored.containerId = primary.containerId;
  restored.process = primary.process;
  restored.filesystem.readwritePaths = primary.filesystem.readwritePaths;
  assert.deepEqual(restored, primary);
  assert.throws(() =>
    directBrowserRequest(primary, browserRuntime, browserProbe, browserOriginalNonce),
  );
});

test("stock MXC browser comparison removes both host opt-ins and requires the exact ARM64 executor", () => {
  const original = {
    GITHUB_ACTIONS: "true",
    PATH: "C:\\Windows\\System32",
    NEMOCLAW_MSYS_TOKEN_INSPECTION: "repair-query",
    NEMOCLAW_HERMES_PRIVATE_DESKTOP: "1",
  };
  assert.deepEqual(stockBrowserEnvironment(original), {
    GITHUB_ACTIONS: "true",
    PATH: "C:\\Windows\\System32",
  });
  assert.equal(original.NEMOCLAW_MSYS_TOKEN_INSPECTION, "repair-query");
  assert.equal(original.NEMOCLAW_HERMES_PRIVATE_DESKTOP, "1");
  const identity = {
    path: "C:\\stock\\wxc-exec.exe",
    bytes: 1,
    sha256: "dde1c592270e9a659b01dccad70362da7b99fec114885fa4d625507aa775a503",
    peMachine: 0xaa64,
    architecture: "arm64",
  };
  assert.equal(validateStockBrowserExecutor(identity), identity);
  assert.throws(() => validateStockBrowserExecutor({ ...identity, sha256: "0".repeat(64) }));
  assert.throws(() => validateStockBrowserExecutor({ ...identity, peMachine: 0x8664 }));
});

test("host browser receipt requires actual job zero, capture and handles closed in addition to supervisor closure", () => {
  const request = {
    nonce: browserNewNonce,
    runtimeRoot: browserRuntime,
    stateRoot: "C:\\NemoClawBrowserHost-ffeeddccbbaa",
  };
  const record = {
    schemaVersion: 1,
    classification: "canonical-host-browser-diagnostic",
    diagnosticOnly: true,
    canonicalQualification: false,
    installedAcceptance: false,
    ...request,
    processCreated: true,
    childrenClosed: true,
    cleanupComplete: true,
    execution: { childClosed: true },
    result: { schemaVersion: 1, component: "browser", nonce: browserNewNonce, passed: false },
    job: {
      created: true,
      limitFlags: 8192,
      assignedBeforeResume: true,
      rootMembershipVerified: true,
      activeAfterCleanup: 0,
    },
    cleanup: {
      captureClosed: true,
      processHandleClosed: true,
      threadHandleClosed: true,
      jobHandleClosed: true,
      stateRemoved: true,
      errors: [],
    },
  };
  assert.deepEqual(hostBrowserCompletion(record, request, true), {
    childrenClosed: true,
    cleanupComplete: true,
  });
  assert.deepEqual(hostBrowserCompletion(record, request, false), {
    childrenClosed: false,
    cleanupComplete: false,
  });
  for (const mutate of [
    (r: any) => {
      r.job.activeAfterCleanup = 1;
    },
    (r: any) => {
      r.job.assignedBeforeResume = false;
    },
    (r: any) => {
      r.execution.childClosed = false;
    },
    (r: any) => {
      r.cleanup.captureClosed = false;
    },
  ]) {
    const changed = structuredClone(record);
    mutate(changed);
    assert.deepEqual(hostBrowserCompletion(changed, request, true), {
      childrenClosed: false,
      cleanupComplete: false,
    });
  }
  for (const key of [
    "processHandleClosed",
    "threadHandleClosed",
    "jobHandleClosed",
    "stateRemoved",
  ]) {
    const changed: any = structuredClone(record);
    changed.cleanup[key] = false;
    assert.equal(hostBrowserCompletion(changed, request, true).cleanupComplete, false);
  }
  assert.throws(() =>
    hostBrowserCompletion({ ...record, nonce: browserOriginalNonce }, request, true),
  );
  assert.throws(() =>
    hostBrowserCompletion({ ...record, canonicalQualification: true }, request, true),
  );
});

test("stock debugger completion requires exact request and executor identity plus drained debug exits", () => {
  const request = { nonce: browserNewNonce, policySha256: "a".repeat(64) };
  const record = {
    schemaVersion: 1,
    classification: "stock-MXC-browser-debug-result",
    diagnosticOnly: true,
    canonicalQualification: false,
    ...request,
    executorIdentityAfter: {
      sha256: "dde1c592270e9a659b01dccad70362da7b99fec114885fa4d625507aa775a503",
    },
    childrenClosed: true,
    cleanupComplete: true,
    remainingDebugProcesses: [],
    cleanup: { captureClosed: true, handlesClosed: true, activeProcesses: 0, errors: [] },
  };
  assert.equal(stockDebugCompletion(record, request, true), true);
  const primaryRequest = {
    ...request,
    classification: "personal-MXC-browser-debug-request",
    executorIdentity: { sha256: "c".repeat(64) },
    nativeProof: { sha256: "d".repeat(64) },
  };
  const primaryRecord = {
    ...record,
    classification: "personal-MXC-browser-debug-result",
    executorIdentityAfter: primaryRequest.executorIdentity,
    nativeProofSha256: primaryRequest.nativeProof.sha256,
  };
  assert.equal(stockDebugCompletion(primaryRecord, primaryRequest, true), true);
  const jobRequest = { ...primaryRequest, mode: "personal-job-only" };
  const jobRecord = {
    ...primaryRecord,
    remainingDebugProcesses: undefined,
    classification: "owned-Personal-job-only-diagnostic",
    mode: "personal-job-only",
    debuggerMayChangeBehavior: false,
    debugEventsCollected: false,
  };
  assert.equal(stockDebugCompletion(jobRecord, jobRequest, true), true);
  assert.equal(stockDebugCompletion(jobRecord, jobRequest, false), false);
  assert.equal(
    stockDebugCompletion(
      { ...jobRecord, cleanup: { ...jobRecord.cleanup, activeProcesses: 1 } },
      jobRequest,
      true,
    ),
    false,
  );
  assert.throws(() =>
    stockDebugCompletion({ ...jobRecord, debugEventsCollected: true }, jobRequest, true),
  );
  const ownedJob = {
    creationFlags: 0x08000004,
    queryOnly: true,
    uiRestrictions: {
      informationClass: 4,
      querySucceeded: true,
      complete: true,
      win32Error: 0,
      flags: 0,
    },
    extendedLimits: {
      informationClass: 9,
      querySucceeded: true,
      complete: true,
      win32Error: 0,
      flags: 0x2000,
    },
  };
  assert.equal(validateJobOnlyConfiguration(ownedJob), ownedJob);
  assert.throws(() => validateJobOnlyConfiguration({ ...ownedJob, creationFlags: 0x08000005 }));
  assert.throws(() =>
    validateJobOnlyConfiguration({
      ...ownedJob,
      uiRestrictions: { ...ownedJob.uiRestrictions, querySucceeded: false, flags: null },
    }),
  );
  assert.throws(() =>
    stockDebugCompletion(
      { ...primaryRecord, executorIdentityAfter: record.executorIdentityAfter },
      primaryRequest,
      true,
    ),
  );
  assert.throws(() =>
    stockDebugCompletion(
      { ...primaryRecord, nativeProofSha256: "e".repeat(64) },
      primaryRequest,
      true,
    ),
  );
  assert.equal(stockDebugCompletion(record, request, false), false);
  assert.equal(
    stockDebugCompletion({ ...record, remainingDebugProcesses: [42] }, request, true),
    false,
  );
  assert.equal(
    stockDebugCompletion(
      { ...record, cleanup: { ...record.cleanup, activeProcesses: 1 } },
      request,
      true,
    ),
    false,
  );
  assert.equal(
    stockDebugCompletion(
      { ...record, cleanup: { ...record.cleanup, captureClosed: false } },
      request,
      true,
    ),
    false,
  );
  assert.throws(() =>
    stockDebugCompletion({ ...record, policySha256: "b".repeat(64) }, request, true),
  );
  assert.throws(() =>
    stockDebugCompletion(
      { ...record, executorIdentityAfter: { sha256: "0".repeat(64) } },
      request,
      true,
    ),
  );
});

test("ordinary warm and job-only comparisons label additional launch dimensions without qualification", () => {
  const warm = primaryComparisonMetadata("patched-primary-warm");
  const job = primaryComparisonMetadata("patched-primary-job");
  assert.equal(warm.classification, "canonical-Personal-primary-workload-ordinary-warm-diagnostic");
  assert(!warm.changedDimensions.some((value) => value.includes("Job")));
  assert(job.changedDimensions.some((value) => value.includes("DEBUG_PROCESS absent")));
  for (const metadata of [warm, job]) {
    assert(
      metadata.changedDimensions.some((value) =>
        value.includes("cache state are not independently measured"),
      ),
    );
    assert(
      metadata.comparisonLimits.some((value) =>
        value.includes("original ordinary primary verdict remains authoritative"),
      ),
    );
  }
});

function browserControl(
  t: TestContext,
  mode:
    | "success"
    | "browser-failure"
    | "parse-failure"
    | "unclosed"
    | "delete-failure"
    | "existing"
    | "stock-mismatch",
) {
  const primary = browserPrimary();
  const files = new Map<string, Buffer>();
  const directories = new Set<string>();
  const events: string[] = [];
  const pe = Buffer.alloc(256);
  pe.write("MZ");
  pe.writeUInt32LE(128, 60);
  pe.write("PE\0\0", 128);
  pe.writeUInt16LE(0xaa64, 132);
  const python = path.win32.join(browserRuntime, "hermes-agent/venv/Scripts/python.exe");
  const executor = "C:\\verified\\wxc-exec.exe";
  files.set(python, pe);
  files.set(executor, pe);
  files.set(browserProbe, Buffer.from("fixed controller"));
  if (mode === "existing") directories.add(browserShare);
  t.mock.method(fs, "mkdirSync", (file: any) => {
    const name = String(file);
    if (directories.has(name)) throw Object.assign(new Error("already exists"), { code: "EEXIST" });
    directories.add(name);
  });
  t.mock.method(fs, "readFileSync", (file: any) => {
    const value = files.get(String(file));
    assert(value, "unknown read " + file);
    return value;
  });
  t.mock.method(fs, "writeFileSync", (file: any, value: any, options: any) => {
    assert.equal(options.flag, "wx");
    assert(!files.has(String(file)));
    files.set(String(file), Buffer.from(value));
  });
  t.mock.method(
    fs,
    "existsSync",
    (file: any) => directories.has(String(file)) || files.has(String(file)),
  );
  t.mock.method(fs, "rmSync", (file: any) => {
    assert.equal(String(file), browserShare);
    events.push("remove-owned-root");
    for (const directory of directories)
      if (directory.startsWith(browserShare)) directories.delete(directory);
  });
  const patchedEnvironment = {
    GITHUB_ACTIONS: "true",
    NEMOCLAW_MSYS_TOKEN_INSPECTION: "repair-query",
    NEMOCLAW_HERMES_PRIVATE_DESKTOP: "1",
  };
  const environment =
    mode === "stock-mismatch" ? stockBrowserEnvironment(patchedEnvironment) : patchedEnvironment;
  const command: typeof personalCommand = async (exe, args, env, cwd, timeout) => {
    assert.equal(exe, executor);
    assert.equal(env, environment);
    const deletion = args[0] === "--delete";
    events.push(deletion ? "delete-profile" : "execute-direct-python");
    if (deletion) {
      assert.equal(cwd, "C:\\");
      assert.deepEqual(args, ["--delete", "--containername", "nm-ffeeddccbbaa-start"]);
    } else {
      assert.equal(timeout, 120_000);
      assert.equal(cwd, browserShare);
      assert(
        JSON.parse(files.get(args[0]!)!.toString()).process.commandLine.startsWith(`"${python}"`),
      );
    }
    const result = {
      schemaVersion: 1,
      component: "browser",
      nonce: browserNewNonce,
      passed: mode !== "browser-failure",
      error: mode === "browser-failure" ? "original Chrome failure" : null,
    };
    return {
      executable: exe,
      args,
      pid: 42,
      exitCode:
        (deletion && mode === "delete-failure") || (!deletion && mode === "browser-failure")
          ? 1
          : 0,
      signal: null,
      timedOut: !deletion && mode === "unclosed",
      outputExceeded: false,
      stdout: deletion
        ? ""
        : mode === "parse-failure"
          ? "missing result\n"
          : "NEMOCLAW_PERSONAL_RESULT=" + JSON.stringify(result) + "\n",
      stderr: deletion ? "" : "ordinary Chrome stderr",
      error: null,
      childClosed: deletion || mode !== "unclosed",
      elapsedMs: 1,
      nativeStderr: "",
      nativeStderrBytes: 0,
      nativeStderrSha256: "",
      nativeRecordCount: 0,
      nativeOutputExceeded: false,
      nativeParseErrors: [],
    };
  };
  return {
    primary,
    events,
    directories,
    run: () =>
      directBrowserDiagnostic(
        primary,
        browserRuntime,
        browserProbe,
        executor,
        environment,
        "/owned-evidence/browser-direct",
        browserNewNonce,
        { bytes: pe.length, sha256: createHash("sha256").update(pe).digest("hex") },
        command,
        mode === "stock-mismatch" ? "stock" : "patched",
      ),
  };
}

test("direct browser retains raw successful result and closes executor before profile/root cleanup", async (t) => {
  const control = browserControl(t, "success");
  const original = structuredClone(control.primary);
  const result = await control.run();
  assert.equal(result.operationSucceeded, true);
  assert.equal(result.cleanupComplete, true);
  assert.equal(result.result.passed, true);
  assert.equal(result.diagnosticOnly, true);
  assert.equal(result.canonicalQualification, false);
  assert.equal(result.dllAbsenceIndependentlyVerified, false);
  assert.deepEqual(control.events, [
    "execute-direct-python",
    "delete-profile",
    "remove-owned-root",
  ]);
  assert.deepEqual(control.primary, original);
});

for (const mode of [
  "browser-failure",
  "parse-failure",
  "unclosed",
  "delete-failure",
  "existing",
  "stock-mismatch",
] as const) {
  test(`direct browser ${mode} preserves result and exact resource ownership`, async (t) => {
    const control = browserControl(t, mode);
    const result = await control.run();
    if (mode === "browser-failure") {
      assert.equal(result.operationSucceeded, false);
      assert.equal(result.result.error, "original Chrome failure");
      assert.equal(result.execution.stderr, "ordinary Chrome stderr");
      assert.equal(result.cleanupComplete, true);
    } else if (mode === "parse-failure") {
      assert.equal(result.operationSucceeded, false);
      assert.equal(result.execution.stdout, "missing result\n");
      assert(result.error);
      assert.equal(result.cleanupComplete, true);
    } else if (mode === "unclosed") {
      assert.equal(result.childrenClosed, false);
      assert.equal(result.cleanupComplete, false);
      assert(control.directories.has(browserShare));
      assert.deepEqual(control.events, ["execute-direct-python"]);
    } else if (mode === "delete-failure") {
      assert.equal(result.cleanupComplete, false);
      assert.equal(result.cleanup.profileDeleted, false);
      assert.equal(result.cleanupErrors.length, 1);
    } else if (mode === "existing") {
      assert.equal(result.attempted, false);
      assert(result.error);
      assert(control.directories.has(browserShare));
      assert.deepEqual(control.events, []);
    } else {
      assert.equal(result.attempted, false);
      assert.equal(result.executorVariant, "stock");
      assert(result.error);
      assert.deepEqual(control.events, []);
      assert(!control.directories.has(browserShare));
    }
  });
}

test("Personal capture keeps native diagnostics separate from primary Python output", async () => {
  const result = await personalCommand(
    process.execPath,
    [
      "-e",
      `for(let i=0;i<100;i++)process.stderr.write('NEMOCLAW_MSYS_CONTEXT='+JSON.stringify({pid:process.pid,data:'x'.repeat(1000)})+'\\n');process.stdout.write('RESULT\\n');process.stderr.write('primary failure detail\\n');`,
    ],
    process.env,
    process.cwd(),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.childClosed, true);
  assert.equal(result.error, null);
  assert.equal(result.stdout, "RESULT\n");
  assert.equal(result.stderr, "primary failure detail\n");
  assert.equal(result.nativeRecordCount, 100);
  assert(result.nativeStderrBytes > 64 * 1024);
  assert.equal(result.outputExceeded, false);
  assert.equal(result.nativeOutputExceeded, false);
  assert(Number.isSafeInteger(result.pid) && result.pid! > 0);
});

test("Personal capture retains the primary 64 KiB bound and rejects malformed native evidence", async () => {
  const large = await personalCommand(
    process.execPath,
    ["-e", "process.stderr.write('x'.repeat(70000))"],
    process.env,
    process.cwd(),
  );
  assert.equal(large.outputExceeded, true);
  assert.equal(Buffer.byteLength(large.stderr), 64 * 1024);
  const malformed = await personalCommand(
    process.execPath,
    ["-e", "process.stderr.write('NEMOCLAW_MSYS_CONTEXT={bad}\\n')"],
    process.env,
    process.cwd(),
  );
  assert.equal(malformed.nativeParseErrors.length, 1);
  assert(malformed.error);
  assert.equal(malformed.nativeStderr, "NEMOCLAW_MSYS_CONTEXT={bad}\n");
});

test("Personal capture preserves an actual failure exit and reaps a timed out owned child", async () => {
  const failed = await personalCommand(
    process.execPath,
    ["-e", "process.stderr.write('actual exception\\n');process.exitCode=23"],
    process.env,
    process.cwd(),
  );
  assert.equal(failed.exitCode, 23);
  assert.equal(failed.childClosed, true);
  assert.equal(failed.stderr, "actual exception\n");
  const timed = await personalCommand(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    process.env,
    process.cwd(),
    50,
  );
  assert.equal(timed.timedOut, true);
  assert.equal(timed.childClosed, true);
});

const verifier = fileURLToPath(new URL("./verify-personal-candidate.py", import.meta.url));
const control = String.raw`
import hashlib,importlib.util,io,json,pathlib,sys,tarfile,traceback,zipfile
spec=importlib.util.spec_from_file_location('verifier',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=pathlib.Path(sys.argv[2]);mode=sys.argv[3]
sha=lambda b:hashlib.sha256(b).hexdigest()
hooks=['hermes-agent/venv/Lib/site-packages/nemoclaw_native_windows.py','hermes-agent/.hermes-runtime/python/cpython-3.11.16-windows-aarch64-none/Lib/site-packages/nemoclaw_native_windows.py','tools/browser-use/Lib/site-packages/nemoclaw_native_windows.py']
data=pathlib.Path(sys.argv[1]).with_name('nemoclaw_native_windows.py').read_bytes()
# This fixture's adapter bytes follow the current source; the production
# verifier keeps its immutable pin for the actual historical base artifact.
m.ADAPTER=sha(data)
files={name:data for name in hooks};files['asset.dat']=b'correct payload'
dirs=sorted({p.as_posix() for n in files for p in pathlib.PurePosixPath(n).parents if str(p)!='.'}|{'empty'},key=lambda n:(n.count('/'),n))
rows=[{'path':name,'bytes':len(value),'sha256':sha(value)} for name,value in files.items()]
rows.append({'path':'resource-link','linkTarget':'asset.dat'})
if mode=='outside':rows[-1]['linkTarget']='../outside'
if mode=='cycle':rows[-1]['linkTarget']='resource-link'
if mode=='parent-link':rows.append({'path':'resource-link/unlisted','bytes':0,'sha256':sha(b'')})
inventory={'files':rows,'directories':dirs}
adapt={'files':[row for row in rows if row['path'] in hooks]}
build={'status':'runtime-provisioned','sourceUnchanged':True,'fallbacks':[]}
encoded=lambda value:json.dumps(value).encode()
raw=io.BytesIO()
with tarfile.open(fileobj=raw,mode='w:gz') as tar:
 for directory in dirs:
  item=tarfile.TarInfo('runtime/'+directory);item.type=tarfile.DIRTYPE;tar.addfile(item)
 for name,value in files.items():
  if mode=='hash-drift' and name=='asset.dat':value=b'changed payload'
  item=tarfile.TarInfo('runtime/'+name);item.size=len(value);tar.addfile(item,io.BytesIO(value))
 item=tarfile.TarInfo('runtime/resource-link');item.type=tarfile.SYMTYPE;item.linkname=rows[-1].get('linkTarget','asset.dat');tar.addfile(item)
 if mode=='unlisted':
  item=tarfile.TarInfo('runtime/extra');item.size=1;tar.addfile(item,io.BytesIO(b'x'))
 if mode=='duplicate':
  item=tarfile.TarInfo('runtime/asset.dat');item.size=0;tar.addfile(item,io.BytesIO())
tarbytes=raw.getvalue()
candidate={'controllerSource':m.HEAD,'upstreamCommit':m.UPSTREAM,'status':'candidate-bytes-exported','completeByteInventory':True,'runtimeExecutionQualified':False,'installedAcceptance':False,'activationAllowed':False,'inventorySha256':sha(encoded(inventory)),'buildReceiptSha256':sha(encoded(build)),'adaptationReceiptSha256':sha(encoded(adapt)),'startupAdapterSha256':m.ADAPTER,'archive':{'file':'candidate.tar.gz','bytes':len(tarbytes),'sha256':sha(tarbytes)}}
if mode=='wrong-source':candidate['controllerSource']='0'*40
if mode=='wrong-adapter':candidate['startupAdapterSha256']='0'*64
if mode=='false-qualified':candidate['runtimeExecutionQualified']=True
zipfile_path=root/'artifact.zip'
with zipfile.ZipFile(zipfile_path,'w') as z:
 for name,value in [('runtime-candidate.json',candidate),('payload-inventory.json',inventory),('official-runtime-build.json',build),('native-adaptation.json',adapt)]:z.writestr('evidence/'+name,encoded(value))
 z.writestr('evidence/candidate.tar.gz',tarbytes)
expected_size=zipfile_path.stat().st_size;expected_hash=m.digest(zipfile_path)
if mode=='zip-hash':
 rawzip=bytearray(zipfile_path.read_bytes());rawzip[-1]^=1;zipfile_path.write_bytes(rawzip)
if mode=='zip-size':expected_size+=1
try:
 m.verify_zip(zipfile_path,expected_size,expected_hash)
 with zipfile.ZipFile(zipfile_path) as z:
  details=m.documents(z);size=m.verify_members(z,details)
  m.extract_verified(z,details,root/'runtime')
 result={'ok':True,'bytes':size,'regular':(root/'runtime/asset.dat').read_bytes().decode(),'link':(root/'runtime/resource-link').read_bytes().decode(),'empty':(root/'runtime/empty').is_dir()}
except BaseException as error:result={'ok':False,'error':str(error),'traceback':traceback.format_exc()[-12000:],'extracted':(root/'runtime').exists()}
print(json.dumps(result))
`;

function run(mode: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-candidate-"));
  try {
    const child = spawnSync(
      process.env.NEMOCLAW_TEST_PYTHON ?? "python3",
      ["-I", "-c", control, verifier, root, mode],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    const evidence = process.env.NEMOCLAW_PERSONAL_CONTROL_EVIDENCE;
    if (evidence)
      fs.writeFileSync(
        path.join(evidence, mode + ".json"),
        JSON.stringify(result, null, 2) + "\n",
        { flag: "wx" },
      );
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("verified nested bytes retain regular data, a safe link and an empty directory", () => {
  const result = run("valid");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.regular, "correct payload");
  assert.equal(result.link, "correct payload");
  assert.equal(result.empty, true);
});
for (const [mode, expected] of [
  ["zip-hash", /ZIP hash\/size mismatch/u],
  ["zip-size", /ZIP hash\/size mismatch/u],
  ["hash-drift", /file hash mismatch/u],
  ["outside", /leaves or misses/u],
  ["cycle", /Cyclic/u],
  ["parent-link", /traverses a link parent/u],
  ["unlisted", /size\/type/u],
  ["duplicate", /Duplicate nested/u],
  ["wrong-source", /unexpected identity/u],
  ["wrong-adapter", /wrong reviewed/u],
  ["false-qualified", /qualification claim/u],
] as const) {
  test(`${mode} refuses the candidate before runtime extraction`, () => {
    const result = run(mode);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.error, expected);
    assert.equal(result.extracted, false);
  });
}

test("Personal request matches the existing driver profile and keeps filesystem grants exact", () => {
  const request = personalRequest(
    "C:\\node\\node.exe",
    "C:\\node\\worker.mts",
    "C:\\runtime",
    "C:\\NemoClawMsysProof-1234567890ab-state-start",
    "1234567890abcdef12345678",
    "C:\\Windows",
  );
  assert.deepEqual(request.processContainer, {
    leastPrivilege: false,
    capabilities: ["privateNetworkClientServer", "internetClient"],
  });
  assert.deepEqual(request.network, {
    defaultPolicy: "allow",
    allowedHosts: [],
    blockedHosts: [],
    allowLocalNetwork: true,
  });
  assert.deepEqual(request.filesystem, {
    readonlyPaths: ["C:\\runtime", "C:\\node"],
    readwritePaths: ["C:\\NemoClawMsysProof-1234567890ab-state-start"],
  });
  assert.equal(request.ui.disable, false);
  assert.equal(request.containerId, "nm-1234567890ab-start");
  assert(
    request.process.commandLine.startsWith(
      '"C:\\runtime\\mxc-compat\\NemoClawMsysLauncher.exe" "--" "C:\\node\\node.exe"',
    ),
  );
  assert.equal(request.process.timeout, 120_000);
  assert(
    !request.process.env.some(
      (value) => value.startsWith("GH_TOKEN=") || value.startsWith("NVIDIA_API_KEY="),
    ),
  );
  assert(request.process.env.includes("HERMES_DISABLE_LAZY_INSTALLS=1"));
  assert(
    request.process.env.includes(
      "NEMOCLAW_AGENT_HOME=C:\\NemoClawMsysProof-1234567890ab-state-start",
    ),
  );
  assert(request.process.env.includes("TEMP=C:\\NemoClawMsysProof-1234567890ab-state-start\\temp"));
  assert(request.process.env.includes("HERMES_GIT_BASH_PATH=C:\\runtime\\git\\bin\\bash.exe"));
  assert(request.process.env.includes("NEMOCLAW_MSYS_TOKEN_INSPECTION_HOLD=repair-query"));
  assert(request.process.env.includes("NEMOCLAW_MSYS_DIAGNOSTICS=0"));
  assert(request.process.env.includes("AGENT_BROWSER_ARGS=--enable-logging=stderr"));
  assert(!request.process.env.some((entry) => entry.startsWith("NEMOCLAW_MSYS_TOKEN_INSPECTION=")));
  assert(
    !request.process.env.some((entry) => entry.startsWith("NEMOCLAW_HERMES_PRIVATE_DESKTOP=")),
  );
});
test("one bounded host desktop mask row permits only the bundled0x40 removal", () => {
  const row = {
    schemaVersion: 1,
    classification: "admitted-Hermes-desktop-creation",
    beforeMask: 0x3ff,
    afterMask: 0x3bf,
    removedMask: 0x40,
    bundledCreateAndSwitch: true,
    logoutRestrictionPreserved: true,
    everyOtherUiBitPreserved: true,
    hostDesktopGrantsAdded: false,
    childResumed: false,
  };
  const line = (value: any) => "NEMOCLAW_HERMES_DESKTOP_MASK=" + JSON.stringify(value) + "\n";
  assert.deepEqual(validateHermesDesktopMask("ordinary stderr\n" + line(row)), row);
  for (const change of [
    { afterMask: 0x33f },
    { beforeMask: 0 },
    { removedMask: 0xc0 },
    { logoutRestrictionPreserved: false },
    { everyOtherUiBitPreserved: false },
    { hostDesktopGrantsAdded: true },
    { childResumed: true },
    { classification: "other" },
    { extra: "x".repeat(2048) },
  ])
    assert.throws(() => validateHermesDesktopMask(line({ ...row, ...change })));
  assert.throws(() => validateHermesDesktopMask(""));
  assert.throws(() => validateHermesDesktopMask(line(row) + line(row)));
  assert.throws(() => validateHermesDesktopMask("NEMOCLAW_HERMES_DESKTOP_MASK=invalid\n"));
});
test("the fixed request rejects a command-line quote or invalid nonce", () => {
  assert.throws(
    () =>
      personalRequest(
        'C:\\bad"\\node.exe',
        "C:\\worker",
        "C:\\runtime",
        "C:\\share",
        "1234567890abcdef12345678",
        "C:\\Windows",
      ),
    /Invalid/u,
  );
  assert.throws(
    () =>
      personalRequest(
        "C:\\node.exe",
        "C:\\worker",
        "C:\\runtime",
        "C:\\share",
        "wrong",
        "C:\\Windows",
      ),
    /Invalid/u,
  );
});
test("component evidence requires one exact nonce and operation result", () => {
  const line =
    "NEMOCLAW_PERSONAL_RESULT=" +
    JSON.stringify({ schemaVersion: 1, component: "bash", nonce: "one", passed: false });
  assert.equal(parseComponent(line, "bash", "one").passed, false);
  const crashpad = 'NEMOCLAW_CRASHPAD_RESULT={"diagnosticOnly":true,"rawDumpRetained":false}';
  assert.deepEqual(
    parseComponent(crashpad + "\n" + line, "bash", "one"),
    parseComponent(line, "bash", "one"),
  );
  assert.throws(() => parseComponent(line, "browser", "one"), /identity/u);
  assert.throws(() => parseComponent(line, "bash", "two"), /identity/u);
  assert.throws(() => parseComponent(line + "\n" + line, "bash", "one"), /exactly one/u);
});

test("an unclosed executor retains its files until confirmed closure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-owner-"));
  const file = path.join(root, "owned.txt");
  try {
    fs.writeFileSync(file, "owned");
    assert.equal(removePersonalRoots([root], true, false).removed, false);
    assert.equal(fs.readFileSync(file, "utf8"), "owned");
    assert.deepEqual(removePersonalRoots([root], true, true), { removed: true, errors: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a real receipt write failure preserves the primary error and reports its own failure separately", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-receipt-"));
  try {
    const reports: unknown[] = [];
    assert.equal(
      publishPersonalReceipt(root, {}, new Error("original operation"), (value) =>
        reports.push(value),
      ),
      false,
    );
    assert.match(JSON.stringify(reports[0]), /original operation/u);
    assert.match(JSON.stringify(reports[1]), /receiptWriteError/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("browser probe retains error-only responses and requires the complete success envelope", () => {
  const check = String.raw`
import ast,json,pathlib,sys,traceback
source=pathlib.Path(sys.argv[1]);tree=ast.parse(source.read_text())
function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='browser_check')
operation=next(n for n in function.body if isinstance(n,ast.Try))
# Execute the exact response/assertion/handler slice only. No native browser,
# localhost server or cleanup process is executed by this portable control.
body=operation.body[1:]
assert isinstance(body[0],ast.Assign) and body[0].targets[0].id=='raw'
trial=ast.Try(body=body,handlers=operation.handlers,orelse=[],finalbody=[])
module=ast.fix_missing_locations(ast.Module(body=[trial],type_ignores=[]))
code=compile(module,str(source),'exec')
normal={'success':True,'exit_code':0,'output':'BROWSER_PERSONAL_OK'}
responses=[normal,{'error':'controlled exact upstream error-only response'},
 {'success':True,'output':'BROWSER_PERSONAL_OK'},
 {'success':True,'exit_code':False,'output':'BROWSER_PERSONAL_OK'},
 {'success':True,'exit_code':1,'output':'BROWSER_PERSONAL_OK'},
 {'success':True,'exit_code':0,'output':123},
 {'success':True,'exit_code':0,'output':'BROWSER_PERSONAL_OK','error':'failed'},
 {'success':False,'exit_code':0,'output':'BROWSER_PERSONAL_OK'},
 {'success':True,'exit_code':0,'output':'missing marker'}, ['not-an-envelope']]
for index,value in enumerate(responses):
 raw=json.dumps(value);context={'json':json,'browser_exec':lambda *a,**k:raw,'code':'not executed','session':'fixture','task':'fixture','result':None,'raw':None,'primary':None}
 exec(code,context)
 if index==0:assert context['primary']is None
 else:
  failure=context['primary'];assert isinstance(failure,AssertionError),type(failure)
  assert failure.__notes__==['Browser Use raw response: '+repr(raw)]
  assert raw in ''.join(traceback.format_exception(failure))
context={'json':json,'browser_exec':lambda *a,**k:'not json','code':'not executed','session':'fixture','task':'fixture','result':None,'raw':None,'primary':None}
exec(code,context);assert isinstance(context['primary'],json.JSONDecodeError);assert 'not json' in context['primary'].__notes__[0]
print(json.dumps({'responseCases':11,'nativeBrowserExecuted':False,'errorOnlyResponsePreserved':True}))
`;
  const result = spawnSync(
    process.env.NEMOCLAW_TEST_PYTHON ?? "python3",
    [
      "-I",
      "-B",
      "-c",
      check,
      fileURLToPath(new URL("./probe-personal-python.py", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).responseCases, 11);
});

test("completed replay binds a historical immutable base to the current controller", () => {
  const pin = completedPersonalReplayPin;
  const candidate = {
    controllerSource: pin.sourceRevision,
    inventorySha256: pin.inventorySha256,
    fileCount: 1,
    logicalBytes: 3,
  };
  const identity = { sha256: pin.candidateReceiptSha256 };
  const replay = {
    schemaVersion: 1,
    classification: "immutable-canonical-hermes-personal-replay",
    base: pin,
    controllerSource: "c".repeat(40),
    runtimeRoot: pin.runtimeRoot,
    completeZipVerified: true,
    completeNestedArchiveVerified: true,
    sourceBuildProvenanceVerified: true,
    runtimeRebuilt: false,
    runtimeRelocated: false,
    runtimeExported: false,
    runtimeExecutionQualified: false,
    installedAcceptance: false,
    before: {
      allFilesAndDirectoriesVerified: true,
      inventorySha256: pin.inventorySha256,
      files: 1,
      logicalBytes: 3,
    },
  };
  validatePersonalReplayInput(replay, candidate, identity, pin.runtimeRoot, "c".repeat(40));
  for (const changes of [
    { runtimeRebuilt: true },
    { controllerSource: "d".repeat(40) },
    { base: { ...pin, artifactId: 1 } },
    { before: { ...replay.before, inventorySha256: "0".repeat(64) } },
  ])
    assert.throws(() =>
      validatePersonalReplayInput(
        { ...replay, ...changes },
        candidate,
        identity,
        pin.runtimeRoot,
        "c".repeat(40),
      ),
    );
});

test("replay launches only the separately admitted readonly native component", () => {
  const nonce = "1234567890abcdef12345678";
  const args = [
    "C:\\node\\node.exe",
    "C:\\node\\worker.mts",
    "C:\\runtime",
    "C:\\NemoClawMsysProof-1234567890ab-state-start",
    nonce,
    "C:\\Windows",
  ] as const;
  const native = "C:\\NemoClawPersonalCompat-1234567890ab";
  const request = personalRequest(...args, native);
  assert(request.process.commandLine.startsWith('"' + native + '\\NemoClawMsysLauncher.exe"'));
  assert.deepEqual(request.filesystem.readonlyPaths, [args[2], "C:\\node", native]);
  assert.deepEqual(request.filesystem.readwritePaths, [args[3]]);
  assert.equal(request.process.timeout, 120000);
  assert.throws(() => personalRequest(...args, "C:\\outside"));
});

test("full replay post-inventory rejects changed, missing, and additional bytes", async () => {
  const { createHash } = await import("node:crypto");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "full-replay-inventory-"));
  try {
    fs.mkdirSync(path.join(root, "lib"));
    const file = path.join(root, "lib", "module.py");
    fs.writeFileSync(file, "abc");
    const expected = {
      directories: ["lib"],
      files: [
        {
          path: "lib/module.py",
          bytes: 3,
          sha256: createHash("sha256").update("abc").digest("hex"),
        },
      ],
    };
    assert.equal(verifyPersonalReplayInventory(root, expected, "a".repeat(64)).files, 1);
    fs.writeFileSync(file, "abd");
    assert.throws(() => verifyPersonalReplayInventory(root, expected, "a".repeat(64)));
    fs.unlinkSync(file);
    assert.throws(() => verifyPersonalReplayInventory(root, expected, "a".repeat(64)));
    fs.writeFileSync(file, "abc");
    fs.mkdirSync(path.join(root, "unexpected"));
    assert.throws(() => verifyPersonalReplayInventory(root, expected, "a".repeat(64)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function postDesktopObservation(initial: any) {
  const request = desktopAbsenceRequest(initial);
  return {
    attempted: true,
    request,
    requestIdentity: { sha256: "b".repeat(64) },
    error: null,
    execution: {
      childClosed: true,
      timedOut: false,
      outputExceeded: false,
      exitCode: 0,
      error: null,
    },
    receipt: {
      value: {
        schemaVersion: 1,
        classification: "post-executor-desktop-absence",
        requestSha256: "b".repeat(64),
        binding: initial.binding,
        appContainerSid: initial.appContainerSid,
        contextMatched: true,
        context: {
          hostSession: 2,
          stationName: "WinSta0",
          hostUserSid: request.hostUserSid,
          tokenHandleClosed: true,
          sidBufferFreed: true,
        },
        clock: "GetTickCount64",
        startedTick: 120,
        completedTick: 122,
        rows: initial.ownedNames.map((name: string) => ({
          name,
          requestedAccess: 0x20000,
          openFlags: 0,
          inheritRequested: false,
          present: false,
          absent: true,
          openError: 2,
          lookupHandleClosed: true,
          closeError: 0,
          startedTick: 120,
          completedTick: 121,
        })),
        attemptsPerName: 1,
        selectionAttempted: false,
        mutationAttempted: false,
        enumerationAttempted: false,
        error: null,
        passed: true,
      },
    },
  };
}

test("post-executor desktop absence preserves Drop failure and requires exact later readback", () => {
  const rows = desktopOwnerRows();
  rows[2].absentAfterOwnerClose = false;
  rows[2].absenceError = null;
  const execution = desktopOwnerExecution(rows),
    initial = inspectHermesDesktopCleanup(execution, desktopOwnerBinding);
  assert.equal(initial.passed, false);
  assert.equal(initial.identityAndCloseVerified, true);
  const post = postDesktopObservation(initial);
  const accepted = inspectHermesDesktopCleanup(execution, desktopOwnerBinding, post);
  assert.equal(accepted.passed, true);
  assert.equal(accepted.immediateDropAbsencePassed, false);
  assert.match(accepted.immediateDropAbsenceError.message, /absence/u);
  assert.equal(accepted.observerClosed, true);
  for (const change of [
    (x: any) => (x.receipt.value.rows[0].present = true),
    (x: any) => (x.receipt.value.rows[0].openError = 5),
    (x: any) => (x.receipt.value.rows[0].lookupHandleClosed = false),
    (x: any) => (x.receipt.value.rows[0].name = "Default"),
    (x: any) => (x.receipt.value.context.hostSession = 3),
    (x: any) => (x.receipt.value.startedTick = 99),
    (x: any) => (x.receipt.value.binding.executorPid = 999),
    (x: any) => (x.receipt.value.requestSha256 = "c".repeat(64)),
    (x: any) => (x.execution.exitCode = 1),
    (x: any) => (x.execution.outputExceeded = true),
  ]) {
    const bad = structuredClone(post);
    change(bad);
    assert.equal(inspectHermesDesktopCleanup(execution, desktopOwnerBinding, bad).passed, false);
  }
  for (const execution of [{ ...post.execution, childClosed: false }, null]) {
    const unclosed = { ...post, execution, error: { message: "unconfirmed observer" } };
    const value = inspectHermesDesktopCleanup(
      desktopOwnerExecution(rows),
      desktopOwnerBinding,
      unclosed,
    );
    assert.equal(value.passed, false);
    assert.equal(value.observerClosed, false);
  }
  rows[3].closed = false;
  assert.equal(
    inspectHermesDesktopCleanup(desktopOwnerExecution(rows), desktopOwnerBinding, post).passed,
    false,
  );
});

test("fixed desktop observer rejects unowned names/context and never accepts present or inaccessible lookups", () => {
  const helper = fileURLToPath(new URL("./probe-desktop-absence.py", import.meta.url));
  const program = String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('desktop',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
r=json.loads(sys.argv[2])
class API:
 def __init__(self,error=2,present=False,closed=True,session=2):self.error=error;self.present=present;self.closed=closed;self.session=session;self.names=[]
 def tick(self):return 120
 def context(self):return {'hostSession':self.session,'stationName':'WinSta0','hostUserSid':r['hostUserSid'],'tokenHandleClosed':True,'sidBufferFreed':True}
 def observe(self,name):
  self.names.append(name)
  return {'name':name,'absent':not self.present and self.error in (2,3),'lookupHandleClosed':self.closed,'closeError':0 if self.closed else 5}
for error,present,closed,passed in [(2,False,True,True),(3,False,True,True),(5,False,True,False),(0,True,True,False),(0,True,False,False)]:
 api=API(error,present,closed);value=m.observe(r,api);assert value['passed']==passed and api.names==r['names']
for bad in [dict(r,names=['Default']),dict(r,executorClosed=False),dict(r,afterDropTick=121)]:
 try:m.observe(bad,API());raise AssertionError('unexpected acceptance')
 except ValueError:pass
api=API(session=3)
try:m.observe(r,api);raise AssertionError('unexpected context acceptance')
except ValueError:assert not api.names
print('9 bounded desktop observer controls passed; no Windows execution')
`;
  const request = desktopAbsenceRequest(
    inspectHermesDesktopCleanup(desktopOwnerExecution(), desktopOwnerBinding),
  );
  const result = spawnSync("python3", ["-B", "-c", program, helper, JSON.stringify(request)], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

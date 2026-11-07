// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { retainedAcceptance } from "./qualify-finished-package.mts";
import { validateHermesRetainedTranscript } from "./qualify-installed-hermes.mts";
import {
  validateMaintenanceTransport,
  verifyMaintenanceInspectionInputs,
  type MaintenanceTransport,
  type PrivateInspectionInputs,
  type LauncherSourceIdentity,
} from "./verify-maintenance-inspection-inputs.mts";

type ByteIdentity = { bytes: number; sha256: string };
export const HERMES_INSPECTION_COMMAND = "native-state-inspection-v1";
export type InspectionHelperContract = {
  context: MaintenanceControllerContext;
  transport: MaintenanceTransport;
  helper: ByteIdentity;
  compiledLauncher: ByteIdentity;
  buildReceipt: ByteIdentity;
  commandSupportEvidence: ByteIdentity;
  command: string;
  arguments: string[];
  target: string;
  architecture: string;
  features: string[];
  lockedDependencies: boolean;
  staticCrt: boolean;
  sources: { file: string; bytes: number; sha256: string }[];
};

export function validateHermesInspectionHelperContract(
  expected: InspectionHelperContract,
  observed: InspectionHelperContract,
  privateInput?: PrivateInspectionInputs,
) {
  assert.equal(expected.command, HERMES_INSPECTION_COMMAND);
  assert.deepEqual(expected.arguments, ["--state-inspect", "hermes"]);
  assert.equal(expected.target, "aarch64-pc-windows-msvc");
  assert.equal(expected.architecture, "arm64");
  assert.deepEqual(expected.features, ["immutable-runtime"]);
  assert.equal(expected.lockedDependencies, true);
  assert.equal(expected.staticCrt, true);
  validateMaintenanceTransport(expected.transport);
  const context = expected.context;
  assert.match(context.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
  assert.match(context.workflow, /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u);
  validateMaintenanceTransport(context.transport);
  if (expected.transport.kind === "private-transfer")
    assert.deepEqual(expected.transport, context.transport);
  for (const field of ["runId", "runAttempt"] as const)
    assert.match(context[field], /^[1-9][0-9]*$/u);
  for (const field of ["controllerRevision", "candidateRevision"] as const)
    assert.match(context[field], /^[a-f0-9]{40}$/u);
  assert.match(context.observerSha256, /^[a-f0-9]{64}$/u);
  for (const proof of [
    expected.helper,
    expected.compiledLauncher,
    expected.buildReceipt,
    expected.commandSupportEvidence,
  ])
    byteIdentity(proof);
  assert.deepEqual(
    expected.helper,
    expected.compiledLauncher,
    "Inspection helper must match the package-selected compiled launcher",
  );
  assert(
    Array.isArray(expected.sources) &&
      expected.sources.length >= 5 &&
      expected.sources.length <= 512,
  );
  assert.equal(new Set(expected.sources.map((row) => row.file)).size, expected.sources.length);
  for (const source of expected.sources) {
    byteIdentity(source);
    assert.match(
      source.file,
      /^packaging\/windows\/launcher\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/u,
    );
    assert(!source.file.split("/").some((part) => part === "." || part === ".."));
  }
  for (const required of [
    "src/main.rs",
    "src/state_session.rs",
    "src/runtime_lease.rs",
    "Cargo.toml",
    "Cargo.lock",
  ])
    assert(expected.sources.some((row) => row.file === "packaging/windows/launcher/" + required));
  assert.deepEqual(observed, expected, "Inspection helper provenance or supported command differs");
  if (expected.transport.kind === "private-transfer") {
    assert(privateInput, "Private helper contract requires pinned transfer inputs");
    const transferred = validateHermesMaintenanceTransferInputs(
      context,
      expected.sources,
      privateInput,
    );
    assert.deepEqual(transferred.retainedLauncher, expected.helper);
    assert.deepEqual(
      transferred.buildReceipt,
      expected.buildReceipt,
      "Inspection helper build receipt differs from independent controller selection",
    );
  } else {
    assert.equal(privateInput, undefined);
  }
  return {
    command: HERMES_INSPECTION_COMMAND,
    arguments: ["--state-inspect", "hermes"],
    helper: { ...expected.helper },
    contractValidated: true,
    authenticatedProducerImplemented: false,
    invocationAdmitted: false,
  };
}

export function validateHermesInspectionReadiness(value: any, expectedRoot: string) {
  assert.match(expectedRoot, /^[A-Z]:\\NemoClawState-S-1-(?:\d+-)*\d+-hermes$/u);
  assert(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(
    Object.keys(value).sort(),
    ["schemaVersion", "kind", "agent", "stateRoot", "present", "leaseHeld"].sort(),
  );
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.kind, "native-state-inspection");
  assert.equal(value.agent, "hermes");
  assert.equal(value.stateRoot, expectedRoot);
  assert.equal(value.present, true, "Maintenance retention cannot accept absent state");
  assert.equal(value.leaseHeld, true);
  return { stateRoot: value.stateRoot, present: true, leaseHeld: true };
}

export function validateHermesInspectionRelease(
  value: any,
  expected: { processId: number; creationFileTime: string },
) {
  assert(Number.isSafeInteger(expected.processId) && expected.processId > 0);
  assert.match(expected.creationFileTime, /^[1-9][0-9]{0,19}$/u);
  assert.equal(value?.processId, expected.processId);
  assert.equal(value?.creationFileTime, expected.creationFileTime);
  assert.equal(value?.releaseRequested, true);
  assert.equal(value?.exitConfirmed, true);
  assert.equal(value?.exitCode, 0);
  assert.equal(value?.signalCode, null);
  assert.equal(value?.forced, false);
  assert.equal(value?.outputTruncated, false);
  return {
    ownerClosed: true,
    processId: expected.processId,
    creationFileTime: expected.creationFileTime,
  };
}
export type MaintenancePackagePins = {
  sourceRevision: string;
  productVersion: string;
  runtime: Record<string, any>;
  buildReceipt: ByteIdentity;
  assemblyReceipt: ByteIdentity;
};

function byteIdentity(value: ByteIdentity) {
  assert(Number.isSafeInteger(value.bytes) && value.bytes > 0);
  assert.match(value.sha256, /^[a-f0-9]{64}$/u);
}

export const HERMES_MAINTENANCE_CANDIDATE_POLICY =
  "hermes-maintenance-same-run-unsigned-candidate-v1";

export function hermesMaintenanceWindowsObserverSource() {
  return String.raw`# Source-only until the trusted controller admits its inputs.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$handles = [Collections.Generic.List[IO.FileStream]]::new()
$installer = $null
function Require($Condition) { if (-not $Condition) { throw 'Maintenance package observation failed.' } }
function Ordinary-Path([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    for ($item = $full; $item; $item = [IO.Path]::GetDirectoryName($item)) {
        Require (-not ([IO.File]::GetAttributes($item).HasFlag([IO.FileAttributes]::ReparsePoint)))
    }
    return $full
}
function Open-Artifact([string]$Path) {
    $full = Ordinary-Path $Path
    Require ([IO.File]::Exists($full))
    $stream = [IO.FileStream]::new($full, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try { $handles.Add($stream) } catch { $stream.Dispose(); throw }
    return $stream
}
function Digest($Stream) {
    $Stream.Position = 0
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToHexString($sha.ComputeHash($Stream)).ToLowerInvariant() } finally { $sha.Dispose() }
}
function Msi-Version([string]$Path) {
    $database = $null; $view = $null; $record = $null
    try {
        $database = $installer.OpenDatabase($Path, 0)
        $view = $database.OpenView('SELECT ' + [char]96 + 'Value' + [char]96 + ' FROM ' + [char]96 + 'Property' + [char]96 + ' WHERE ' + [char]96 + 'Property' + [char]96 + ' = ' + [char]39 + 'ProductVersion' + [char]39)
        $null = $view.Execute()
        $record = $view.Fetch()
        Require ($null -ne $record)
        $version = [string]$record.StringData(1)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record); $record = $null
        $record = $view.Fetch()
        Require ($null -eq $record)
        return $version
    } finally {
        if ($null -ne $record) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) }
        if ($null -ne $view) { try { $null = $view.Close() } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) } }
        if ($null -ne $database) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database) }
    }
}
try {
    Require ($env:OS -ceq 'Windows_NT' -and $env:GITHUB_ACTIONS -ceq 'true' -and $PSVersionTable.PSEdition -ceq 'Core')
    Require ($PSCommandPath -and $env:RUNNER_TEMP)
    $script = Open-Artifact $PSCommandPath
    $observerHash = Digest $script
    # Bound the stdin plan before parsing. No command text or arbitrary file list.
    $buffer = [char[]]::new(16385); $length = 0
    while ($length -lt $buffer.Length) {
        $count = [Console]::In.Read($buffer, $length, $buffer.Length - $length)
        if ($count -eq 0) { break }
        $length += $count
    }
    Require ($length -gt 0 -and $length -le 16384)
    $plan = ([string]::new($buffer, 0, $length)) | ConvertFrom-Json
    $keys = @($plan.PSObject.Properties.Name | Sort-Object)
    Require (($keys -join ',') -ceq 'controllerRevision,controllerRun,files,packageDirectory,productVersion,schemaVersion')
    Require ($plan.schemaVersion -eq 1 -and $plan.controllerRevision -cmatch '^[a-f0-9]{40}$' -and $plan.controllerRun -cmatch '^[1-9][0-9]*:[1-9][0-9]*$')
    Require ($plan.productVersion -cmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')
    $root = Ordinary-Path $plan.packageDirectory
    $temp = (Ordinary-Path $env:RUNNER_TEMP).TrimEnd('\')
    Require ([IO.Directory]::Exists($root) -and $root.StartsWith($temp + '\', [StringComparison]::OrdinalIgnoreCase))
    $names = @(('NemoClaw-' + $plan.productVersion + '-windows-arm64.msi'), ('NemoClawSetup-' + $plan.productVersion + '-windows-arm64.exe'))
    Require (@($plan.files).Count -eq 2)
    $rows = @()
    foreach ($name in $names) {
        $expected = @($plan.files | Where-Object { $_.file -ceq $name })
        Require ($expected.Count -eq 1)
        Require ($expected[0].bytes -is [int] -or $expected[0].bytes -is [long])
        Require ($expected[0].sha256 -cmatch '^[a-f0-9]{64}$' -and $expected[0].bytes -gt 0 -and $expected[0].bytes -le 8589934592)
        $path = Join-Path $root $name
        $stream = Open-Artifact $path
        Require ($stream.Length -eq $expected[0].bytes)
        $hash = Digest $stream
        Require ($hash -ceq $expected[0].sha256)
        $rows += @{ file=$name; path=$path; stream=$stream; bytes=$stream.Length; sha256=$hash }
    }
    # Both exact binaries remain held against writes/deletion for all observations.
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $observed = @()
    foreach ($row in $rows) {
        $signature = Get-AuthenticodeSignature -LiteralPath $row.path
        $version = if ($row.file.EndsWith('.msi', [StringComparison]::Ordinal)) { Msi-Version $row.path } else { [Diagnostics.FileVersionInfo]::GetVersionInfo($row.path).ProductVersion }
        Require ($version -cmatch '^([0-9]+\.[0-9]+\.[0-9]+)(?:\.0)?$')
        $normalizedVersion = $Matches[1]
        Require ($normalizedVersion -ceq $plan.productVersion)
        Require ($row.stream.Length -eq $row.bytes -and (Digest $row.stream) -ceq $row.sha256)
        $observed += @{ file=$row.file; bytes=$row.bytes; sha256=$row.sha256;
            controllerRevision=$plan.controllerRevision; controllerRun=$plan.controllerRun; observerSha256=$observerHash;
            signatureStatus=[string]$signature.Status; signerSubject=$(if ($null -eq $signature.SignerCertificate) { $null } else { [string]$signature.SignerCertificate.Subject });
            productVersion=$normalizedVersion; productMetadataVerified=$true }
    }
    [Console]::Out.WriteLine(($observed | ConvertTo-Json -Depth 4 -Compress))
} catch {
    [Console]::Error.WriteLine('The held maintenance package signature/metadata observation failed.')
    exit 1
} finally {
    if ($null -ne $installer) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) }
    foreach ($stream in $handles) { $stream.Dispose() }
}
`;
}
export type MaintenanceControllerContext = {
  repository: string;
  workflow: string;
  runId: string;
  runAttempt: string;
  transport: MaintenanceTransport;
  controllerRevision: string;
  candidateRevision: string;
  observerSha256: string;
};
type CandidateAuthorization = MaintenanceControllerContext & {
  policyId: string;
  purpose: string;
  buildReceipt: ByteIdentity;
  assemblyReceipt: ByteIdentity;
};
type CandidateObservation = ByteIdentity & {
  file: string;
  controllerRevision: string;
  controllerRun: string;
  observerSha256: string;
  signatureStatus: string;
  signerSubject: string | null;
  productVersion: string;
  productMetadataVerified: boolean;
};

// This validates the consumer contract only. It does not authenticate the input
// authorization or implement the independently trusted provenance/Windows observer.
export function validateHermesMaintenanceCandidateContract(
  context: MaintenanceControllerContext,
  authorization: CandidateAuthorization,
  pins: MaintenancePackagePins,
  packageIdentity: ReturnType<typeof validateHermesMaintenancePackageBytes>,
  observations: CandidateObservation[],
  privateTransfer?: { sources: LauncherSourceIdentity[]; input: PrivateInspectionInputs },
) {
  assert.equal(authorization.policyId, HERMES_MAINTENANCE_CANDIDATE_POLICY);
  assert.equal(authorization.purpose, "internal-candidate-maintenance-qualification");
  assert.match(context.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
  assert.match(context.workflow, /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u);
  validateMaintenanceTransport(context.transport);
  for (const field of ["runId", "runAttempt"] as const)
    assert.match(context[field], /^[1-9][0-9]*$/u);
  for (const field of ["controllerRevision", "candidateRevision"] as const)
    assert.match(context[field], /^[a-f0-9]{40}$/u);
  assert.match(context.observerSha256, /^[a-f0-9]{64}$/u);
  for (const field of Object.keys(context))
    assert.deepEqual(
      authorization[field as keyof MaintenanceControllerContext],
      context[field as keyof MaintenanceControllerContext],
    );
  assert.equal(pins.sourceRevision, context.candidateRevision);
  assert.deepEqual(authorization.buildReceipt, pins.buildReceipt);
  assert.deepEqual(authorization.assemblyReceipt, pins.assemblyReceipt);
  assert.equal(packageIdentity.byteIdentitiesBound, true);
  assert.equal(packageIdentity.sourceRevision, pins.sourceRevision);
  assert.equal(packageIdentity.expectedProductVersion, pins.productVersion);
  assert.deepEqual(packageIdentity.runtime, pins.runtime);
  let inspectionTransfer;
  if (context.transport.kind === "private-transfer") {
    assert(
      privateTransfer,
      "Private transfer requires supplied manifest/document bytes and independently selected sources",
    );
    inspectionTransfer = validateHermesMaintenanceTransferInputs(
      context,
      privateTransfer.sources,
      privateTransfer.input,
    );
    assert.deepEqual(inspectionTransfer.buildReceipt, pins.buildReceipt);
  } else {
    assert.equal(
      privateTransfer,
      undefined,
      "Artifact transport cannot silently fall back to private transfer",
    );
  }
  assert.equal(observations.length, 2);
  assert.deepEqual(
    observations.map((row) => row.file).sort(),
    packageIdentity.files.map((row) => row.file).sort(),
  );
  for (const observation of observations) {
    const binary = packageIdentity.files.find((row) => row.file === observation.file)!;
    byteIdentity(observation);
    assert.equal(observation.bytes, binary.bytes);
    assert.equal(observation.sha256, binary.sha256);
    assert.equal(observation.controllerRevision, context.controllerRevision);
    assert.equal(observation.controllerRun, `${context.runId}:${context.runAttempt}`);
    assert.equal(observation.observerSha256, context.observerSha256);
    assert.equal(
      observation.signatureStatus,
      "NotSigned",
      "Only positively observed unsigned candidates belong to this policy",
    );
    assert.equal(observation.signerSubject, null);
    assert.equal(observation.productMetadataVerified, true);
    assert.equal(observation.productVersion, pins.productVersion);
  }
  return {
    policyId: HERMES_MAINTENANCE_CANDIDATE_POLICY,
    purpose: "internal-candidate-maintenance-qualification",
    contractValidated: true,
    inspectionTransfer,
    signatures: observations.map(({ file, sha256, signatureStatus }) => ({
      file,
      sha256,
      signatureStatus,
    })),
    authenticatedProvenanceProducerImplemented: false,
    windowsObserverSourceImplemented: true,
    windowsObserverIntegrated: false,
    installationAdmitted: false,
    customerDownloadAcceptance: false,
    releaseAcceptance: false,
  };
}

export function validateHermesMaintenanceTransferInputs(
  context: MaintenanceControllerContext,
  expectedSources: LauncherSourceIdentity[],
  input: PrivateInspectionInputs,
) {
  assert.match(context.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
  assert.match(context.workflow, /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u);
  for (const revision of [context.controllerRevision, context.candidateRevision])
    assert.match(revision, /^[a-f0-9]{40}$/u);
  assert.match(context.observerSha256, /^[a-f0-9]{64}$/u);
  return verifyMaintenanceInspectionInputs(
    {
      transport: context.transport,
      sourceRevision: context.candidateRevision,
      runId: context.runId,
      runAttempt: context.runAttempt,
      sources: expectedSources,
    },
    input,
  );
}

export function validateHermesMaintenancePackageBytes(
  pins: MaintenancePackagePins,
  buildBytes: Buffer,
  assemblyBytes: Buffer,
  observedFiles: { file: string; bytes: number; sha256: string }[],
) {
  assert.match(pins.sourceRevision, /^[a-f0-9]{40}$/u);
  assert.match(pins.productVersion, /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u);
  for (const [bytes, identity] of [
    [buildBytes, pins.buildReceipt],
    [assemblyBytes, pins.assemblyReceipt],
  ] as const) {
    byteIdentity(identity);
    assert(Buffer.isBuffer(bytes) && bytes.length <= 2 * 1024 * 1024);
    assert.equal(bytes.length, identity.bytes);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      identity.sha256,
      "Package receipt differs from its independent controller pin",
    );
  }
  const build = JSON.parse(buildBytes.toString("utf8"));
  const assembly = JSON.parse(assemblyBytes.toString("utf8"));
  assert.equal(build.schemaVersion, 1);
  assert.equal(build.classification, "finished-native-runtime-package-build");
  assert.equal(build.status, "candidate-built-for-installed-qualification");
  assert.equal(build.sourceRevision, pins.sourceRevision);
  assert.equal(assembly.schemaVersion, 1);
  assert.equal(assembly.classification, "windows-immutable-runtime-assembly");
  assert.equal(assembly.deliveryContract, "finished-native-app-v1");
  assert.equal(assembly.buildCompleteForSelectedAgents, true);
  assert(Array.isArray(assembly.agents) && assembly.agents.length === 1);
  assert.equal(assembly.agents[0].agent, "hermes");
  for (const key of [
    "runtimeId",
    "manifestSha256",
    "sourceRevision",
    "nodeSha256",
    "nodeVersion",
  ]) {
    assert.match(
      pins.runtime[key],
      key === "nodeVersion"
        ? /^22\.23\.2$/u
        : key === "sourceRevision"
          ? /^[a-f0-9]{40}$/u
          : /^[a-f0-9]{64}$/u,
    );
    assert.equal(build.runtime?.[key], pins.runtime[key]);
    assert.equal(assembly.runtime?.[key], pins.runtime[key]);
  }
  assert.equal(pins.runtime.sourceRevision, pins.sourceRevision);
  const names = [
    `NemoClaw-${pins.productVersion}-windows-arm64.msi`,
    `NemoClawSetup-${pins.productVersion}-windows-arm64.exe`,
  ];
  assert(Array.isArray(build.files) && build.files.length === names.length);
  assert.equal(observedFiles.length, names.length);
  for (const rows of [build.files, observedFiles]) {
    assert.deepEqual(rows.map((row: any) => row.file).sort(), [...names].sort());
    for (const row of rows) byteIdentity(row);
  }
  for (const name of names) {
    const expected = build.files.find((row: any) => row.file === name);
    const actual = observedFiles.find((row) => row.file === name)!;
    assert.equal(actual.bytes, expected.bytes);
    assert.equal(actual.sha256, expected.sha256, "Package binary differs from the pinned build");
  }
  return {
    sourceRevision: pins.sourceRevision,
    runtime: pins.runtime,
    expectedProductVersion: pins.productVersion,
    files: observedFiles.map((row) => ({ ...row })),
    byteIdentitiesBound: true,
    signerQualified: false,
    productMetadataVerified: false,
    installationAdmitted: false,
  };
}

export type MaintenanceBaseline = {
  acceptance: Record<string, any>;
  runtime: Record<string, any>;
  configuration: string;
  controllerRun: string;
};

export function validateHermesMaintenanceBaseline(input: MaintenanceBaseline) {
  const stateRoot = retainedAcceptance(
    "hermes",
    input.acceptance,
    input.runtime,
    input.configuration,
    input.controllerRun,
  );
  const results = input.acceptance.results;
  const selected = JSON.parse(input.configuration);
  assert.equal(selected.agent, "hermes");
  assert.equal(selected.model, results.dashboardModel);
  assert.equal(typeof selected.model, "string");
  assert(selected.model.length > 0 && selected.model.length <= 512);
  assert.equal(results.configuration?.nativeOnboardingUsed, true);
  assert.equal(results.nvidia?.value?.role, "assistant");
  assert.match(results.nvidia?.value?.content?.trim() ?? "", /^NEMOCLAW_NVIDIA_[a-f0-9]{20}$/u);
  assert.equal(results.toolsScope?.executeCodeToolBootstrap, true);
  assert.equal(results.toolsScope?.fileWriteReadDeleteViaTerminal, true);
  assert.equal(results.browserToolScope?.localBundledBrowserExecuted, false);
  const conversation = results.retainedConversation;
  assert.match(conversation?.storedSessionId ?? "", /^[A-Za-z0-9_-]{1,128}$/u);
  assert.match(conversation?.profileName ?? "", /^[A-Za-z0-9_-]{1,128}$/u);
  assert.match(conversation?.transcriptSha256 ?? "", /^[a-f0-9]{64}$/u);
  assert(
    Number.isSafeInteger(conversation.messageCount) &&
      conversation.messageCount > 0 &&
      conversation.messageCount < 500,
  );
  assert(Number.isSafeInteger(conversation.lastMessageId) && conversation.lastMessageId > 0);
  return { stateRoot, selectedModel: selected.model, conversation };
}

export type MaintenanceAction = "repair" | "uninstall" | "reinstall" | "upgrade";
export type TransactionResult = {
  completion: "confirmed" | "unconfirmed";
  exitCode: number | null;
  elapsedMs: number;
};

// Observe only the caller-spawned installer process. Its exit does not by itself
// prove registration, runtime integrity or retained data; those checks stay separate.
export async function observeHermesMaintenanceProcess(child: ChildProcess, deadlineMs = 1800000) {
  assert(Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 1800000);
  assert(Number.isSafeInteger(child.pid) && child.pid! > 0, "Installer process did not start");
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let close!: (code: number | null, signal: NodeJS.Signals | null) => void;
  let error!: () => void;
  try {
    return await new Promise<{
      processId: number;
      processExitConfirmed: boolean;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      elapsedMs: number;
      failure: "deadline" | "process-error" | null;
    }>((resolve) => {
      const finish = (
        processExitConfirmed: boolean,
        exitCode: number | null,
        signalCode: NodeJS.Signals | null,
        failure: "deadline" | "process-error" | null,
      ) =>
        resolve({
          processId: child.pid!,
          processExitConfirmed,
          exitCode,
          signalCode,
          elapsedMs: performance.now() - started,
          failure,
        });
      close = (code, signal) => finish(true, code, signal, null);
      error = () => finish(false, null, null, "process-error");
      child.once("close", close);
      child.once("error", error);
      timer = setTimeout(() => finish(false, null, null, "deadline"), deadlineMs);
      if (child.exitCode !== null || child.signalCode !== null)
        close(child.exitCode, child.signalCode);
    });
  } finally {
    clearTimeout(timer);
    child.removeListener("close", close);
    child.removeListener("error", error);
  }
}
export type PreservationCheckpoint = {
  stateRoot: string;
  configurationSha256: string;
  historySha256: string;
  inspectionOwnerClosed: boolean;
  runtimeOwnerClosed: boolean;
  applicationProcessesClosed: boolean;
};

function validateCheckpoint(
  value: PreservationCheckpoint,
  baseline: ReturnType<typeof validateHermesMaintenanceBaseline>,
) {
  assert.equal(value.stateRoot, baseline.stateRoot);
  assert.match(value.configurationSha256, /^[a-f0-9]{64}$/u);
  assert.match(value.historySha256, /^[a-f0-9]{64}$/u);
  assert.equal(value.inspectionOwnerClosed, true);
  assert.equal(value.runtimeOwnerClosed, true);
  assert.equal(value.applicationProcessesClosed, true);
}

export type MaintenanceBindings = {
  // Live implementations must bind package bytes/signature/receipts and native
  // ownership. This sequencing layer alone cannot establish installed acceptance.
  verifyPrerequisites(): Promise<void>;
  checkpoint(): Promise<PreservationCheckpoint>;
  transact(action: MaintenanceAction): Promise<TransactionResult>;
  verifyInstallation(present: boolean): Promise<void>;
  warm(previous: Record<string, any>): Promise<Record<string, any>>;
};

export async function runHermesMaintenanceSequence(
  input: MaintenanceBaseline,
  bindings: MaintenanceBindings,
) {
  const baseline = validateHermesMaintenanceBaseline(input);
  const operations: { action: MaintenanceAction; result: TransactionResult }[] = [];
  const receipt = {
    schemaVersion: 1,
    classification: "hermes-maintenance-sequence",
    controllerRun: input.controllerRun,
    runtime: input.runtime,
    stateRoot: baseline.stateRoot,
    operations,
    repair: "unqualified",
    uninstallReinstall: "unqualified",
    upgrade: "unqualified-no-bound-package-pair",
    failure: null as string | null,
    failedStage: null as string | null,
    dataRemovalRequested: false,
    maintenanceAcceptance: false,
    liveBindingsImplemented: false,
  };
  let transactionUnconfirmed = false;
  let stage = "prerequisites";
  let previousAcceptance = input.acceptance;
  const replies = new Set([input.acceptance.results.nvidia.value.content]);
  try {
    await bindings.verifyPrerequisites();
    const snapshot = async () => {
      stage = "preservation-checkpoint";
      const value = await bindings.checkpoint();
      validateCheckpoint(value, baseline);
      return value;
    };
    const preserve = (before: PreservationCheckpoint, after: PreservationCheckpoint) => {
      assert.equal(
        after.configurationSha256,
        before.configurationSha256,
        "Maintenance changed saved configuration",
      );
      assert.equal(
        after.historySha256,
        before.historySha256,
        "Maintenance changed saved history before a new reply",
      );
    };
    const transact = async (action: MaintenanceAction) => {
      assert.equal(
        transactionUnconfirmed,
        false,
        "A previous Windows Installer transaction remains unconfirmed",
      );
      stage = action;
      transactionUnconfirmed = true;
      const result = await bindings.transact(action);
      operations.push({ action, result });
      assert(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
      if (result.completion !== "confirmed") {
        transactionUnconfirmed = true;
        throw new Error(
          "Windows Installer completion is unconfirmed; no retry or further operation is permitted",
        );
      }
      transactionUnconfirmed = false;
      assert.equal(result.exitCode, 0, "Maintenance transaction failed");
    };
    const warm = async () => {
      stage = "warm-qualification";
      const previousConversation = previousAcceptance.results.retainedConversation;
      const result = await bindings.warm(previousAcceptance);
      assert.equal(result.verdict, "pass");
      assert.equal(result.classification, "installed-canonical-hermes-acceptance");
      assert.equal(result.controllerRun, input.controllerRun);
      assert.deepEqual(result.runtime, input.acceptance.runtime);
      assert.deepEqual(result.cleanupErrors, []);
      assert.equal(result.results?.configurationReused, true);
      assert.equal(result.results?.configurationPreserved, true);
      assert.deepEqual(result.results?.restoredConversation, previousConversation);
      assert.equal(result.results?.stateRoot, baseline.stateRoot);
      assert.equal(
        result.results?.configurationSha256,
        input.acceptance.results.configurationSha256,
      );
      assert.equal(result.results?.dashboardModel, baseline.selectedModel);
      const continued = result.results?.retainedConversation;
      assert.equal(continued?.storedSessionId, previousConversation.storedSessionId);
      assert.equal(continued?.profileName, previousConversation.profileName);
      assert(
        Number.isSafeInteger(continued?.messageCount) &&
          continued.messageCount > previousConversation.messageCount &&
          continued.messageCount < 500,
      );
      assert(
        Number.isSafeInteger(continued?.lastMessageId) &&
          continued.lastMessageId > previousConversation.lastMessageId &&
          continued.lastMessageId >= continued.messageCount,
      );
      assert.match(continued?.transcriptSha256 ?? "", /^[a-f0-9]{64}$/u);
      assert.notEqual(continued.transcriptSha256, previousConversation.transcriptSha256);
      assert.equal(result.results?.cleanup?.cleanupSucceeded, true);
      assert.equal(result.results?.cleanup?.stateRetained, true);
      assert.equal(result.results?.nvidia?.value?.role, "assistant");
      assert.match(
        result.results?.nvidia?.value?.content?.trim() ?? "",
        /^NEMOCLAW_NVIDIA_[a-f0-9]{20}$/u,
      );
      assert.equal(
        replies.has(result.results.nvidia.value.content),
        false,
        "Maintenance must obtain a fresh provider response",
      );
      replies.add(result.results.nvidia.value.content);
      previousAcceptance = result;
    };
    const beforeRepair = await snapshot();
    assert.equal(beforeRepair.configurationSha256, input.acceptance.results.configurationSha256);
    await transact("repair");
    await bindings.verifyInstallation(true);
    preserve(beforeRepair, await snapshot());
    await warm();
    receipt.repair = "sequence-verified";
    const beforeUninstall = await snapshot();
    await transact("uninstall");
    await bindings.verifyInstallation(false);
    preserve(beforeUninstall, await snapshot());
    await transact("reinstall");
    await bindings.verifyInstallation(true);
    preserve(beforeUninstall, await snapshot());
    await warm();
    receipt.uninstallReinstall = "sequence-verified";
  } catch {
    // Never start a cleanup installer transaction after failed or lost observation.
    // Deliberately retained qualification data is not a leaked transaction resource.
    receipt.failedStage = stage;
    receipt.failure = transactionUnconfirmed
      ? "Windows Installer completion is unconfirmed; no retry or further operation is permitted"
      : "Hermes maintenance sequencing failed; retain diagnostics through the redacted binding owner";
  }
  return receipt;
}

export function verifyMaintenanceConversation(
  baseline: ReturnType<typeof validateHermesMaintenanceBaseline>,
  detail: any,
) {
  return validateHermesRetainedTranscript(baseline.conversation, detail);
}

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export type MaintenanceTransport =
  | { kind: "actions-artifact"; artifactId: string }
  | {
      kind: "private-transfer";
      manifestSha256: string;
      transferKind: "finished-installer";
      agent: "hermes";
    };
export type InputIdentity = { bytes: number; sha256: string };
export type LauncherSourceIdentity = InputIdentity & { file: string };
export type PrivateInspectionInputs = {
  manifestBytes: Buffer;
  documents: Record<string, Buffer>;
  retainedLauncher: Buffer;
  packagedLauncher: Buffer;
};
export const INSPECTION_TRANSFER_PATHS = {
  retained: "package/build/compiled-native/NemoClaw.exe",
  packaged: "package/build/payload/bin/NemoClaw.exe",
  materialization: "package/compiled-launcher.json",
  sources: "package/launcher-build-inputs.json",
  build: "package/immutable-package-build.json",
  capabilities: "package/build/launcher-capabilities.json",
} as const;

export function validateMaintenanceTransport(value: MaintenanceTransport) {
  assert(value && typeof value === "object" && !Array.isArray(value));
  if (value.kind === "actions-artifact") {
    assert.deepEqual(Object.keys(value).sort(), ["artifactId", "kind"]);
    assert.match(value.artifactId, /^[1-9][0-9]*$/u);
  } else {
    assert.equal(value.kind, "private-transfer");
    assert.deepEqual(Object.keys(value).sort(), [
      "agent",
      "kind",
      "manifestSha256",
      "transferKind",
    ]);
    assert.match(value.manifestSha256, /^[a-f0-9]{64}$/u);
    assert.equal(value.transferKind, "finished-installer");
    assert.equal(value.agent, "hermes");
  }
  return value;
}

function identity(value: InputIdentity, allowEmpty = false) {
  assert(value && Number.isSafeInteger(value.bytes) && value.bytes >= (allowEmpty ? 0 : 1));
  assert.match(value.sha256, /^[a-f0-9]{64}$/u);
}
function canonicalPath(value: string) {
  assert.equal(typeof value, "string");
  assert(value.length > 0 && value.length <= 4096 && !/[\\:\x00-\x1f\x7f]/u.test(value));
  assert(
    value.split("/").every((part) => part && part !== "." && part !== ".." && !/[. ]$/u.test(part)),
  );
  return value;
}
function hash(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
function verifyBytes(bytes: Buffer, expected: InputIdentity, limit: number) {
  identity(expected);
  assert(Buffer.isBuffer(bytes) && bytes.length <= limit);
  assert.equal(bytes.length, expected.bytes);
  assert.equal(
    hash(bytes),
    expected.sha256,
    "Inspection input bytes differ from independently pinned transfer",
  );
}

// Supplied bytes only: the shared transfer verifier still owns the complete live
// tree/ordinary-file checks. Neither this manifest nor its cache key authenticates itself.
export function verifyMaintenanceInspectionInputs(
  expected: {
    transport: MaintenanceTransport;
    sourceRevision: string;
    runId: string;
    runAttempt: string;
    sources: LauncherSourceIdentity[];
  },
  input: PrivateInspectionInputs,
) {
  validateMaintenanceTransport(expected.transport);
  assert.equal(expected.transport.kind, "private-transfer");
  if (expected.transport.kind !== "private-transfer") throw new Error("Private transfer required");
  assert.match(expected.sourceRevision, /^[a-f0-9]{40}$/u);
  assert.match(expected.runId, /^[1-9][0-9]*$/u);
  assert.match(expected.runAttempt, /^[1-9][0-9]*$/u);
  assert(
    Buffer.isBuffer(input.manifestBytes) &&
      input.manifestBytes.length > 0 &&
      input.manifestBytes.length <= 64 * 1024 * 1024,
  );
  assert.equal(
    hash(input.manifestBytes),
    expected.transport.manifestSha256,
    "Transfer manifest differs from independent producer output",
  );
  const manifest = JSON.parse(input.manifestBytes.toString("utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.classification, "same-run-private-executable-transfer");
  assert.equal(manifest.kind, "finished-installer");
  assert.equal(manifest.agent, "hermes");
  assert.equal(manifest.sourceRevision, expected.sourceRevision);
  assert.equal(manifest.workflowRunId, expected.runId);
  assert.equal(manifest.workflowRunAttempt, expected.runAttempt);
  assert(
    Array.isArray(manifest.files) && manifest.files.length >= 6 && manifest.files.length <= 250000,
  );
  const entries = new Map<string, InputIdentity>();
  const folded = new Set<string>();
  for (const row of manifest.files) {
    canonicalPath(row.path);
    identity(row, true);
    assert(!folded.has(row.path.toLowerCase()), "Transfer has duplicate or case-colliding paths");
    folded.add(row.path.toLowerCase());
    entries.set(row.path, row);
  }
  for (const required of Object.values(INSPECTION_TRANSFER_PATHS))
    assert(entries.has(required), "Required canonical inspection transfer entry missing");
  const docNames = [
    INSPECTION_TRANSFER_PATHS.materialization,
    INSPECTION_TRANSFER_PATHS.sources,
    INSPECTION_TRANSFER_PATHS.build,
    INSPECTION_TRANSFER_PATHS.capabilities,
  ];
  assert.deepEqual(Object.keys(input.documents).sort(), [...docNames].sort());
  const readDocument = (name: string) => {
    const bytes = input.documents[name];
    verifyBytes(bytes, entries.get(name)!, 2 * 1024 * 1024);
    return JSON.parse(bytes.toString("utf8"));
  };
  const build = readDocument(INSPECTION_TRANSFER_PATHS.build);
  const sources = readDocument(INSPECTION_TRANSFER_PATHS.sources);
  const materialization = readDocument(INSPECTION_TRANSFER_PATHS.materialization);
  const capabilityBytes = input.documents[INSPECTION_TRANSFER_PATHS.capabilities];
  verifyBytes(capabilityBytes, entries.get(INSPECTION_TRANSFER_PATHS.capabilities)!, 4096);
  const capability = JSON.parse(capabilityBytes.toString("utf8"));
  assert.deepEqual(Object.keys(capability).sort(), [
    "capabilities",
    "launcherSha256",
    "schemaVersion",
  ]);
  assert.equal(capability.schemaVersion, 1);
  assert.equal(capability.launcherSha256, entries.get(INSPECTION_TRANSFER_PATHS.retained)!.sha256);
  const declaration = capability.capabilities;
  assert(declaration && typeof declaration === "object" && !Array.isArray(declaration));
  const declarationKeys = ["guardianEnabled", "immutableRuntime", "kind", "schemaVersion"];
  const hasCommands = Object.hasOwn(declaration, "supportedCommands");
  if (hasCommands) declarationKeys.push("supportedCommands");
  assert.deepEqual(Object.keys(declaration).sort(), declarationKeys);
  assert.equal(declaration.schemaVersion, 1);
  assert.equal(declaration.kind, "native-runtime-capabilities");
  assert.equal(declaration.immutableRuntime, true);
  assert.equal(declaration.guardianEnabled, true);
  if (hasCommands) assert.deepEqual(declaration.supportedCommands, ["native-state-inspection-v1"]);
  const advertisedCommands = hasCommands ? [...declaration.supportedCommands] : [];
  verifyBytes(
    input.retainedLauncher,
    entries.get(INSPECTION_TRANSFER_PATHS.retained)!,
    32 * 1024 * 1024,
  );
  verifyBytes(
    input.packagedLauncher,
    entries.get(INSPECTION_TRANSFER_PATHS.packaged)!,
    32 * 1024 * 1024,
  );
  assert(
    input.retainedLauncher.equals(input.packagedLauncher),
    "Retained helper differs from package-selected launcher",
  );
  const executable = input.retainedLauncher;
  assert(executable.length >= 90 && executable.subarray(0, 2).toString("ascii") === "MZ");
  const offset = executable.readUInt32LE(60);
  assert(offset >= 64 && offset <= 4096 && offset + 26 <= executable.length);
  assert.equal(executable.subarray(offset, offset + 4).toString("binary"), "PE\0\0");
  assert.equal(executable.readUInt16LE(offset + 4), 0xaa64);
  assert(executable.readUInt16LE(offset + 20) >= 2);
  assert.equal(executable.readUInt16LE(offset + 22) & 0x2002, 2);
  assert.equal(executable.readUInt16LE(offset + 24), 0x20b);
  assert.equal(build.schemaVersion, 1);
  assert.equal(build.classification, "finished-native-runtime-package-build");
  assert.equal(build.status, "candidate-built-for-installed-qualification");
  assert.equal(build.sourceRevision, expected.sourceRevision);
  assert.equal(
    build.launcherCapabilitiesSha256,
    entries.get(INSPECTION_TRANSFER_PATHS.capabilities)!.sha256,
  );
  assert.equal(build.launcherBuildInputs?.file, "launcher-build-inputs.json");
  assert.equal(
    build.launcherBuildInputs?.bytes,
    entries.get(INSPECTION_TRANSFER_PATHS.sources)!.bytes,
  );
  assert.equal(
    build.launcherBuildInputs?.sha256,
    entries.get(INSPECTION_TRANSFER_PATHS.sources)!.sha256,
  );
  assert(Array.isArray(build.compiledArtifacts));
  const copies = build.compiledArtifacts.filter(
    (row: any) => row.file === "compiled-launcher.json",
  );
  assert.equal(copies.length, 1);
  assert.equal(copies[0].sha256, entries.get(INSPECTION_TRANSFER_PATHS.materialization)!.sha256);
  assert.equal(sources.schemaVersion, 1);
  assert.equal(sources.classification, "package-selected-launcher-build-inputs");
  assert.equal(sources.sourceRevision, expected.sourceRevision);
  assert.equal(sources.workflowRunId, expected.runId);
  assert.equal(sources.workflowRunAttempt, expected.runAttempt);
  assert.equal(sources.target, "aarch64-pc-windows-msvc");
  assert.equal(sources.rustToolchain, "1.95.0-aarch64-pc-windows-msvc");
  assert.deepEqual(sources.features, ["immutable-runtime"]);
  assert.equal(sources.lockedDependencies, true);
  assert.equal(sources.staticCrt, true);
  assert.equal(sources.capabilityObservation?.file, "build/launcher-capabilities.json");
  assert.equal(sources.capabilityObservation?.bytes, capabilityBytes.length);
  assert.equal(sources.capabilityObservation?.sha256, hash(capabilityBytes));
  assert.deepEqual(sources.capabilityObservation?.advertisedCommands, advertisedCommands);
  for (const flag of ["commandSupportValidated", "invocationAdmitted", "installedAcceptance"])
    assert.equal(sources[flag], false);
  for (const [property, file, name] of [
    ["retainedLauncher", "build/compiled-native/NemoClaw.exe", INSPECTION_TRANSFER_PATHS.retained],
    ["packagedLauncher", "build/payload/bin/NemoClaw.exe", INSPECTION_TRANSFER_PATHS.packaged],
    ["materialization", "compiled-launcher.json", INSPECTION_TRANSFER_PATHS.materialization],
  ]) {
    assert.equal(sources[property]?.file, file);
    assert.equal(sources[property]?.bytes, entries.get(name)!.bytes);
    assert.equal(sources[property]?.sha256, entries.get(name)!.sha256);
  }
  const sourceInventory = (rows: LauncherSourceIdentity[]) => {
    assert(Array.isArray(rows) && rows.length >= 5 && rows.length <= 512);
    const keys = new Set<string>();
    for (const row of rows) {
      canonicalPath(row.file);
      identity(row);
      assert(row.file.startsWith("packaging/windows/launcher/"));
      assert(!keys.has(row.file.toLowerCase()));
      keys.add(row.file.toLowerCase());
    }
    for (const name of [
      "Cargo.toml",
      "Cargo.lock",
      "src/main.rs",
      "src/state_session.rs",
      "src/runtime_lease.rs",
    ])
      assert(rows.some((row) => row.file === "packaging/windows/launcher/" + name));
    return rows
      .map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 }))
      .sort((a, b) => a.file.localeCompare(b.file));
  };
  assert.deepEqual(
    sourceInventory(sources.sources),
    sourceInventory(expected.sources),
    "Launcher sources differ from independent controller selection",
  );
  assert.equal(materialization.schemaVersion, 1);
  assert.equal(materialization.classification, "ci-native-compiled-artifact");
  assert.equal(materialization.status, "materialized");
  assert.equal(materialization.runtimeLaunchCopy, false);
  const retained = entries.get(INSPECTION_TRANSFER_PATHS.retained)!;
  for (const field of ["sourceSha256Before", "sourceSha256After", "outputSha256"])
    assert.equal(materialization[field], retained.sha256);
  assert.equal(materialization.outputStat?.bytes, retained.bytes);
  assert.equal(materialization.outputStat?.links, 1);
  return {
    transport: { ...expected.transport },
    retainedLauncher: { bytes: retained.bytes, sha256: retained.sha256 },
    buildReceipt: {
      bytes: entries.get(INSPECTION_TRANSFER_PATHS.build)!.bytes,
      sha256: entries.get(INSPECTION_TRANSFER_PATHS.build)!.sha256,
    },
    sourceRevision: expected.sourceRevision,
    sources: sourceInventory(expected.sources),
    provenanceBytesValidated: true,
    advertisedCommands,
    commandSupportValidated: false,
    invocationAdmitted: false,
    readyToRunMaintenance: false,
    installedAcceptance: false,
  };
}

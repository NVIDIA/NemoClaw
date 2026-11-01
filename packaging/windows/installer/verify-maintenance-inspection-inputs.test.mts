// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  INSPECTION_TRANSFER_PATHS as paths,
  verifyMaintenanceInspectionInputs,
  validateMaintenanceTransport,
} from "./verify-maintenance-inspection-inputs.mts";
import {
  validateHermesMaintenanceTransferInputs,
  validateHermesMaintenancePackageBytes,
  validateHermesMaintenanceCandidateContract,
  validateHermesInspectionHelperContract,
  HERMES_MAINTENANCE_CANDIDATE_POLICY,
} from "./qualify-installed-hermes-maintenance.mts";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const id = (bytes: Buffer) => ({ bytes: bytes.length, sha256: digest(bytes) });
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

function fixture() {
  const retained = Buffer.alloc(128);
  retained.write("MZ");
  retained.writeUInt32LE(64, 60);
  retained.write("PE\0\0", 64, "binary");
  retained.writeUInt16LE(0xaa64, 68);
  retained.writeUInt16LE(2, 84);
  retained.writeUInt16LE(2, 86);
  retained.writeUInt16LE(0x20b, 88);
  const revision = "a".repeat(40);
  const runtime = {
    runtimeId: "b".repeat(64),
    manifestSha256: "c".repeat(64),
    sourceRevision: revision,
    nodeSha256: "d".repeat(64),
    nodeVersion: "22.23.2",
  };
  const materialization: any = {
    schemaVersion: 1,
    classification: "ci-native-compiled-artifact",
    status: "materialized",
    runtimeLaunchCopy: false,
    sourceSha256Before: digest(retained),
    sourceSha256After: digest(retained),
    outputSha256: digest(retained),
    outputStat: { bytes: retained.length, links: 1 },
  };
  const sourceRows = [
    "Cargo.toml",
    "Cargo.lock",
    "src/main.rs",
    "src/state_session.rs",
    "src/runtime_lease.rs",
  ].map((file) => ({
    file: "packaging/windows/launcher/" + file,
    bytes: 10,
    sha256: "e".repeat(64),
  }));
  const sourceDoc: any = {
    schemaVersion: 1,
    classification: "package-selected-launcher-build-inputs",
    sourceRevision: revision,
    workflowRunId: "123",
    workflowRunAttempt: "1",
    target: "aarch64-pc-windows-msvc",
    rustToolchain: "1.95.0-aarch64-pc-windows-msvc",
    features: ["immutable-runtime"],
    lockedDependencies: true,
    staticCrt: true,
    sources: structuredClone(sourceRows),
    commandSupportValidated: false,
    invocationAdmitted: false,
    installedAcceptance: false,
  };
  const fixture = {
    capability: {
      schemaVersion: 1,
      launcherSha256: digest(retained),
      capabilities: {
        schemaVersion: 1,
        kind: "native-runtime-capabilities",
        immutableRuntime: true,
        guardianEnabled: true,
      },
    } as any,
    retained,
    packaged: Buffer.from(retained),
    materialization,
    sourceDoc,
    sourceRows: structuredClone(sourceRows),
    runtime,
    buildOverrides: {} as any,
    sourceOverrides: {} as any,
    manifestChange: (_value: any) => {},
    seal() {
      const capabilityBytes = json(this.capability);
      const materialBytes = json(this.materialization);
      const sourceBytes = json({
        ...this.sourceDoc,
        retainedLauncher: { file: "build/compiled-native/NemoClaw.exe", ...id(this.retained) },
        packagedLauncher: { file: "build/payload/bin/NemoClaw.exe", ...id(this.packaged) },
        materialization: { file: "compiled-launcher.json", ...id(materialBytes) },
        capabilityObservation: {
          file: "build/launcher-capabilities.json",
          ...id(capabilityBytes),
          advertisedCommands: this.capability.capabilities.supportedCommands ?? [],
        },
        ...this.sourceOverrides,
      });
      const binaryFiles = [
        { file: "NemoClaw-0.1.10-windows-arm64.msi", bytes: 100, sha256: "f".repeat(64) },
        { file: "NemoClawSetup-0.1.10-windows-arm64.exe", bytes: 200, sha256: "0".repeat(64) },
      ];
      const buildBytes = json({
        schemaVersion: 1,
        classification: "finished-native-runtime-package-build",
        sourceRevision: revision,
        status: "candidate-built-for-installed-qualification",
        runtime,
        launcherCapabilitiesSha256: digest(capabilityBytes),
        launcherBuildInputs: { file: "launcher-build-inputs.json", ...id(sourceBytes) },
        compiledArtifacts: [
          { file: "compiled-launcher.json", sha256: digest(materialBytes) },
          { file: "compiled-transaction-helper.json", sha256: "1".repeat(64) },
        ],
        files: binaryFiles,
        ...this.buildOverrides,
      });
      const documents = {
        [paths.materialization]: materialBytes,
        [paths.sources]: sourceBytes,
        [paths.build]: buildBytes,
        [paths.capabilities]: capabilityBytes,
      };
      const manifest: any = {
        schemaVersion: 1,
        classification: "same-run-private-executable-transfer",
        kind: "finished-installer",
        sourceRevision: revision,
        agent: "hermes",
        workflowRunId: "123",
        workflowRunAttempt: "1",
        files: [
          { path: paths.retained, ...id(this.retained) },
          { path: paths.packaged, ...id(this.packaged) },
          ...Object.entries(documents).map(([path, bytes]) => ({ path, ...id(bytes) })),
        ],
      };
      this.manifestChange(manifest);
      const manifestBytes = json(manifest);
      const transport = {
        kind: "private-transfer" as const,
        manifestSha256: digest(manifestBytes),
        transferKind: "finished-installer" as const,
        agent: "hermes" as const,
      };
      const context = {
        repository: "NVIDIA/NemoClaw",
        workflow: ".github/workflows/windows-native-installer-v2.yaml",
        runId: "123",
        runAttempt: "1",
        candidateRevision: revision,
        controllerRevision: "2".repeat(40),
        observerSha256: "3".repeat(64),
        transport,
      };
      return {
        expected: {
          transport,
          sourceRevision: revision,
          runId: "123",
          runAttempt: "1",
          sources: this.sourceRows,
        },
        context,
        input: {
          manifestBytes,
          documents,
          retainedLauncher: this.retained,
          packagedLauncher: this.packaged,
        },
        binaryFiles,
        buildBytes,
      };
    },
  };
  return fixture;
}

test("actual private transfer producer schemas bind retained launcher without numeric artifact IDs or command admission", () => {
  const x = fixture().seal();
  const result = verifyMaintenanceInspectionInputs(x.expected, x.input);
  assert.equal(result.provenanceBytesValidated, true);
  assert.equal(result.commandSupportValidated, false);
  assert.equal(result.invocationAdmitted, false);
  assert.equal(result.readyToRunMaintenance, false);
  assert.equal(result.installedAcceptance, false);
  assert.deepEqual(
    validateHermesMaintenanceTransferInputs(x.context, x.expected.sources, x.input),
    result,
  );
});

test("transfer digest is checked independently before JSON parse and cannot be a cache-key fallback", () => {
  const x = fixture().seal();
  const wrong = {
    ...x.expected,
    transport: { ...x.expected.transport, manifestSha256: "9".repeat(64) },
  };
  assert.throws(
    () => verifyMaintenanceInspectionInputs(wrong, x.input),
    /independent producer output/u,
  );
  assert.throws(
    () =>
      verifyMaintenanceInspectionInputs(x.expected, {
        ...x.input,
        manifestBytes: Buffer.from("{"),
      }),
    /independent producer output/u,
  );
  for (const transport of [
    { kind: "private-transfer", cacheKey: "cache" },
    { artifactId: "123" },
    { kind: "actions-artifact", artifactId: "0" },
    { kind: "actions-artifact", artifactId: 123 },
  ])
    assert.throws(() => validateMaintenanceTransport(transport as any));
  assert.doesNotThrow(() =>
    validateMaintenanceTransport({ kind: "actions-artifact", artifactId: "123" }),
  );
});

test("same manifest bytes under another independent run/source/attempt reject", () => {
  const x = fixture().seal();
  for (const change of [{ runId: "124" }, { runAttempt: "2" }, { sourceRevision: "9".repeat(40) }])
    assert.throws(() => verifyMaintenanceInspectionInputs({ ...x.expected, ...change }, x.input));
});

test("wrong manifest identity, duplicate/case-colliding and noncanonical paths reject with recomputed fixture pins", () => {
  for (const change of [
    (m: any) => {
      m.agent = "openclaw";
    },
    (m: any) => {
      m.kind = "compiled-application";
    },
    (m: any) => {
      m.schemaVersion = true;
    },
    (m: any) => {
      m.workflowRunId = 123;
    },
    (m: any) => {
      m.files.push({ ...m.files[0] });
    },
    (m: any) => {
      m.files.push({ ...m.files[0], path: m.files[0].path.toLowerCase() });
    },
    (m: any) => {
      m.files[0].path = "../" + m.files[0].path;
    },
    (m: any) => {
      m.files[0].path = m.files[0].path.replaceAll("/", "\\");
    },
    (m: any) => {
      m.files[0].path += ":alternate";
    },
    (m: any) => {
      m.files[0].bytes = true;
    },
    (m: any) => {
      m.files[0].sha256 = "9".repeat(64);
    },
  ]) {
    const f = fixture();
    f.manifestChange = change;
    const x = f.seal();
    assert.throws(() => verifyMaintenanceInspectionInputs(x.expected, x.input));
  }
});

test("document substitutions and changed size are rejected against the pinned manifest", () => {
  for (const path of [paths.materialization, paths.sources, paths.build, paths.capabilities]) {
    const x = fixture().seal();
    x.input.documents[path] = Buffer.concat([x.input.documents[path], Buffer.from(" ")]);
    assert.throws(() => verifyMaintenanceInspectionInputs(x.expected, x.input));
  }
});

test("old and inspection-capable declarations remain provenance only, never runnable support", () => {
  for (const commands of [undefined, ["native-state-inspection-v1"]]) {
    const f = fixture();
    if (commands) f.capability.capabilities.supportedCommands = commands;
    const x = f.seal();
    const result = validateHermesMaintenanceTransferInputs(x.context, x.expected.sources, x.input);
    assert.deepEqual(result.advertisedCommands, commands ?? []);
    assert.equal(result.commandSupportValidated, false);
    assert.equal(result.invocationAdmitted, false);
    assert.equal(result.readyToRunMaintenance, false);
  }
});

test("capability byte bindings, exact schema and declaration agreement reject substitutions", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.capability.launcherSha256 = "9".repeat(64);
    },
    (f: ReturnType<typeof fixture>) => {
      f.capability.schemaVersion = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.capability.extra = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.capability.capabilities.guardianEnabled = "true";
    },
    (f: ReturnType<typeof fixture>) => {
      f.capability.capabilities.immutableRuntime = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.capability.capabilities.kind = "other";
    },
    (f: ReturnType<typeof fixture>) => {
      f.capability.capabilities.supportedCommands = [];
    },
    (f: ReturnType<typeof fixture>) => {
      f.capability.capabilities.supportedCommands = ["native-state-session"];
    },
    (f: ReturnType<typeof fixture>) => {
      f.capability.capabilities.supportedCommands = [
        "native-state-inspection-v1",
        "native-state-inspection-v1",
      ];
    },
    (f: ReturnType<typeof fixture>) => {
      f.capability.capabilities.extra = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.buildOverrides.launcherCapabilitiesSha256 = "9".repeat(64);
    },
    (f: ReturnType<typeof fixture>) => {
      f.sourceOverrides.capabilityObservation = {
        file: "other",
        bytes: 1,
        sha256: "9".repeat(64),
        advertisedCommands: [],
      };
    },
    (f: ReturnType<typeof fixture>) => {
      f.sourceOverrides.capabilityObservation = undefined;
    },
  ]) {
    const f = fixture();
    change(f);
    const x = f.seal();
    assert.throws(() => verifyMaintenanceInspectionInputs(x.expected, x.input));
  }
  const f = fixture();
  f.capability.capabilities.supportedCommands = ["native-state-inspection-v1"];
  const x = f.seal();
  const source = JSON.parse(x.input.documents[paths.sources].toString());
  source.capabilityObservation.advertisedCommands = [];
  f.sourceOverrides.capabilityObservation = source.capabilityObservation;
  const mismatch = f.seal();
  assert.throws(() => verifyMaintenanceInspectionInputs(mismatch.expected, mismatch.input));
});

test("retained/package mismatch, wrong PE, materialization drift and missing build bindings reject", () => {
  for (const kind of [
    "different-packaged",
    "architecture",
    "materialization",
    "links",
    "source-binding",
    "compiled-binding",
  ]) {
    const f = fixture();
    if (kind === "different-packaged") f.packaged[100] = 1;
    if (kind === "architecture") {
      f.retained.writeUInt16LE(0x8664, 68);
      f.packaged.writeUInt16LE(0x8664, 68);
    }
    if (kind === "materialization") f.materialization.sourceSha256After = "9".repeat(64);
    if (kind === "links") f.materialization.outputStat.links = 2;
    if (kind === "source-binding")
      f.buildOverrides.launcherBuildInputs = {
        file: "launcher-build-inputs.json",
        bytes: 1,
        sha256: "9".repeat(64),
      };
    if (kind === "compiled-binding") f.buildOverrides.compiledArtifacts = [];
    const x = f.seal();
    assert.throws(() => verifyMaintenanceInspectionInputs(x.expected, x.input), kind);
  }
});

test("candidate source copies and promoted support flags cannot replace controller-selected sources", () => {
  for (const kind of [
    "source-digest",
    "source-missing",
    "source-duplicate",
    "commandSupportValidated",
    "invocationAdmitted",
    "installedAcceptance",
    "target",
    "staticCrt",
  ]) {
    const f = fixture();
    if (kind === "source-digest") f.sourceDoc.sources[0].sha256 = "9".repeat(64);
    else if (kind === "source-missing") f.sourceDoc.sources.pop();
    else if (kind === "source-duplicate") f.sourceDoc.sources.push({ ...f.sourceDoc.sources[0] });
    else if (kind === "target") f.sourceDoc.target = "x86_64-pc-windows-msvc";
    else if (kind === "staticCrt") f.sourceDoc.staticCrt = false;
    else f.sourceDoc[kind] = true;
    const x = f.seal();
    assert.throws(() => verifyMaintenanceInspectionInputs(x.expected, x.input), kind);
  }
});

test("private helper contract binds independent build receipt without granting invocation", () => {
  const f = fixture();
  f.capability.capabilities.supportedCommands = ["native-state-inspection-v1"];
  const x = f.seal();
  const expected = {
    context: x.context,
    transport: x.expected.transport,
    helper: id(f.retained),
    compiledLauncher: id(f.retained),
    buildReceipt: id(x.buildBytes),
    commandSupportEvidence: { bytes: 50, sha256: "4".repeat(64) },
    command: "native-state-inspection-v1",
    arguments: ["--state-inspect", "hermes"],
    target: "aarch64-pc-windows-msvc",
    architecture: "arm64",
    features: ["immutable-runtime"],
    lockedDependencies: true,
    staticCrt: true,
    sources: f.sourceRows,
  };
  const result = validateHermesInspectionHelperContract(
    expected,
    structuredClone(expected),
    x.input,
  );
  assert.equal(result.contractValidated, true);
  assert.equal(result.invocationAdmitted, false);
  assert.equal(result.authenticatedProducerImplemented, false);
  for (const change of [{ bytes: expected.buildReceipt.bytes + 1 }, { sha256: "9".repeat(64) }]) {
    const wrong = { ...expected, buildReceipt: { ...expected.buildReceipt, ...change } };
    assert.throws(
      () => validateHermesInspectionHelperContract(wrong, structuredClone(wrong), x.input),
      /build receipt differs from independent controller selection/u,
    );
  }
  assert.throws(() => validateHermesInspectionHelperContract(expected, structuredClone(expected)));
});

test("owned candidate maintenance entrypoint consumes private transfer and still refuses runnable admission", () => {
  const f = fixture();
  const x = f.seal();
  const assemblyBytes = json({
    schemaVersion: 1,
    classification: "windows-immutable-runtime-assembly",
    deliveryContract: "finished-native-app-v1",
    buildCompleteForSelectedAgents: true,
    agents: [{ agent: "hermes" }],
    runtime: f.runtime,
  });
  const pins = {
    sourceRevision: x.context.candidateRevision,
    productVersion: "0.1.10",
    runtime: f.runtime,
    buildReceipt: id(x.buildBytes),
    assemblyReceipt: id(assemblyBytes),
  };
  const packageIdentity = validateHermesMaintenancePackageBytes(
    pins,
    x.buildBytes,
    assemblyBytes,
    x.binaryFiles,
  );
  const authorization = {
    ...x.context,
    policyId: HERMES_MAINTENANCE_CANDIDATE_POLICY,
    purpose: "internal-candidate-maintenance-qualification",
    buildReceipt: pins.buildReceipt,
    assemblyReceipt: pins.assemblyReceipt,
  };
  const observations = x.binaryFiles.map((file) => ({
    ...file,
    controllerRevision: x.context.controllerRevision,
    controllerRun: "123:1",
    observerSha256: x.context.observerSha256,
    signatureStatus: "NotSigned",
    signerSubject: null,
    productVersion: "0.1.10",
    productMetadataVerified: true,
  }));
  const result = validateHermesMaintenanceCandidateContract(
    x.context,
    authorization,
    pins,
    packageIdentity,
    observations,
    { sources: f.sourceRows, input: x.input },
  );
  assert.equal(result.inspectionTransfer?.provenanceBytesValidated, true);
  assert.equal(result.inspectionTransfer?.readyToRunMaintenance, false);
  assert.equal(result.installationAdmitted, false);
  assert.throws(() =>
    validateHermesMaintenanceCandidateContract(
      x.context,
      authorization,
      pins,
      packageIdentity,
      observations,
    ),
  );
  assert.throws(() =>
    validateHermesInspectionHelperContract(
      {
        context: x.context,
        transport: x.expected.transport,
        helper: id(f.retained),
        compiledLauncher: id(f.retained),
      } as any,
      {} as any,
      x.input,
    ),
  );
});

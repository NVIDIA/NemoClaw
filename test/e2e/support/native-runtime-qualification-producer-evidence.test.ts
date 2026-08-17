// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NATIVE_RUNTIME_QUALIFICATION_PRODUCER_WORKFLOW } from "../../../src/lib/onboard/runtime-provider/native-qualification-authority.ts";
import { writeNativeRuntimeQualificationProducerEvidence } from "../../../tools/e2e/native-runtime-qualification-producer-evidence.mts";
import {
  buildNativeRuntimeQualificationProducerPlan,
  nativeRuntimeQualificationOperationFile,
  NATIVE_RUNTIME_QUALIFICATION_FOCUSED_CASE,
} from "../../../tools/e2e/native-runtime-qualification-producer-plan.mts";

const roots: string[] = [];
const INSTALLER = "#!/usr/bin/env bash\nexit 0\n";
const INSTALLER_SHA256 = createHash("sha256").update(INSTALLER).digest("hex");

function fixture(options: { readonly gpu?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-runtime-producer-evidence-"));
  roots.push(root);
  const plan = buildNativeRuntimeQualificationProducerPlan({
    source: {
      repository: "NVIDIA/NemoClaw",
      producerWorkflow: NATIVE_RUNTIME_QUALIFICATION_PRODUCER_WORKFLOW,
      pullRequestNumber: 8064,
      candidateRepository: "NVIDIA/NemoClaw",
      candidateSha: "a".repeat(40),
      baseRef: "main",
      baseSha: "b".repeat(40),
      workflowSha: "b".repeat(40),
      producerRunId: "123456789",
      producerRunAttempt: 1,
      dispatchArtifact: {
        id: "42",
        name: "e2e-dispatch-123456789-1",
        digest: `sha256:${"c".repeat(64)}`,
        sizeInBytes: 4096,
      },
    },
    installerSha256: INSTALLER_SHA256,
    arm64GpuRunner: "reviewed-native-arm64-gpu-runner",
  });
  const row = options.gpu
    ? plan.include.find(
        (entry) => entry.case.architecture === "arm64" && entry.case.acceleration === "nvidia-gpu",
      )!
    : plan.include.find((entry) => entry.id === NATIVE_RUNTIME_QUALIFICATION_FOCUSED_CASE)!;
  const installerDirectory = path.join(root, "installer");
  const executionDirectory = path.join(root, "candidate");
  const executionPath = path.join(executionDirectory, "execution.json");
  const evidenceDirectory = path.join(root, "evidence");
  fs.mkdirSync(installerDirectory);
  fs.mkdirSync(executionDirectory);
  fs.writeFileSync(path.join(installerDirectory, "installer.sh"), INSTALLER);
  fs.writeFileSync(
    path.join(installerDirectory, "invocation.json"),
    JSON.stringify({
      receiptVersion: 1,
      script: "scripts/install.sh",
      scriptSha256: INSTALLER_SHA256,
      candidateSha: row.source.candidateSha,
      architecture: row.case.architecture,
    }),
  );
  fs.writeFileSync(
    path.join(installerDirectory, "candidate-source.json"),
    JSON.stringify({
      receiptVersion: 1,
      repository: "https://github.com/NVIDIA/NemoClaw.git",
      revision: row.source.candidateSha,
      installerSha256: INSTALLER_SHA256,
    }),
  );
  fs.writeFileSync(
    path.join(installerDirectory, "installed-source.json"),
    JSON.stringify({
      receiptVersion: 1,
      repository: "https://github.com/NVIDIA/NemoClaw.git",
      requestedRevision: row.source.candidateSha,
      installedRevision: row.source.candidateSha,
      installMode: "managed",
      installerSha256: INSTALLER_SHA256,
    }),
  );
  fs.writeFileSync(
    path.join(installerDirectory, "architecture.json"),
    JSON.stringify({
      receiptVersion: 1,
      requested: row.case.architecture,
      runner: row.case.architecture,
    }),
  );
  const dockerPosture = {
    dockerCommandGuarded: true,
    dockerEnvironmentVariablesUnset: true,
    dockerServiceInactive: true,
    dockerSocketUnitInactive: true,
    dockerdProcessNameAbsent: true,
    defaultSocketPathsAbsent: true,
  };
  fs.writeFileSync(
    path.join(installerDirectory, "docker-absence.json"),
    JSON.stringify({
      receiptVersion: 1,
      preExecution: dockerPosture,
      postExecution: dockerPosture,
    }),
  );
  const execution = {
    schemaVersion: 1,
    kind: "nemoclaw-native-runtime-qualification-execution-v1",
    caseId: row.id,
    candidateSha: row.source.candidateSha,
    installerSha256: row.installerSha256,
    architecture: row.case.architecture,
    acceleration: row.case.acceleration,
    agent: row.case.agent,
    inference: row.case.inference,
    rootModes: row.rootModes,
    obligations: row.case.obligations,
    focusedOperations: row.focusedOperations,
    evidenceKinds: row.case.evidenceKinds,
    dockerUnavailable: { beforeCandidate: true, afterCandidate: true },
    credentialBoundary: {
      githubCredentialsAbsent: true,
      modelCredentialsAbsent: true,
      isolatedUid: true,
    },
    result: "passed",
  };
  fs.writeFileSync(executionPath, JSON.stringify(execution));
  fs.writeFileSync(
    path.join(executionDirectory, "runtime-result.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "nemoclaw-native-runtime-qualification-runtime-v1",
      caseId: row.id,
      result: "passed",
      details: { endpointAuthority: `podman-sha256:${"f".repeat(64)}` },
    }),
  );
  for (const id of row.case.obligations) {
    fs.writeFileSync(
      path.join(executionDirectory, nativeRuntimeQualificationOperationFile(id)),
      JSON.stringify({
        schemaVersion: 1,
        kind: "nemoclaw-native-runtime-qualification-operation-v1",
        caseId: row.id,
        operationId: id,
        result: "passed",
        details: { proof: id },
      }),
    );
  }
  const cdiReceipts =
    row.case.acceleration === "nvidia-gpu"
      ? [
          {
            schemaVersion: 1,
            kind: "nemoclaw-native-runtime-qualification-nvidia-cdi-v1",
            caseId: row.id,
            result: "passed",
            details: { device: "nvidia.com/gpu=all" },
          },
        ]
      : [];
  for (const receipt of cdiReceipts) {
    fs.writeFileSync(path.join(executionDirectory, "nvidia-cdi.json"), JSON.stringify(receipt));
  }
  fs.writeFileSync(
    path.join(executionDirectory, "case-evidence.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "nemoclaw-native-runtime-qualification-case-details-v1",
      caseId: row.id,
      runtime: {
        engineName: "Podman",
        engineVersion: "5.6.2",
        managedImages: [
          { role: "agent", digest: `sha256:${"1".repeat(64)}` },
          { role: "inference", digest: `sha256:${"2".repeat(64)}` },
        ],
        resultFile: "runtime-result.json",
      },
      operations: row.case.obligations.map((id) => ({
        id,
        file: nativeRuntimeQualificationOperationFile(id),
      })),
      ...(row.case.acceleration === "nvidia-gpu"
        ? { nvidiaCdi: { device: "nvidia.com/gpu=all", file: "nvidia-cdi.json" } }
        : {}),
    }),
  );
  return { evidenceDirectory, execution, executionPath, installerDirectory, root, row };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("native runtime qualification producer evidence", () => {
  it("emits the bounded case-evidence envelope after validating installer and execution receipts", () => {
    const value = fixture();

    writeNativeRuntimeQualificationProducerEvidence(
      value.row,
      value.installerDirectory,
      value.executionPath,
      value.evidenceDirectory,
    );

    expect(fs.readdirSync(value.evidenceDirectory).sort()).toEqual([
      "case-fragment.json",
      "receipts",
    ]);
    expect(
      JSON.parse(fs.readFileSync(path.join(value.evidenceDirectory, "case-fragment.json"), "utf8")),
    ).toMatchObject({
      schemaVersion: 1,
      kind: "nemoclaw-native-runtime-qualification-case-fragment-v1",
      qualificationId: "podman-protected-host-local-inference",
      providerId: "podman",
      source: value.row.source,
      case: value.row.case,
      installer: {
        architecture: value.row.case.architecture,
        dockerAvailability: "unavailable",
        exitCode: 0,
        providerId: "podman",
      },
      runtime: {
        agent: "openclaw",
        engineName: "Podman",
        engineVersion: "5.6.2",
        providerId: "podman",
      },
    });
    expect(fs.statSync(path.join(value.evidenceDirectory, "case-fragment.json")).mode & 0o777).toBe(
      0o600,
    );
    expect(
      fs.existsSync(
        path.join(value.evidenceDirectory, "receipts", value.row.id, "installer", "installer.sh"),
      ),
    ).toBe(true);
    const fragment = JSON.parse(
      fs.readFileSync(path.join(value.evidenceDirectory, "case-fragment.json"), "utf8"),
    ) as { installer: { script: { path: string; sha256: string } } };
    const copied = fs.readFileSync(
      path.join(value.evidenceDirectory, fragment.installer.script.path),
    );
    expect(createHash("sha256").update(copied).digest("hex")).toBe(
      fragment.installer.script.sha256,
    );
  });

  it("emits the NVIDIA CDI receipt for a GPU case", () => {
    const value = fixture({ gpu: true });

    writeNativeRuntimeQualificationProducerEvidence(
      value.row,
      value.installerDirectory,
      value.executionPath,
      value.evidenceDirectory,
    );

    const fragment = JSON.parse(
      fs.readFileSync(path.join(value.evidenceDirectory, "case-fragment.json"), "utf8"),
    ) as {
      installer: { architecture: string; script: { path: string; sha256: string } };
      nvidiaCdi: { artifact: { path: string; sha256: string } };
    };
    expect(fragment.installer.architecture).toBe("arm64");
    const copiedInstaller = fs.readFileSync(
      path.join(value.evidenceDirectory, fragment.installer.script.path),
    );
    expect(createHash("sha256").update(copiedInstaller).digest("hex")).toBe(
      fragment.installer.script.sha256,
    );
    const copiedCdi = fs.readFileSync(
      path.join(value.evidenceDirectory, fragment.nvidiaCdi.artifact.path),
    );
    expect(fragment.nvidiaCdi.artifact.path).toContain("/runtime/nvidia-cdi.json");
    expect(createHash("sha256").update(copiedCdi).digest("hex")).toBe(
      fragment.nvidiaCdi.artifact.sha256,
    );
  });

  it.each([
    [
      "candidate identity",
      (value: ReturnType<typeof fixture>) => ({ ...value.execution, candidateSha: "d".repeat(40) }),
    ],
    [
      "rootful focus",
      (value: ReturnType<typeof fixture>) => ({ ...value.execution, rootModes: ["rootless"] }),
    ],
    [
      "cleanup operation",
      (value: ReturnType<typeof fixture>) => ({
        ...value.execution,
        focusedOperations: value.row.focusedOperations.slice(0, -1),
      }),
    ],
    [
      "credential boundary",
      (value: ReturnType<typeof fixture>) => ({
        ...value.execution,
        credentialBoundary: {
          ...value.execution.credentialBoundary,
          githubCredentialsAbsent: false,
        },
      }),
    ],
    [
      "Docker boundary",
      (value: ReturnType<typeof fixture>) => ({
        ...value.execution,
        dockerUnavailable: { beforeCandidate: true, afterCandidate: false },
      }),
    ],
  ])("rejects an invalid %s receipt", (_label, mutate) => {
    const value = fixture();
    fs.writeFileSync(value.executionPath, JSON.stringify(mutate(value)));

    expect(() =>
      writeNativeRuntimeQualificationProducerEvidence(
        value.row,
        value.installerDirectory,
        value.executionPath,
        value.evidenceDirectory,
      ),
    ).toThrow("Native runtime qualification");
  });

  it("rejects a forged installer receipt", () => {
    const value = fixture();
    fs.writeFileSync(
      path.join(value.installerDirectory, "installer.sh"),
      `${INSTALLER}echo forged\n`,
    );

    expect(() =>
      writeNativeRuntimeQualificationProducerEvidence(
        value.row,
        value.installerDirectory,
        value.executionPath,
        value.evidenceDirectory,
      ),
    ).toThrow("installer receipt is invalid");
  });

  it("rejects unexpected files in the installer receipt directory", () => {
    const value = fixture();
    fs.writeFileSync(path.join(value.installerDirectory, "log.txt"), "candidate output");

    expect(() =>
      writeNativeRuntimeQualificationProducerEvidence(
        value.row,
        value.installerDirectory,
        value.executionPath,
        value.evidenceDirectory,
      ),
    ).toThrow("receipt files are invalid");
  });

  it("rejects a symbolic link used as the execution receipt", () => {
    const value = fixture();
    const target = path.join(value.root, "linked-execution.json");
    fs.renameSync(value.executionPath, target);
    fs.symlinkSync(target, value.executionPath);

    expect(() =>
      writeNativeRuntimeQualificationProducerEvidence(
        value.row,
        value.installerDirectory,
        value.executionPath,
        value.evidenceDirectory,
      ),
    ).toThrow("receipt file is invalid");
  });

  it("rejects an unexpected candidate-controlled receipt file", () => {
    const value = fixture();
    fs.writeFileSync(
      path.join(path.dirname(value.executionPath), "candidate.log"),
      "candidate output",
    );

    expect(() =>
      writeNativeRuntimeQualificationProducerEvidence(
        value.row,
        value.installerDirectory,
        value.executionPath,
        value.evidenceDirectory,
      ),
    ).toThrow("receipt files are invalid");
  });
});

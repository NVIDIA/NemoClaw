// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NATIVE_RUNTIME_QUALIFICATION_PRODUCER_WORKFLOW } from "../../../src/lib/onboard/runtime-provider/native-qualification-authority.ts";
import {
  aggregateNativeRuntimeQualificationProducerEvidence,
  NATIVE_RUNTIME_QUALIFICATION_AGGREGATE_EVIDENCE_FILE,
} from "../../../tools/e2e/native-runtime-qualification-producer-aggregate.mts";
import { writeNativeRuntimeQualificationProducerEvidence } from "../../../tools/e2e/native-runtime-qualification-producer-evidence.mts";
import {
  buildNativeRuntimeQualificationProducerPlan,
  nativeRuntimeQualificationOperationFile,
  type NativeRuntimeQualificationProducerPlanRow,
} from "../../../tools/e2e/native-runtime-qualification-producer-plan.mts";

const roots: string[] = [];
const INSTALLER = "#!/usr/bin/env bash\nexit 0\n";
const INSTALLER_SHA256 = createHash("sha256").update(INSTALLER).digest("hex");
const AGGREGATE_TEST_OPTIONS = { timeout: 15_000 } as const;

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function installerReceipts(
  directory: string,
  row: NativeRuntimeQualificationProducerPlanRow,
): void {
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "installer.sh"), INSTALLER);
  writeJson(path.join(directory, "invocation.json"), {
    receiptVersion: 1,
    script: "scripts/install.sh",
    scriptSha256: INSTALLER_SHA256,
    candidateSha: row.source.candidateSha,
    architecture: row.case.architecture,
  });
  writeJson(path.join(directory, "candidate-source.json"), {
    receiptVersion: 1,
    repository: "https://github.com/NVIDIA/NemoClaw.git",
    revision: row.source.candidateSha,
    installerSha256: INSTALLER_SHA256,
  });
  writeJson(path.join(directory, "installed-source.json"), {
    receiptVersion: 1,
    repository: "https://github.com/NVIDIA/NemoClaw.git",
    requestedRevision: row.source.candidateSha,
    installedRevision: row.source.candidateSha,
    installMode: "managed",
    installerSha256: INSTALLER_SHA256,
  });
  writeJson(path.join(directory, "architecture.json"), {
    receiptVersion: 1,
    requested: row.case.architecture,
    runner: row.case.architecture,
  });
  const posture = {
    dockerCommandGuarded: true,
    dockerEnvironmentVariablesUnset: true,
    dockerServiceInactive: true,
    dockerSocketUnitInactive: true,
    dockerdProcessNameAbsent: true,
    defaultSocketPathsAbsent: true,
  };
  writeJson(path.join(directory, "docker-absence.json"), {
    receiptVersion: 1,
    preExecution: posture,
    postExecution: posture,
  });
}

function candidateReceipts(
  directory: string,
  row: NativeRuntimeQualificationProducerPlanRow,
): string {
  fs.mkdirSync(directory);
  const executionPath = path.join(directory, "execution.json");
  writeJson(executionPath, {
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
  });
  writeJson(path.join(directory, "runtime-result.json"), {
    schemaVersion: 1,
    kind: "nemoclaw-native-runtime-qualification-runtime-v1",
    caseId: row.id,
    result: "passed",
    details: { engineAuthority: `podman-sha256:${"9".repeat(64)}` },
  });
  for (const id of row.case.obligations) {
    writeJson(path.join(directory, nativeRuntimeQualificationOperationFile(id)), {
      schemaVersion: 1,
      kind: "nemoclaw-native-runtime-qualification-operation-v1",
      caseId: row.id,
      operationId: id,
      result: "passed",
      details: { proof: id },
    });
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
    writeJson(path.join(directory, "nvidia-cdi.json"), receipt);
  }
  writeJson(path.join(directory, "case-evidence.json"), {
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
  });
  return executionPath;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-runtime-aggregate-"));
  roots.push(root);
  const plan = buildNativeRuntimeQualificationProducerPlan({
    source: {
      repository: "NVIDIA/NemoClaw",
      producerWorkflow: NATIVE_RUNTIME_QUALIFICATION_PRODUCER_WORKFLOW,
      pullRequestNumber: 9144,
      candidateRepository: "NVIDIA/NemoClaw",
      candidateSha: "a".repeat(40),
      baseRef: "main",
      baseSha: "b".repeat(40),
      workflowSha: "b".repeat(40),
      producerRunId: "7001",
      producerRunAttempt: 1,
      dispatchArtifact: {
        id: "42",
        name: "e2e-dispatch-7001-1",
        digest: `sha256:${"c".repeat(64)}`,
        sizeInBytes: 4096,
      },
    },
    installerSha256: INSTALLER_SHA256,
    arm64GpuRunner: "reviewed-arm64-gpu",
  });
  const artifactRoot = path.join(root, "case-artifacts");
  fs.mkdirSync(artifactRoot);
  for (const row of plan.include) {
    const rowRoot = path.join(root, "rows", row.id);
    fs.mkdirSync(rowRoot, { recursive: true });
    const installer = path.join(rowRoot, "installer");
    const candidate = path.join(rowRoot, "candidate");
    installerReceipts(installer, row);
    const execution = candidateReceipts(candidate, row);
    writeNativeRuntimeQualificationProducerEvidence(
      row,
      installer,
      execution,
      path.join(artifactRoot, row.artifactName),
    );
  }
  const evidenceDirectory = path.join(root, "aggregate");
  return { artifactRoot, evidenceDirectory, plan, root };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("native runtime qualification producer aggregate", () => {
  it(
    "binds the exact 24-case cohort to one protected aggregate job",
    AGGREGATE_TEST_OPTIONS,
    () => {
      const value = fixture();

      const envelope = aggregateNativeRuntimeQualificationProducerEvidence({
        plan: value.plan,
        caseArtifactRoot: value.artifactRoot,
        evidenceDirectory: value.evidenceDirectory,
        aggregateJobId: 811,
      });

      expect(envelope.cases).toHaveLength(24);
      expect(new Set(envelope.cases.map((entry) => entry.caseId)).size).toBe(24);
      expect(
        envelope.cases.every(
          (entry) =>
            entry.protectedRun.runId === 7001 &&
            entry.protectedRun.attempt === 1 &&
            entry.protectedRun.jobId === 811,
        ),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(value.evidenceDirectory, NATIVE_RUNTIME_QUALIFICATION_AGGREGATE_EVIDENCE_FILE),
        ),
      ).toBe(true);
    },
  );

  it("rejects replacing an existing aggregate output", AGGREGATE_TEST_OPTIONS, () => {
    const value = fixture();
    const sentinel = path.join(value.evidenceDirectory, "sentinel.txt");
    fs.mkdirSync(value.evidenceDirectory);
    fs.writeFileSync(sentinel, "preserve me");

    expect(() =>
      aggregateNativeRuntimeQualificationProducerEvidence({
        plan: value.plan,
        caseArtifactRoot: value.artifactRoot,
        evidenceDirectory: value.evidenceDirectory,
        aggregateJobId: 811,
      }),
    ).toThrow("output must not already exist");
    expect(fs.readFileSync(sentinel, "utf8")).toBe("preserve me");
  });

  it("rejects an omitted case artifact", AGGREGATE_TEST_OPTIONS, () => {
    const value = fixture();
    fs.renameSync(
      path.join(value.artifactRoot, value.plan.include[0]!.artifactName),
      path.join(value.root, "omitted"),
    );

    expect(() =>
      aggregateNativeRuntimeQualificationProducerEvidence({
        plan: value.plan,
        caseArtifactRoot: value.artifactRoot,
        evidenceDirectory: value.evidenceDirectory,
        aggregateJobId: 811,
      }),
    ).toThrow("cohort is incomplete or mixed");
  });

  it("rejects a symlink substituted for a candidate receipt", AGGREGATE_TEST_OPTIONS, () => {
    const value = fixture();
    const row = value.plan.include[0]!;
    const artifact = path.join(value.artifactRoot, row.artifactName);
    const receipt = path.join(artifact, "receipts", row.id, "runtime", "runtime-result.json");
    const target = path.join(value.root, "substituted.json");
    fs.renameSync(receipt, target);
    fs.symlinkSync(target, receipt);

    expect(() =>
      aggregateNativeRuntimeQualificationProducerEvidence({
        plan: value.plan,
        caseArtifactRoot: value.artifactRoot,
        evidenceDirectory: value.evidenceDirectory,
        aggregateJobId: 811,
      }),
    ).toThrow("cannot contain symlinks");
  });

  it("rejects a trusted plan with a mixed source cohort", AGGREGATE_TEST_OPTIONS, () => {
    const value = fixture();
    const first = value.plan.include[0]!;
    const mixedPlan = {
      include: [
        { ...first, source: { ...first.source, candidateSha: "d".repeat(40) } },
        ...value.plan.include.slice(1),
      ],
    };

    expect(() =>
      aggregateNativeRuntimeQualificationProducerEvidence({
        plan: mixedPlan,
        caseArtifactRoot: value.artifactRoot,
        evidenceDirectory: value.evidenceDirectory,
        aggregateJobId: 811,
      }),
    ).toThrow("source cohort");
  });

  it("rejects an unexpected file in a case artifact", AGGREGATE_TEST_OPTIONS, () => {
    const value = fixture();
    fs.writeFileSync(
      path.join(value.artifactRoot, value.plan.include[0]!.artifactName, "candidate.log"),
      "unexpected",
    );

    expect(() =>
      aggregateNativeRuntimeQualificationProducerEvidence({
        plan: value.plan,
        caseArtifactRoot: value.artifactRoot,
        evidenceDirectory: value.evidenceDirectory,
        aggregateJobId: 811,
      }),
    ).toThrow("invalid files");
  });

  it(
    "rejects a receipt whose bytes no longer match its trusted fragment",
    AGGREGATE_TEST_OPTIONS,
    () => {
      const value = fixture();
      const row = value.plan.include[0]!;
      fs.appendFileSync(
        path.join(
          value.artifactRoot,
          row.artifactName,
          "receipts",
          row.id,
          "runtime",
          "runtime-result.json",
        ),
        " ",
      );

      expect(() =>
        aggregateNativeRuntimeQualificationProducerEvidence({
          plan: value.plan,
          caseArtifactRoot: value.artifactRoot,
          evidenceDirectory: value.evidenceDirectory,
          aggregateJobId: 811,
        }),
      ).toThrow("does not match its SHA-256 digest");
    },
  );

  it("rejects an invalid aggregate job identity", AGGREGATE_TEST_OPTIONS, () => {
    const value = fixture();

    expect(() =>
      aggregateNativeRuntimeQualificationProducerEvidence({
        plan: value.plan,
        caseArtifactRoot: value.artifactRoot,
        evidenceDirectory: value.evidenceDirectory,
        aggregateJobId: 0,
      }),
    ).toThrow("aggregate job id is invalid");
  });
});

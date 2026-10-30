// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  revision,
  base,
  candidateCases,
  runCandidateAdmission,
  nativeTransferCases,
  runNativeTransfer,
  skipEvidenceProcesses,
} from "./windows-native-installer-process.support";

describe.skipIf(process.platform !== "linux")("credential-free candidate build admission", () => {
  it.each(candidateCases.filter((scenario) => scenario.accepted))(
    "admits $name without granting protected authority",
    (scenario) => {
      const { result, fields, outputExists } = runCandidateAdmission(scenario);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(outputExists).toBe(true);
      expect(fields).toEqual({
        request_kind: "candidate-build",
        candidate_repository: "NVIDIA/NemoClaw",
        candidate_sha: revision,
        base_sha: base,
        pr_number: "12014",
        workflow_sha: revision,
        agent: scenario.environment?.SELECTED_AGENT ?? "hermes",
        product_version: "0.1.10",
        validation_scope: "build-only",
        build_allowed: "true",
        trusted_main: "false",
        exact_workflow: "false",
        exact_pr: "true",
        credential_authorized: "false",
      });
    },
  );
  it.each(candidateCases.filter((scenario) => !scenario.accepted))(
    "rejects $name without granting authority",
    (scenario) => {
      const { result, fields, outputExists } = runCandidateAdmission(scenario);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).not.toBe(0);
      expect(outputExists).toBe(false);
      expect(fields).toBeNull();
    },
  );
});

it.skipIf(skipEvidenceProcesses)(
  "seals complete native Bash evidence without changing inputs",
  () => {
    const observation = runNativeTransfer("complete");
    expect(observation.result.error).toBeUndefined();
    expect(observation.result.status, observation.result.stdout + observation.result.stderr).toBe(
      0,
    );
    expect(observation.manifestText).not.toBeNull();
    const manifest = JSON.parse(observation.manifestText!);
    expect(manifest).toMatchObject({
      kind: "bash-compatibility",
      sourceRevision: observation.revision,
      agent: "hermes",
      workflowRunId: "123",
      workflowRunAttempt: "2",
    });
    const expectedFiles = observation.retained.map(([relative, content]) => ({
      path: "native-proof/bash-compat-evidence/" + relative,
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    }));
    expect(manifest.files).toHaveLength(expectedFiles.length);
    expect(manifest.files).toEqual(expect.arrayContaining(expectedFiles));
    expect(observation.transferredContents).toEqual(observation.retained);
    expect(observation.outputText).toContain(
      "manifest_sha256=" + createHash("sha256").update(observation.manifestText!).digest("hex"),
    );
    expect(observation.outputText).toContain(
      `cache_key=windows-finished-bash-v2-123-2-${observation.revision}-hermes`,
    );
    expect(observation.sourceContents).toEqual(observation.originalContents);
  },
);
it
  .skipIf(skipEvidenceProcesses)
  .each(nativeTransferCases.filter((scenario) => scenario !== "complete"))(
  "rejects native Bash transfer %s without changing inputs",
  (scenario) => {
    const observation = runNativeTransfer(scenario);
    expect(observation.result.error).toBeUndefined();
    expect(
      observation.result.status,
      observation.result.stdout + observation.result.stderr,
    ).not.toBe(0);
    expect(observation.manifestText).toBeNull();
    expect(observation.outputText).toBeNull();
    expect(observation.sourceContents).toEqual(observation.originalContents);
  },
);

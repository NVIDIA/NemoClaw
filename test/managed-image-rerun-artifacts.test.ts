// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

type Step = {
  name?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs?: Record<string, { steps?: Step[] }>;
};

const repoRoot = path.resolve(import.meta.dirname, "..");

function readYaml(file: string): Workflow {
  return YAML.parse(fs.readFileSync(path.join(repoRoot, file), "utf8")) as Workflow;
}

function requiredStep(steps: Step[] | undefined, name: string): Step {
  return (
    steps?.find((candidate) => candidate.name === name) ??
    (() => {
      throw new Error(`workflow is missing '${name}'`);
    })()
  );
}

function renderArtifactIdentity(value: unknown, runAttempt: number): string {
  return String(value)
    .replaceAll("${{ github.run_id }}", "32191102997")
    .replaceAll("${{ github.run_attempt }}", String(runAttempt))
    .replaceAll("${{ inputs.agent }}", "openclaw")
    .replaceAll("${{ matrix.agent }}", "openclaw")
    .replaceAll("${{ matrix.artifact_platform }}", "linux-amd64");
}

describe("managed-image failed-job rerun artifacts", () => {
  // source-shape-contract: security -- Producer artifact identity must remain exact when GitHub reuses a successful job during a failed-job rerun
  it("retains producer artifact identities during a failed-job rerun (#9529)", () => {
    const baseAction = readYaml(
      ".github/actions/publish-base-image-manifest/action.yaml",
    ) as Workflow & { runs?: { steps?: Step[] } };
    const workflow = readYaml(".github/workflows/managed-images.yaml");
    const publisher = workflow.jobs?.["build-and-validate"];
    const promoter = workflow.jobs?.promote;
    const baseUpload = requiredStep(baseAction.runs?.steps, "Upload managed base image contract");
    const baseDownload = requiredStep(publisher?.steps, "Download exact base image contract");
    const candidateUpload = requiredStep(
      publisher?.steps,
      "Upload validated managed image candidate",
    );
    const candidateDownload = requiredStep(
      promoter?.steps,
      "Download all validated managed image candidates",
    );

    const producerBaseName = renderArtifactIdentity(baseUpload.with?.name, 1);
    const rerunBaseName = renderArtifactIdentity(baseDownload.with?.name, 2);
    const producerCandidateName = renderArtifactIdentity(candidateUpload.with?.name, 1);
    const rerunCandidatePrefix = renderArtifactIdentity(candidateDownload.with?.pattern, 2).replace(
      /\*$/u,
      "",
    );

    expect([
      rerunBaseName === producerBaseName,
      producerCandidateName.startsWith(rerunCandidatePrefix),
    ]).toEqual([true, true]);
  });
});

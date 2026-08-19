// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  type CandidateMutation,
  publicationAgents,
  publicationPlatforms,
  runPublicationBarrier,
  runManagedImagePromotion,
} from "./helpers/managed-image-publication-barrier";
import type { Job, Step, Workflow } from "./helpers/managed-image-publication-workflow-types";

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

const reuseOpenclawAmd64FromAttemptOne: CandidateMutation = (candidateSet) =>
  candidateSet.map((candidate) => {
    const contract = structuredClone(candidate.contract);
    const producerAttempt =
      `${candidate.agent}|${candidate.platform}` === "openclaw|linux/amd64" ? 1 : 2;
    (contract.source as Record<string, unknown>).cohort = "ghrun-7744-1";
    (contract.run as Record<string, unknown>).attempt = producerAttempt;
    const evidence = contract.publicationEvidence as Record<string, unknown>;
    const attestations = evidence.attestations as Record<string, unknown>;
    const statement = (attestations.slsa as Record<string, unknown>).statement as Record<
      string,
      unknown
    >;
    statement.builderId = `https://github.com/NVIDIA/NemoClaw/actions/runs/7744/attempts/${producerAttempt}`;
    (statement.bindings as Record<string, unknown>).cohort = "ghrun-7744-1";
    return {
      ...candidate,
      artifact: candidate.artifact.replace("-7744-2-", `-7744-${producerAttempt}-`),
      contract,
    };
  });

function runCandidateRestore(
  script: string,
  overrides: Record<string, string> = {},
): { files: string[]; status: number | null; stderr: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-restore-"));
  const contract = Buffer.from("{}\n").toString("base64");
  try {
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        DCODE_AMD64: contract,
        DCODE_AMD64_ATTEMPT: "1",
        DCODE_ARM64: contract,
        DCODE_ARM64_ATTEMPT: "2",
        GITHUB_RUN_ID: "7744",
        GITHUB_RUN_ATTEMPT: "2",
        HERMES_AMD64: contract,
        HERMES_AMD64_ATTEMPT: "1",
        HERMES_ARM64: contract,
        HERMES_ARM64_ATTEMPT: "2",
        OPENCLAW_AMD64: contract,
        OPENCLAW_AMD64_ATTEMPT: "1",
        OPENCLAW_ARM64: contract,
        OPENCLAW_ARM64_ATTEMPT: "2",
        RUNNER_TEMP: root,
        ...overrides,
      },
    });
    const candidateRoot = path.join(root, "managed-image-candidates");
    return {
      files: fs.existsSync(candidateRoot)
        ? fs.readdirSync(candidateRoot, { recursive: true }).map(String).sort()
        : [],
      status: result.status,
      stderr: result.stderr,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("managed-image failed-job rerun artifacts", () => {
  // source-shape-contract: security -- Producer artifact identity must remain exact when GitHub reuses a successful job during a failed-job rerun
  it("retains exact producer outputs when successful jobs are reused on a failed-job rerun (#9529)", () => {
    const baseWorkflow = readYaml(".github/workflows/base-image.yaml");
    const managedWorkflow = readYaml(".github/workflows/managed-images.yaml");
    const platformProducer = baseWorkflow.jobs?.["build-openclaw-platforms"];
    const baseProducer = baseWorkflow.jobs?.["build-and-push-openclaw"];
    const managedCaller = baseWorkflow.jobs?.["publish-managed-images"];
    const identity = managedWorkflow.jobs?.["publication-identity"];
    const publisher = managedWorkflow.jobs?.["build-and-validate"] as Job | undefined;
    const promoter = managedWorkflow.jobs?.promote as Job | undefined;

    expect(platformProducer?.outputs).toEqual({
      "amd64-digest": "${{ steps.platform.outputs.amd64-digest }}",
      "arm64-digest": "${{ steps.platform.outputs.arm64-digest }}",
    });
    expect(
      requiredStep(baseProducer?.steps, "Publish validated multi-platform manifest").with,
    ).toMatchObject({
      "amd64-digest": "${{ needs.build-openclaw-platforms.outputs.amd64-digest }}",
      "arm64-digest": "${{ needs.build-openclaw-platforms.outputs.arm64-digest }}",
    });
    expect(baseProducer?.outputs?.["contract-base64"]).toBe(
      "${{ steps.publish.outputs.contract-base64 }}",
    );
    expect(managedCaller?.with?.["openclaw-base-contract-base64"]).toBe(
      "${{ needs.build-and-push-openclaw.outputs.contract-base64 }}",
    );
    expect(
      requiredStep(publisher?.steps, "Restore exact base image contract").env
        ?.OPENCLAW_CONTRACT_BASE64,
    ).toBe("${{ inputs.openclaw-base-contract-base64 }}");

    expect(identity?.outputs).toEqual({
      cohort: "${{ steps.identity.outputs.cohort }}",
    });
    expect(publisher?.needs).toBe("publication-identity");
    expect(publisher?.outputs?.["openclaw-linux-amd64"]).toBe(
      "${{ steps.candidate-output.outputs.openclaw_linux_amd64 }}",
    );
    expect(publisher?.outputs?.["openclaw-linux-amd64-attempt"]).toBe(
      "${{ steps.candidate-output.outputs.openclaw_linux_amd64_attempt }}",
    );
    const restoreCandidates = requiredStep(
      promoter?.steps,
      "Restore all validated managed image candidates",
    );
    expect(restoreCandidates.env).toMatchObject({
      OPENCLAW_AMD64: "${{ needs.build-and-validate.outputs.openclaw-linux-amd64 }}",
      OPENCLAW_AMD64_ATTEMPT:
        "${{ needs.build-and-validate.outputs.openclaw-linux-amd64-attempt }}",
    });
    expect(promoter?.needs).toEqual(["publication-identity", "build-and-validate"]);
    expect(
      requiredStep(promoter?.steps, "Validate complete managed image candidate set").env
        ?.PUBLICATION_COHORT,
    ).toBe("${{ needs.publication-identity.outputs.cohort }}");

    const acceptedRestore = runCandidateRestore(restoreCandidates.run ?? "");
    expect(acceptedRestore.status).toBe(0);
    expect(acceptedRestore.files.filter((file) => file.endsWith("contract.json"))).toHaveLength(6);
    const invalidAttempt = runCandidateRestore(restoreCandidates.run ?? "", {
      OPENCLAW_AMD64_ATTEMPT: "0",
    });
    expect(invalidAttempt.status).not.toBe(0);
    expect(invalidAttempt.stderr).toContain("producer attempt is invalid");
    const futureAttempt = runCandidateRestore(restoreCandidates.run ?? "", {
      OPENCLAW_AMD64_ATTEMPT: "3",
    });
    expect(futureAttempt.status).not.toBe(0);
    expect(futureAttempt.stderr).toContain("producer attempt is invalid");
    const malformedContract = runCandidateRestore(restoreCandidates.run ?? "", {
      OPENCLAW_AMD64: "not-base64",
    });
    expect(malformedContract.status).not.toBe(0);
    expect(malformedContract.stderr).not.toContain("not-base64");

    const barrier = requiredStep(promoter?.steps, "Validate complete managed image candidate set");
    const reusedKey = "openclaw|linux/amd64";
    const mixedAttempts = runPublicationBarrier(
      barrier.run ?? "",
      reuseOpenclawAmd64FromAttemptOne,
      "",
      {
        expectedAttempts: { [reusedKey]: "1" },
        publicationCohort: "ghrun-7744-1",
      },
    );
    expect(mixedAttempts.status).toBe(0);

    const promotion = requiredStep(
      promoter?.steps,
      "Stage validated multi-platform managed image cohort and contracts",
    );
    const mixedPromotion = runManagedImagePromotion(promotion.run ?? "", "", "", {
      mutate: reuseOpenclawAmd64FromAttemptOne,
      publicationCohort: "ghrun-7744-1",
    });
    expect(mixedPromotion.status, mixedPromotion.stderr).toBe(0);
    expect(mixedPromotion.platformContracts[reusedKey]?.run).toEqual({ id: 7744, attempt: 1 });

    const futureCohort = runPublicationBarrier(barrier.run ?? "", (value) => value, "", {
      publicationCohort: "ghrun-7744-3",
    });
    expect(futureCohort.status).not.toBe(0);
    expect(futureCohort.stderr).toContain("publication cohort is invalid");
    expect(futureCohort.dockerCalls).toEqual([]);
    const wrongRunCohort = runPublicationBarrier(barrier.run ?? "", (value) => value, "", {
      publicationCohort: "ghrun-8877-1",
    });
    expect(wrongRunCohort.status).not.toBe(0);
    expect(wrongRunCohort.stderr).toContain("publication cohort is invalid");
    expect(wrongRunCohort.dockerCalls).toEqual([]);

    const durableUploads = (promoter?.steps ?? [])
      .filter((candidate) => candidate.uses?.startsWith("actions/upload-artifact@"))
      .map((candidate) => candidate.with);
    expect(durableUploads).toEqual([
      {
        name: "managed-image-cohort-${{ github.run_id }}-${{ github.run_attempt }}",
        path: "${{ runner.temp }}/managed-image-contracts/cohort.json",
        "if-no-files-found": "error",
        "retention-days": 90,
      },
      ...publicationAgents.flatMap((agent) =>
        publicationPlatforms.map((platform) => {
          const artifactPlatform = platform.replaceAll("/", "-");
          return {
            name:
              "managed-image-${{ github.run_id }}-${{ github.run_attempt }}-" +
              `${agent}-${artifactPlatform}`,
            path: `\${{ runner.temp }}/managed-image-contracts/${agent}/${artifactPlatform}/contract.json`,
            "if-no-files-found": "error",
            "retention-days": 90,
          };
        }),
      ),
    ]);
  });
});

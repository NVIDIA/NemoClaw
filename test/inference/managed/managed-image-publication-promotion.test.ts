// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  publicationAgents,
  publicationPlatforms,
  reuseOpenclawAmd64FromAttemptOne,
  runManagedImagePromotion,
} from "../../helpers/managed-image-publication-barrier";
import {
  managedPromoter,
  readWorkflow,
  required,
  step,
} from "../../helpers/managed-image-publication-workflow";
import { validateManagedImageCohort } from "../../../tools/e2e/managed-image-cohort-contract.mts";

const revision = "a".repeat(40);
const runAttempt = 2;
const runId = 7744;

function workloadReference(agent: string, digestSuffix: string): string {
  return `ghcr.io/nvidia/nemoclaw/${agent}-sandbox@sha256:${digestSuffix.padStart(64, "0")}`;
}

const expectedImages = {
  openclaw: {
    "linux/amd64": workloadReference("openclaw", "28"),
    "linux/arm64": workloadReference("openclaw", "29"),
  },
  hermes: {
    "linux/amd64": workloadReference("hermes", "2a"),
    "linux/arm64": workloadReference("hermes", "2b"),
  },
  "langchain-deepagents-code": {
    "linux/amd64": workloadReference("langchain-deepagents-code", "2c"),
    "linux/arm64": workloadReference("langchain-deepagents-code", "2d"),
  },
};

function expectedReceipt(cohort: string, receiptAttempt: number): Record<string, unknown> {
  return {
    kind: "nemoclaw-managed-image-cohort-receipt-v1",
    cohort,
    revision,
    runAttempt: receiptAttempt,
    runId,
    images: expectedImages,
  };
}

describe("managed-image publication promotion", () => {
  it("stages all multi-platform cohort aliases before moving the sole root pointer (#7744)", () => {
    const promotion = required(
      step(
        managedPromoter(readWorkflow("managed-images.yaml")),
        "Stage validated multi-platform managed image cohort and contracts",
      ).run,
      "managed image promotion script is missing",
    );
    const pointer = required(
      step(
        managedPromoter(readWorkflow("managed-images.yaml")),
        "Promote durable managed image cohort pointers",
      ).run,
      "managed image pointer script is missing",
    );
    const cohort = "ghrun-7744-2";

    const failed = runManagedImagePromotion(promotion, "langchain-deepagents-code");
    const failedCalls = failed.calls.join("\n");
    expect(failed.status, failed.stderr).toBe(91);
    expect(failedCalls).toContain(`hermes-sandbox:cohort-${cohort}`);
    expect(failedCalls).toContain(`langchain-deepagents-code-sandbox:cohort-${cohort}`);
    expect(failedCalls).toContain(`openclaw-sandbox:cohort-${cohort}`);
    expect(failedCalls).not.toContain(`openclaw-sandbox:${revision}`);

    const accepted = runManagedImagePromotion(promotion, "", pointer);
    const acceptedCalls = accepted.calls.join("\n");
    expect(accepted.status, accepted.stderr).toBe(0);
    const cohortAgents = (accepted.cohortContract?.agents ?? {}) as Record<
      string,
      { reference?: string }
    >;
    const expectedPullCalls = publicationAgents.flatMap((agent) => {
      const reference = cohortAgents[agent]?.reference;
      expect(reference).toMatch(/^ghcr\.io\/nvidia\/nemoclaw\/.+@sha256:[0-9a-f]{64}$/u);
      return publicationPlatforms.map((platform) => `pull --platform ${platform} ${reference}`);
    });
    const lastCohortStage = Math.max(
      acceptedCalls.lastIndexOf(`hermes-sandbox:cohort-${cohort}`),
      acceptedCalls.lastIndexOf(`langchain-deepagents-code-sandbox:cohort-${cohort}`),
      acceptedCalls.lastIndexOf(`openclaw-sandbox:cohort-${cohort}`),
    );
    const rootPointer = acceptedCalls.indexOf(`openclaw-sandbox:${revision}`);

    expect(accepted.calls.filter((call) => call.startsWith("pull ")).sort()).toEqual(
      expectedPullCalls.sort(),
    );
    expectedPullCalls.forEach((pull) => {
      const index = accepted.calls.indexOf(pull);
      const reference = pull.match(/^pull --platform linux\/(?:amd64|arm64) (.+)$/u)?.[1];
      expect(reference).toBeDefined();
      expect(index).toBeGreaterThanOrEqual(0);
      expect(accepted.calls[index + 1]).toBe(`image rm ${reference}`);
    });
    expect(lastCohortStage).toBeGreaterThanOrEqual(0);
    expect(rootPointer).toBeGreaterThan(lastCohortStage);
    expect(acceptedCalls).not.toContain(`hermes-sandbox:${revision}`);
    expect(acceptedCalls).not.toContain(`langchain-deepagents-code-sandbox:${revision}`);
    expect(Object.keys(accepted.platformContracts).sort()).toEqual(
      publicationAgents
        .flatMap((agent) => publicationPlatforms.map((platform) => `${agent}|${platform}`))
        .sort(),
    );
    expect(accepted.cohortContract).toMatchObject({
      contractVersion: 2,
      cohort,
      platforms: ["linux/amd64", "linux/arm64"],
      agents: {
        openclaw: expect.objectContaining({
          descriptor: expect.objectContaining({
            mediaType: "application/vnd.oci.image.index.v1+json",
            digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          }),
          platforms: expect.objectContaining({
            "linux/amd64": expect.objectContaining({
              publicationEvidence: expect.objectContaining({
                workloadDescriptor: expect.any(Object),
                attestations: expect.any(Object),
              }),
            }),
            "linux/arm64": expect.any(Object),
          }),
        }),
        hermes: expect.any(Object),
        "langchain-deepagents-code": expect.any(Object),
      },
    });
    expect(
      validateManagedImageCohort(accepted.cohortContract, {
        revision,
        runAttempt,
        runId,
      }),
    ).toEqual(expectedReceipt(cohort, runAttempt));

    const reusedKey = "openclaw|linux/amd64";
    const mixedPromotion = runManagedImagePromotion(promotion, "", "", {
      mutate: reuseOpenclawAmd64FromAttemptOne,
      publicationCohort: "ghrun-7744-1",
    });
    expect(mixedPromotion.status, mixedPromotion.stderr).toBe(0);
    expect(mixedPromotion.platformContracts[reusedKey]?.run).toEqual({ id: 7744, attempt: 1 });
    expect(
      validateManagedImageCohort(mixedPromotion.cohortContract, {
        revision,
        runAttempt,
        runId,
      }),
    ).toEqual(expectedReceipt("ghrun-7744-1", 1));
  });

  it("rejects promotion when a candidate names another workflow run", () => {
    const promotion = required(
      step(
        managedPromoter(readWorkflow("managed-images.yaml")),
        "Stage validated multi-platform managed image cohort and contracts",
      ).run,
      "managed image promotion script is missing",
    );
    const foreignRunPromotion = runManagedImagePromotion(promotion, "", "", {
      mutate: (candidates) => {
        const candidate = candidates[0]!;
        const contract = structuredClone(candidate.contract);
        (contract.run as Record<string, unknown>).id = 8877;
        return [{ ...candidate, contract }, ...candidates.slice(1)];
      },
    });

    expect(foreignRunPromotion.status).not.toBe(0);
    expect(foreignRunPromotion.stderr).toContain(
      "staged multi-platform cohort failed exact validation",
    );
    expect(foreignRunPromotion.cohortContract).toBeNull();
  });
});

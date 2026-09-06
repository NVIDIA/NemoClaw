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
    const revision = "a".repeat(40);

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
      acceptedCalls.indexOf(`hermes-sandbox:cohort-${cohort}`),
      acceptedCalls.indexOf(`langchain-deepagents-code-sandbox:cohort-${cohort}`),
      acceptedCalls.indexOf(`openclaw-sandbox:cohort-${cohort}`),
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

    const reusedKey = "openclaw|linux/amd64";
    const mixedPromotion = runManagedImagePromotion(promotion, "", "", {
      mutate: reuseOpenclawAmd64FromAttemptOne,
      publicationCohort: "ghrun-7744-1",
    });
    expect(mixedPromotion.status, mixedPromotion.stderr).toBe(0);
    expect(mixedPromotion.platformContracts[reusedKey]?.run).toEqual({ id: 7744, attempt: 1 });
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildNspectRegistrationPlan } from "../../../tools/managed-images/nspect-registration-plan.mts";
import {
  publicationAgents,
  runManagedImagePromotion,
} from "../../helpers/managed-image-publication-barrier";
import {
  managedPromoter,
  readWorkflow,
  required,
  step,
} from "../../helpers/managed-image-publication-workflow";

const REVISION = "a".repeat(40);
const RUN_ATTEMPT = 2;
const RUN_ID = 7744;
const RELEASE = "v0.0.126";

function publishedCohort(): Record<string, unknown> {
  const workflow = managedPromoter(readWorkflow("managed-images.yaml"));
  const promotion = required(
    step(workflow, "Stage validated multi-platform managed image cohort and contracts").run,
    "managed image promotion script is missing",
  );
  const result = runManagedImagePromotion(promotion);
  expect(result.status, result.stderr).toBe(0);
  expect(result.cohortContract).not.toBeNull();
  const cohort = structuredClone(result.cohortContract!);
  (cohort.source as Record<string, unknown>).release = RELEASE;
  return cohort;
}

function plan(value: unknown, release = RELEASE) {
  return buildNspectRegistrationPlan(value, {
    nspectId: "NSPECT-SQ44-PJFM",
    programVersion: "dev",
    release,
    revision: REVISION,
    runAttempt: RUN_ATTEMPT,
    runId: RUN_ID,
  });
}

describe("nSpect managed-image registration plan", () => {
  it("selects each shipped multi-platform manifest from one tag publication", () => {
    const value = publishedCohort();
    const agents = value.agents as Record<string, { reference: string }>;

    expect(plan(value)).toEqual({
      kind: "nemoclaw-nspect-registration-plan-v1",
      nspectId: "NSPECT-SQ44-PJFM",
      programVersion: "dev",
      release: RELEASE,
      source: {
        cohort: `ghrun-${RUN_ID}-${RUN_ATTEMPT}`,
        revision: REVISION,
        runAttempt: RUN_ATTEMPT,
        runId: RUN_ID,
      },
      containerImages: publicationAgents.map((agent) => ({
        agent,
        imageUrl: agents[agent]!.reference,
      })),
    });
  });

  it("rejects a cohort produced for another release tag", () => {
    expect(() => plan(publishedCohort(), "v0.0.127")).toThrow(
      "managed-image cohort release does not match the source tag",
    );
  });

  it.each(["main", "v1", "v1.2 bad"])("rejects invalid release identity %s", (release) => {
    expect(() => plan(publishedCohort(), release)).toThrow("publication release tag is invalid");
  });
});

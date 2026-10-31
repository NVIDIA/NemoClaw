// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { validateManagedImageDiscordWorkflowBoundary } from "../../../scripts/checks/managed-image-discord-workflow-boundary.mts";

type Step = {
  name: string;
  if?: string;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
};

function fixtureSteps(): Step[] {
  return [
    { name: "Publish exact same-repository PR managed image by digest" },
    { name: "Remove PR publication credentials" },
    { name: "Pull exact published PR managed image" },
    {
      name: "Verify published PR Hermes Discord status",
      if: "matrix.agent == 'hermes' && github.event.pull_request.head.repo.full_name == github.repository",
      env: {
        IMAGE_REFERENCE:
          "${{ format('{0}@{1}', matrix.repository, steps.publish.outputs.digest) }}",
      },
    },
    {
      name: "Export exact published PR managed-image contract",
      env: { DIGEST: "${{ steps.publish.outputs.digest }}" },
    },
  ];
}

function validate(steps: Step[]): string[] {
  return validateManagedImageDiscordWorkflowBoundary(
    YAML.stringify({ jobs: { "pr-build-and-entrypoint": { steps } } }),
  );
}

describe("managed image Discord workflow boundary", () => {
  it("accepts the shipped publication workflow", () => {
    expect(validateManagedImageDiscordWorkflowBoundary()).toEqual([]);
  });

  it("accepts unrelated steps between the required publication stages", () => {
    const steps = fixtureSteps();
    steps.splice(2, 0, { name: "Unrelated stage" });
    expect(validate(steps)).toEqual([]);
  });

  it.each([0, 1, 2, 3])("rejects reversed publication stages at position %s", (index) => {
    const steps = fixtureSteps();
    [steps[index], steps[index + 1]] = [steps[index + 1]!, steps[index]!];
    expect(validate(steps)).toEqual([
      "PR publication must precede logout, public pull, native Discord qualification, and contract export",
    ]);
  });

  it.each([
    ["missing", 0],
    ["missing", 1],
    ["missing", 2],
    ["missing", 3],
    ["missing", 4],
    ["duplicated", 0],
    ["duplicated", 1],
    ["duplicated", 2],
    ["duplicated", 3],
    ["duplicated", 4],
  ] as const)("rejects a %s stage at position %s", (mode, index) => {
    const steps = fixtureSteps();
    const invalid =
      mode === "missing"
        ? steps.filter((_, position) => position !== index)
        : [...steps, steps[index]!];
    expect(validate(invalid)).toEqual([
      "PR Discord qualification requires one of each publication and qualification step",
    ]);
  });

  it.each([
    ["skipped Hermes validation", (steps: Step[]): string => (steps[3]!.if = "false")],
    ["unconditional validation", (steps: Step[]): boolean => delete steps[3]!.if],
    [
      "mutable image",
      (steps: Step[]): string => (steps[3]!.env!.IMAGE_REFERENCE = "hermes:latest"),
    ],
    ["ignored failure", (steps: Step[]): boolean => (steps[3]!["continue-on-error"] = true)],
    ["unqualified contract", (steps: Step[]): string => (steps[4]!.env!.DIGEST = "other-digest")],
  ] as const)("rejects %s", (_name, mutate) => {
    const steps = fixtureSteps();
    mutate(steps);
    expect(validate(steps)).toHaveLength(1);
  });

  it.each(["jobs: [", "{}", "jobs: { pr-build-and-entrypoint: { steps: {} } }"])(
    "rejects invalid publication configuration %s",
    (source) => {
      expect(validateManagedImageDiscordWorkflowBoundary(source)).toHaveLength(1);
    },
  );
});

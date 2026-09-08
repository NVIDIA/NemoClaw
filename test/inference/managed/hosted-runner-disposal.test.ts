// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  managedPublisher,
  readWorkflow,
  required,
} from "../../helpers/managed-image-publication-workflow";

describe("hosted managed-image runner disposal", () => {
  it("does not add terminal anonymous Docker configuration cleanup", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const pi = required(workflow.jobs?.["pi-candidate"], "missing Pi candidate job");
    const piPublisher = required(
      workflow.jobs?.["pi-candidate-publish"],
      "missing Pi publisher job",
    );
    const publisher = managedPublisher(workflow);

    expect(pi["runs-on"]).toBe("${{ matrix.runner }}");
    expect(pi.strategy?.matrix?.include?.map((entry) => entry.runner)).toEqual([
      "ubuntu-24.04",
      "ubuntu-24.04-arm",
    ]);
    expect(piPublisher).toMatchObject({
      "runs-on": pi["runs-on"],
      strategy: pi.strategy,
      steps: pi.steps,
    });
    expect(pi.steps?.map((step) => step.name)).not.toContain(
      "Remove Pi anonymous Docker configuration",
    );
    expect(pi.steps?.map((step) => step.run ?? "").join("\n")).not.toContain(
      'rm -rf -- "$ANONYMOUS_CONFIG"',
    );
    expect(piPublisher.steps?.map((step) => step.run ?? "").join("\n")).not.toContain(
      'rm -rf -- "$ANONYMOUS_CONFIG"',
    );
    expect(publisher["runs-on"]).toBe("${{ matrix.runner }}");
    const publisherMatrix = required(
      publisher.strategy?.matrix?.include,
      "missing publisher runner matrix",
    );
    expect(publisherMatrix).not.toHaveLength(0);
    expect(
      publisherMatrix.every(({ runner }) => /^ubuntu-(?:24\.04|24\.04-arm)$/u.test(String(runner))),
    ).toBe(true);
    expect(publisher.steps?.map((step) => step.name)).not.toContain(
      "Remove anonymous Docker configuration",
    );
    expect(publisher.steps?.map((step) => step.run ?? "").join("\n")).not.toContain(
      'rm -rf -- "$ANONYMOUS_CONFIG"',
    );
  });
});

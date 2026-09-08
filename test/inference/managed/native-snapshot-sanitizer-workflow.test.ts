// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readWorkflow, required, step } from "../../helpers/managed-image-publication-workflow";

describe("native snapshot sanitizer workflow", () => {
  it("runs the packaged sanitizer on both native PR architectures (#11174)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const candidate = required(
      workflow.jobs?.["pi-candidate"],
      "managed-image workflow is missing its native Pi candidate matrix",
    );
    const steps = candidate.steps ?? [];

    expect(workflow.on?.pull_request?.paths).toEqual(
      expect.arrayContaining([
        "src/lib/security/credential-filter.ts",
        "src/lib/security/snapshot-sanitizer.ts",
      ]),
    );
    expect(candidate.strategy?.matrix?.include).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platform: "linux/amd64", runner: "ubuntu-24.04" }),
        expect.objectContaining({ platform: "linux/arm64", runner: "ubuntu-24.04-arm" }),
      ]),
    );
    expect(candidate.env?.SOURCE_REVISION).toBe(
      "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
    );

    const validation = step(
      candidate,
      "Validate the candidate snapshot sanitizer on the native architecture",
    );
    expect(validation.run).toContain(
      '[[ "$(git rev-parse --verify HEAD)" == "$SOURCE_REVISION" ]]',
    );
    expect(validation.run).toContain("npm ci --ignore-scripts --no-audit --no-fund");
    expect(validation.run).toContain("npm run build:cli");
    expect(validation.run).toContain("test/package-contract/snapshot-sanitizer-boundary.test.ts");
    expect(steps.indexOf(step(candidate, "Set up Node.js"))).toBeLessThan(
      steps.indexOf(validation),
    );
    expect(steps.indexOf(validation)).toBeLessThan(
      steps.indexOf(step(candidate, "Build the exact Pi candidate base")),
    );
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

type Step = {
  env?: Record<string, unknown>;
  if?: string;
  name?: string;
  run?: string;
};

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const baseDockerfiles = [
  "Dockerfile.base",
  "agents/hermes/Dockerfile.base",
  "agents/langchain-deepagents-code/Dockerfile.base",
] as const;

function pinnedAptVersion(dockerfile: string, packageName: string): string {
  const source = fs.readFileSync(path.join(repoRoot, dockerfile), "utf8");
  const version = source.match(new RegExp(`^\\s*${packageName}=([^\\s\\\\]+)`, "m"))?.[1];
  expect(version, `${dockerfile} must pin ${packageName}`).toBeDefined();
  return version as string;
}

describe("base-image dependency contracts", () => {
  it.each(Array.from(baseDockerfiles, (value) => [value]))(
    "keeps shared apt dependencies in %s pinned and aligned (#6679)",
    (dockerfile) => {
      const curlVersions = baseDockerfiles.map((dockerfile) =>
        pinnedAptVersion(dockerfile, "curl"),
      );

      expect(new Set(curlVersions).size).toBe(1);

      const source = fs.readFileSync(path.join(repoRoot, dockerfile), "utf8");
      expect(source, dockerfile).toMatch(/^FROM\s+\S+@sha256:[0-9a-f]{64}\s*$/m);
    },
  );

  it("executes dos2unix from each Deep Agents Code platform image before manifest publication (#8870)", () => {
    const action = YAML.parse(
      fs.readFileSync(
        path.join(repoRoot, ".github", "actions", "build-base-image-platform", "action.yaml"),
        "utf8",
      ),
    ) as { runs?: { steps?: Step[] } };
    const steps = action.runs?.steps ?? [];
    const validate =
      steps.find(
        (candidate) => candidate.name === "Validate Deep Agents Code dos2unix executable",
      ) ??
      (() => {
        throw new Error("Base-image platform action is missing the dos2unix validation");
      })();
    const buildIndex = steps.findIndex(
      (candidate) => candidate.name === "Build and push platform digest",
    );
    const validateIndex = steps.indexOf(validate);
    const exportIndex = steps.findIndex((candidate) => candidate.name === "Export platform digest");

    expect(validate.if).toBe("${{ inputs.agent == 'langchain-deepagents-code' }}");
    expect(validate.env).toMatchObject({
      DIGEST: "${{ steps.build.outputs.digest }}",
      IMAGE: "${{ inputs.registry }}/${{ inputs.image }}",
      PLATFORM: "${{ inputs.platform }}",
    });
    expect(validate.run).toContain('reference="${IMAGE}@${DIGEST}"');
    expect(validate.run).toContain("^sha256:[0-9a-f]{64}$");
    expect(validate.run).toContain('docker run --rm --platform "$PLATFORM"');
    expect(validate.run).toContain("--network none");
    expect(validate.run).toContain("--cap-drop ALL");
    expect(validate.run).toContain("--security-opt no-new-privileges");
    expect(validate.run).toContain("--read-only");
    expect(validate.run).toContain("--user 999:999");
    expect(validate.run).toContain("test -x /usr/bin/dos2unix");
    expect(validate.run).toContain('test "$(command -v dos2unix)" = /usr/bin/dos2unix');
    expect(validate.run).toContain("dos2unix --version");
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(validateIndex).toBeGreaterThanOrEqual(0);
    expect(exportIndex).toBeGreaterThanOrEqual(0);
    expect(validateIndex).toBeGreaterThan(buildIndex);
    expect(validateIndex).toBeLessThan(exportIndex);
  });
});

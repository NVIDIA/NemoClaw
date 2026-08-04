// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

type Step = {
  env?: Record<string, unknown>;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Job = {
  needs?: string;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  "runs-on"?: string;
  steps?: Step[];
  strategy?: { matrix?: unknown };
};

type Workflow = {
  jobs?: Record<string, Job>;
  on?: Record<string, { paths?: string[] }>;
  permissions?: Record<string, string>;
};

const repoRoot = path.resolve(import.meta.dirname, "..");
const workflow = YAML.parse(
  fs.readFileSync(path.join(repoRoot, ".github", "workflows", "llama-cpp-image.yaml"), "utf8"),
) as Workflow;
const fullShaAction = /^[^@]+@[0-9a-f]{40}$/u;

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function namedStep(job: Job, name: string): Step {
  return required(
    job.steps?.find((candidate) => candidate.name === name),
    `llama.cpp image workflow is missing '${name}'`,
  );
}

describe("llama.cpp image PR workflow", () => {
  const config = required(workflow.jobs?.config, "config job is missing");
  const build = required(workflow.jobs?.["pr-build"], "native PR build job is missing");
  const buildStep = namedStep(build, "Build native PR image without publishing");
  const validate = namedStep(build, "Validate native PR image contract");

  it("is a read-only pull-request gate with no publication path (#8231)", () => {
    expect(workflow.on?.pull_request?.paths).toEqual(
      expect.arrayContaining([
        ".github/workflows/llama-cpp-image.yaml",
        "managed-inference/images/llama-cpp/**",
        "scripts/checks/export-llama-cpp-image-config.mts",
      ]),
    );
    expect(Object.keys(workflow.on ?? {})).toEqual(["pull_request"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(workflow)).not.toContain("packages:write");
    expect(JSON.stringify(workflow)).not.toContain("docker/login-action");
    expect(buildStep.with?.push).toBe(false);
    expect(buildStep.with?.load).toBe(true);
  });

  it("passes declarative source, base image, runtime ID, and platform values to each image build (#8231)", () => {
    expect(config.outputs).toEqual({
      cuda_dev_image: "${{ steps.manifest.outputs.cuda_dev_image }}",
      cuda_runtime_image: "${{ steps.manifest.outputs.cuda_runtime_image }}",
      image: "${{ steps.manifest.outputs.image }}",
      matrix: "${{ steps.manifest.outputs.matrix }}",
      runtime_gid: "${{ steps.manifest.outputs.runtime_gid }}",
      runtime_uid: "${{ steps.manifest.outputs.runtime_uid }}",
      source_archive_sha256: "${{ steps.manifest.outputs.source_archive_sha256 }}",
      source_revision: "${{ steps.manifest.outputs.source_revision }}",
    });
    expect(namedStep(config, "Compile image manifest").run).toBe(
      "node --experimental-strip-types --no-warnings scripts/checks/export-llama-cpp-image-config.mts",
    );
    expect(build.needs).toBe("config");
    expect(build["runs-on"]).toBe("${{ matrix.runner }}");
    expect(build.strategy?.matrix).toBe("${{ fromJSON(needs.config.outputs.matrix) }}");

    const args = String(buildStep.with?.["build-args"] ?? "");
    for (const output of [
      "cuda_dev_image",
      "cuda_runtime_image",
      "runtime_gid",
      "runtime_uid",
      "source_archive_sha256",
      "source_revision",
    ]) {
      expect(args).toContain(`needs.config.outputs.${output}`);
    }
    expect(args).toContain("CUDA_ARCHITECTURES=${{ matrix.cuda_architectures }}");
    expect(args).toContain("TARGETPLATFORM=${{ matrix.platform }}");
    expect(args).not.toMatch(/sha256:[0-9a-f]{64}/u);
    expect(args).not.toMatch(/[0-9a-f]{40}/u);
  });

  it("pins actions and validates the native non-root read-only image (#8231)", () => {
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step.uses) expect(step.uses).toMatch(fullShaAction);
      }
    }

    expect(buildStep.with?.platforms).toBe("${{ matrix.platform }}");
    expect(buildStep.with?.provenance).toBe(false);
    expect(buildStep.with?.sbom).toBe(false);
    expect(validate.run).toContain('.Config.User == ($uid + ":" + $gid)');
    expect(validate.run).toContain("io.nvidia.nemoclaw.inference-server.upstream.revision");
    expect(validate.run).toContain("--network none");
    expect(validate.run).toContain("--read-only");
    expect(validate.run).toContain("--tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777");
    expect(validate.run).toContain('grep -F "$SOURCE_REVISION"');
    expect(validate.run).toContain("test ! -e /opt/llama.cpp/ui");
  });
});

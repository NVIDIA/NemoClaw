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
  permissions?: string | Record<string, string>;
  "runs-on"?: string;
  steps?: Step[];
  strategy?: { matrix?: unknown };
};

type Workflow = {
  concurrency?: { "cancel-in-progress"?: boolean; group?: string };
  jobs?: Record<string, Job>;
  on?: Record<string, { paths?: string[] }>;
  permissions?: string | Record<string, string>;
};

const repoRoot = path.resolve(import.meta.dirname, "..");
const workflow = YAML.parse(
  fs.readFileSync(path.join(repoRoot, ".github", "workflows", "llama-cpp-image.yaml"), "utf8"),
) as Workflow;
const fullShaAction = /^[^@]+@[0-9a-f]{40}$/u;

function required<T>(value: T | undefined, message: string): T {
  return (
    value ??
    (() => {
      throw new Error(message);
    })()
  );
}

function namedStep(job: Job, name: string): Step {
  return required(
    job.steps?.find((candidate) => candidate.name === name),
    `llama.cpp image workflow is missing '${name}'`,
  );
}

function permissionValues(value: string | Record<string, string> | undefined): string[] {
  return typeof value === "string" ? [value] : Object.values(value ?? {});
}

function jobPermissionValues(workflowValue: Workflow): string[] {
  return Object.values(workflowValue.jobs ?? {}).flatMap((job) =>
    permissionValues(job.permissions),
  );
}

describe("llama.cpp image PR workflow", () => {
  const config = required(workflow.jobs?.config, "config job is missing");
  const build = required(workflow.jobs?.["pr-build"], "native PR build job is missing");
  const buildArgGuard = namedStep(build, "Validate native PR image build args");
  const buildStep = namedStep(build, "Build native PR image without publishing");
  const validate = namedStep(build, "Validate native PR image contract");

  it("is a read-only pull-request gate with no publication path (#8231)", () => {
    expect(workflow.on?.pull_request?.paths).toEqual(
      expect.arrayContaining([
        ".github/workflows/llama-cpp-image.yaml",
        "managed-inference/images/llama-cpp/**",
        "managed-inference/recipes/llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1.yaml",
        "scripts/checks/export-llama-cpp-image-config.mts",
      ]),
    );
    expect(Object.keys(workflow.on ?? {})).toEqual(["pull_request"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    const declaredPermissions = [
      ...permissionValues(workflow.permissions),
      ...jobPermissionValues(workflow),
    ];
    expect(declaredPermissions).not.toContain("write");
    expect(declaredPermissions).not.toContain("write-all");
    const unsafeFixture = YAML.parse("jobs:\n  unsafe:\n    permissions: write-all\n") as Workflow;
    expect(jobPermissionValues(unsafeFixture)).toContain("write-all");
    expect(JSON.stringify(workflow)).not.toContain("docker/login-action");
    expect(buildStep.with?.push).toBe(false);
    expect(buildStep.with?.load).toBe(true);
    expect(workflow.concurrency).toEqual({
      "cancel-in-progress": true,
      group: "${{ github.workflow }}-${{ github.event.pull_request.number }}",
    });
  });

  it("passes declarative source, base image, runtime ID, and platform values to each image build (#8231)", () => {
    expect(config.outputs).toEqual({
      backend_directory: "${{ steps.manifest.outputs.backend_directory }}",
      compiler_c: "${{ steps.manifest.outputs.compiler_c }}",
      compiler_cuda_host_cxx: "${{ steps.manifest.outputs.compiler_cuda_host_cxx }}",
      compiler_cxx: "${{ steps.manifest.outputs.compiler_cxx }}",
      cuda_dev_image: "${{ steps.manifest.outputs.cuda_dev_image }}",
      cuda_runtime_image: "${{ steps.manifest.outputs.cuda_runtime_image }}",
      image: "${{ steps.manifest.outputs.image }}",
      matrix: "${{ steps.manifest.outputs.matrix }}",
      runtime_forbidden_paths: "${{ steps.manifest.outputs.runtime_forbidden_paths }}",
      runtime_gid: "${{ steps.manifest.outputs.runtime_gid }}",
      runtime_required_paths: "${{ steps.manifest.outputs.runtime_required_paths }}",
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
      "backend_directory",
      "compiler_c",
      "compiler_cuda_host_cxx",
      "compiler_cxx",
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

    const buildArgNames = [...args.matchAll(/^([A-Z0-9_]+)=/gmu)].map((match) => match[1]);
    const guardedArgNames = [
      ...(buildArgGuard.run ?? "").matchAll(/--build-arg "([A-Z0-9_]+)=/gu),
    ].map((match) => match[1]);
    expect(guardedArgNames).toEqual(buildArgNames);
    expect(buildArgGuard.run).toContain("scripts/check-production-build-args.sh");
    expect(build.steps?.indexOf(buildArgGuard)).toBeLessThan(
      build.steps?.indexOf(buildStep) ?? Number.POSITIVE_INFINITY,
    );
  });

  it("pins actions and validates the native non-root read-only image (#8231)", () => {
    const actions = Object.values(workflow.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.uses)
      .filter((uses): uses is string => uses !== undefined);
    for (const action of actions) {
      expect(action).toMatch(fullShaAction);
    }

    expect(buildStep.with?.platforms).toBe("${{ matrix.platform }}");
    expect(buildStep.with?.provenance).toBe(false);
    expect(buildStep.with?.sbom).toBe(false);
    expect(buildStep.with?.["cache-from"]).toBe("type=gha,scope=llama-cpp-${{ matrix.arch }}");
    expect(buildStep.with?.["cache-to"]).toBe(
      "type=gha,mode=max,scope=llama-cpp-${{ matrix.arch }}",
    );
    expect(validate.run).toContain('.Config.User == ($uid + ":" + $gid)');
    expect(validate.run).toContain("io.nvidia.nemoclaw.inference-server.upstream.revision");
    expect(validate.run).toContain("--network none");
    expect(validate.run).toContain("--read-only");
    expect(validate.run).toContain("--tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777");
    expect(validate.run).toContain('grep -F "$SOURCE_REVISION"');
    expect(validate.run).toContain('docker export "$container_id"');
    expect(validate.run).toContain("RUNTIME_REQUIRED_PATHS");
    expect(validate.run).toContain("RUNTIME_FORBIDDEN_PATHS");
    expect(validate.run).not.toContain("--entrypoint /bin/sh");
  });
});

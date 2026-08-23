// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

type WorkflowStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs: Record<
    string,
    {
      env?: Record<string, string>;
      needs?: string | string[];
      outputs?: Record<string, string>;
      permissions?: Record<string, string>;
      steps?: WorkflowStep[];
      [key: string]: unknown;
    }
  >;
};

const WORKFLOW_PATH = ".github/workflows/pr-self-hosted.yaml";
const CANDIDATE_SHA = "a".repeat(40);

function selectGenericGpuLane(
  changedFiles: readonly string[],
  copiedSha = CANDIDATE_SHA,
  candidateRepository = "NVIDIA/NemoClaw",
) {
  const workflow = YAML.parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
  const script = workflow.jobs["select-llama-cpp-generic-gpu"]?.steps?.find(
    (step) => step.name === "Select llama.cpp generic GPU E2E from PR files",
  )?.run;
  expect(script).toEqual(expect.any(String));

  const directory = mkdtempSync(join(tmpdir(), "nemoclaw-generic-gpu-selector-"));
  const binDirectory = join(directory, "bin");
  const outputPath = join(directory, "github-output");
  const ghPath = join(binDirectory, "gh");
  mkdirSync(binDirectory);
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${!#}" == "repos/NVIDIA/NemoClaw/pulls/8748" ]]; then
  printf '%s' "$PR_JSON"
else
  printf '%s' "$PR_FILES_JSON"
fi
`,
  );
  chmodSync(ghPath, 0o755);
  writeFileSync(outputPath, "");

  try {
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script!],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GH_TOKEN: "test-token",
          GITHUB_REF_NAME: "pull-request/8748",
          GITHUB_OUTPUT: outputPath,
          GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
          GITHUB_SHA: copiedSha,
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
          PR_FILES_JSON: JSON.stringify([changedFiles.map((filename) => ({ filename }))]),
          PR_JSON: JSON.stringify({
            number: 8748,
            base: { sha: "c".repeat(40) },
            head: {
              repo: { full_name: candidateRepository },
              sha: CANDIDATE_SHA,
            },
          }),
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(outputPath, "utf8")
      .split("\n")
      .find((line) => line.startsWith("selected="));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("generic NVIDIA GPU PR selection", () => {
  it.each([
    "scripts/install.sh",
    "src/lib/readiness/host.ts",
    "src/lib/readiness/onboard-admission.ts",
    "src/lib/onboard/fatal-runtime-preflight.ts",
    "src/lib/onboard/overlayfs-auto-fix.ts",
    "src/lib/onboard/preflight.ts",
  ])("selects the generic NVIDIA GPU E2E job when %s can change installer readiness", (changedFile) => {
    expect(selectGenericGpuLane([changedFile])).toBe("selected=true");
  });

  it("does not select the generic NVIDIA GPU E2E job for unrelated documentation", () => {
    expect(selectGenericGpuLane(["docs/get-started/quickstart.mdx"])).toBe("selected=false");
  });

  it("rejects a copied branch whose commit does not match the current PR head", () => {
    expect(() => selectGenericGpuLane(["scripts/install.sh"], "b".repeat(40))).toThrow(
      "Copied PR branch SHA does not match the current PR head",
    );
  });

  it("rejects a copied branch from a fork repository", () => {
    expect(() =>
      selectGenericGpuLane(["scripts/install.sh"], CANDIDATE_SHA, "example/NemoClaw"),
    ).toThrow("Copied PR branch must come from the workflow repository");
  });

  it("binds the GPU lane to the exact PR managed-image catalog", () => {
    const workflow = YAML.parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
    const selector = workflow.jobs["select-llama-cpp-generic-gpu"];
    expect(selector?.outputs).toMatchObject({
      base_sha: "${{ steps.changed.outputs.base_sha }}",
      candidate_repository: "${{ steps.changed.outputs.candidate_repository }}",
      pr_number: "${{ steps.changed.outputs.pr_number }}",
    });

    const resolver = workflow.jobs["resolve-llama-cpp-managed-images"];
    expect(resolver?.needs).toBe("select-llama-cpp-generic-gpu");
    expect(resolver?.permissions).toEqual({
      actions: "read",
      contents: "read",
      "pull-requests": "read",
    });
    const wait = resolver?.steps?.find(
      (step) => step.name === "Wait for exact PR managed-image catalog",
    );
    expect(wait?.env).toMatchObject({
      BASE_SHA: "${{ needs.select-llama-cpp-generic-gpu.outputs.base_sha }}",
      CANDIDATE_REPOSITORY:
        "${{ needs.select-llama-cpp-generic-gpu.outputs.candidate_repository }}",
      CANDIDATE_SHA: "${{ github.sha }}",
      PR_NUMBER: "${{ needs.select-llama-cpp-generic-gpu.outputs.pr_number }}",
    });
    expect(wait?.run).toContain("pr-managed-image-publication.mts wait");

    const gpu = workflow.jobs["llama-cpp-generic-gpu"];
    expect(gpu?.needs).toEqual([
      "select-llama-cpp-generic-gpu",
      "resolve-llama-cpp-managed-images",
    ]);
    const download = gpu?.steps?.find(
      (step) => step.name === "Download exact PR managed-image catalog",
    );
    expect(download?.with).toEqual({
      name: "llama-cpp-pr-managed-catalog-${{ github.sha }}",
      path: "${{ runner.temp }}/pr-managed-image-catalog",
    });
    const bind = gpu?.steps?.find((step) => step.name === "Bind exact PR managed-image catalog");
    expect(bind?.run).toContain("NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG");
  });
});

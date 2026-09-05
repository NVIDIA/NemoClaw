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
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  "runs-on"?: string;
  steps?: WorkflowStep[];
  "timeout-minutes"?: number;
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
};

const WORKFLOW_PATH = ".github/workflows/pr-self-hosted.yaml";
const CANDIDATE_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

function workflow(): Workflow {
  return YAML.parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
}

function selectGenericGpuLane(
  changedFiles: readonly string[],
  copiedSha = CANDIDATE_SHA,
  baseSha = BASE_SHA,
) {
  const value = workflow();
  const script = value.jobs["select-llama-cpp-generic-gpu"]?.steps?.find(
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
            base: { sha: baseSha },
            head: { sha: CANDIDATE_SHA },
          }),
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(outputPath, "utf8").trim();
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
    "src/lib/onboard/runtime-provider/podman.ts",
  ])(
    "selects the generic NVIDIA GPU E2E job when %s can change installer readiness",
    (changedFile) => {
      expect(selectGenericGpuLane([changedFile])).toBe(`base_sha=${BASE_SHA}\nselected=true`);
    },
  );

  it("does not select the generic NVIDIA GPU E2E job for unrelated documentation", () => {
    expect(selectGenericGpuLane(["docs/get-started/quickstart.mdx"])).toBe(
      `base_sha=${BASE_SHA}\nselected=false`,
    );
  });

  it("rejects a copied branch whose commit does not match the current PR head", () => {
    expect(() => selectGenericGpuLane(["scripts/install.sh"], "b".repeat(40))).toThrow(
      "Copied PR branch SHA does not match the current PR head",
    );
  });

  it("rejects a PR whose base SHA is not a lowercase 40-character SHA", () => {
    expect(() => selectGenericGpuLane(["scripts/install.sh"], CANDIDATE_SHA, "main")).toThrow();
  });

  // source-shape-contract: security -- The copied PR workflow must run the publication verifier from the validated PR base before the generic GPU job receives its managed-image revision
  it("binds trusted base publication to the generic NVIDIA GPU job", () => {
    const value = workflow();
    const selector = value.jobs["select-llama-cpp-generic-gpu"];

    expect(selector?.permissions).toEqual({ actions: "read", contents: "read" });
    expect(selector?.outputs).toMatchObject({
      base_sha: "${{ steps.changed.outputs.base_sha }}",
      managed_image_revision: "${{ steps.publication.outputs.head_sha }}",
    });

    const checkout = selector?.steps?.find(
      (step) => step.name === "Check out PR base SHA for publication verification",
    );
    expect(checkout).toMatchObject({
      if: "${{ steps.changed.outputs.selected == 'true' }}",
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: {
        "fetch-depth": 0,
        "persist-credentials": false,
        ref: "${{ steps.changed.outputs.base_sha }}",
      },
    });

    const publication = selector?.steps?.find((step) => step.id === "publication");
    expect(publication).toMatchObject({
      env: {
        EXPECTED_SHA: "${{ steps.changed.outputs.base_sha }}",
        GITHUB_TOKEN: "${{ github.token }}",
        PUBLICATION_HISTORY_ALLOW_NON_HEAD: "1",
        REQUIRE_MANAGED_IMAGE_PUBLICATION: "1",
        SELECT_NEAREST_SUCCESSFUL_PUBLICATION: "1",
      },
      if: "${{ steps.changed.outputs.selected == 'true' }}",
    });
    expect(publication?.run).toContain("export GITHUB_REF=refs/heads/main");
    expect(publication?.run).toContain('export GITHUB_SHA="$EXPECTED_SHA"');
    expect(publication?.run).toContain(
      "node --experimental-strip-types --no-warnings tools/e2e/base-image-publication.mts --wait-seconds 3000 --poll-seconds 30",
    );

    expect(value.jobs["llama-cpp-generic-gpu"]?.env?.E2E_MANAGED_IMAGE_REVISION).toBe(
      "${{ needs.select-llama-cpp-generic-gpu.outputs.managed_image_revision }}",
    );

    const qwen = value.jobs["llama-cpp-qwen-gpu"];
    expect(qwen).toMatchObject({
      env: {
        E2E_MANAGED_IMAGE_REVISION:
          "${{ needs.select-llama-cpp-generic-gpu.outputs.managed_image_revision }}",
        E2E_TARGET_ID: "llama-cpp-qwen-gpu",
        NEMOCLAW_LLAMA_CPP_QUALIFICATION_HEAD_SHA: "${{ github.sha }}",
        NEMOCLAW_LLAMACPP_RECIPE: "llama-cpp.qwen3-6-35b-a3b.n1x-wsl.v1",
      },
      if: "${{ needs.select-llama-cpp-generic-gpu.outputs.selected == 'true' }}",
      needs: "select-llama-cpp-generic-gpu",
      "runs-on": "linux-amd64-gpu-rtxpro6000-latest-1",
      "timeout-minutes": 150,
    });
    const qwenRun = qwen?.steps?.find(
      (step) => step.name === "Run declarative Qwen llama.cpp NVIDIA GPU live test",
    )?.run;
    expect(qwenRun).toContain(
      "--test-path test/e2e/live/llama-cpp-generic-gpu.test.ts",
    );
    expect(qwenRun).not.toContain("docker");
  });
});

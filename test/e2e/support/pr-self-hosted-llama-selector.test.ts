// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
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
  needs?: string;
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
};

const WORKFLOW_PATH = ".github/workflows/pr-self-hosted.yaml";
const LLAMA_LIVE_TEST_PATH = "test/e2e/live/llama-cpp-generic-gpu.test.ts";
const CANDIDATE_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const WSL_ARM64_RUNNER_LABEL = "windows-arm64-wsl-gpu-reviewed";
const REQUIRED_RUNTIME_AUTHORITY_PATHS = [
  "src/lib/inference/nim.ts",
  "src/lib/onboard/provider-selection.ts",
  "src/lib/onboard/runtime-provider/configured-runtime.ts",
  "src/lib/onboard/runtime-provider/current.ts",
  "src/lib/onboard/setup-nim-flow.ts",
] as const;
const WSL_ARM64_GENERIC_RUNTIME_OWNER_PATHS = [
  "src/lib/inference/nim.ts",
  "src/lib/onboard/fatal-runtime-preflight.ts",
] as const;
const ARM64_PROOF_AUTHORITY_PATHS = [
  "src/lib/container-gpu-proof.ts",
  "src/lib/onboard/runtime-provider/nvidia-container-proof.ts",
  "src/lib/onboard/sandbox-gpu-mode.ts",
] as const;
const WSL_ARM64_QUALIFICATION_PATHS = [
  WORKFLOW_PATH,
  ...ARM64_PROOF_AUTHORITY_PATHS,
  "tools/e2e/wsl-arm64-multi-gpu-qualification.mts",
  "test/e2e/support/pr-self-hosted-llama-selector.test.ts",
] as const;

type RunProcessResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function runProcess(file: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  return new Promise<RunProcessResult>((resolve) => {
    execFile(
      file,
      [...args],
      { encoding: "utf8", env, killSignal: "SIGKILL", timeout: 10_000 },
      (error, stdout, stderr) => {
        const signal = error?.signal ?? null;
        resolve({
          status: signal ? null : Number(error?.code) || (error ? -1 : 0),
          signal,
          stdout,
          stderr,
        });
      },
    );
  });
}

vi.setConfig({ maxConcurrency: 4 });

function workflow(): Workflow {
  return YAML.parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
}

function selectorScript(): string {
  const script = workflow().jobs["select-llama-cpp-generic-gpu"]?.steps?.find(
    (step) => step.name === "Select llama.cpp generic GPU E2E from PR files",
  )?.run;
  assert(typeof script === "string", "llama.cpp GPU selector script is missing");
  return script;
}

function selectionBlock(index: number): string {
  const script = selectorScript();
  const starts = [...script.matchAll(/\nif gh api --paginate --slurp/gu)].map(
    (match) => match.index,
  );
  assert(starts.length >= 2, "expected independent generic GPU and WSL ARM64 selectors");
  const start = starts[index];
  assert(typeof start === "number", `selector block ${index} is missing`);
  return script.slice(start, starts[index + 1]);
}

function declaredSelectionPaths(index = 0): readonly string[] {
  const block = selectionBlock(index);
  const exactPaths = [...block.matchAll(/\.filename == "([^"]+)"/gu)].map(([, value]) => {
    assert(typeof value === "string", "exact selector path is missing");
    return value;
  });
  const representativePrefixPaths = [...block.matchAll(/startswith\("([^"]+)"\)/gu)].map(
    ([, value]) => {
      assert(typeof value === "string", "selector prefix is missing");
      return `${value}selector-contract.ts`;
    },
  );
  const paths = [...new Set([...exactPaths, ...representativePrefixPaths])].sort();
  assert(paths.length > 0, "llama.cpp GPU selector inventory is empty");
  return paths;
}

function expectedSelection(genericSelected: boolean, wslArm64Selected: boolean): string {
  return (
    `base_sha=${BASE_SHA}\nhead_sha=${CANDIDATE_SHA}\npr_number=8748\n` +
    `selected=${genericSelected}\n` +
    `wsl_arm64_runner_label=${WSL_ARM64_RUNNER_LABEL}\n` +
    `wsl_arm64_selected=${wslArm64Selected}`
  );
}

async function selectGenericGpuLane(
  changedFiles: readonly string[],
  copiedSha = CANDIDATE_SHA,
  baseSha = BASE_SHA,
  wslArm64RunnerLabel = WSL_ARM64_RUNNER_LABEL,
) {
  const script = selectorScript();

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
    const result = await runProcess(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
      {
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
        WSL_ARM64_MULTI_GPU_RUNNER_LABEL: wslArm64RunnerLabel,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(outputPath, "utf8").trim();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe.concurrent("generic NVIDIA GPU PR selection", () => {
  it.for(declaredSelectionPaths())(
    "selects the generic NVIDIA GPU E2E job when %s can change installer readiness",
    async (changedFile, { expect }) => {
      const result = await selectGenericGpuLane([changedFile]);
      expect(result).toBe(
        expectedSelection(
          true,
          changedFile === WORKFLOW_PATH ||
            WSL_ARM64_GENERIC_RUNTIME_OWNER_PATHS.some((path) => path === changedFile),
        ),
      );
    },
  );

  it.for(REQUIRED_RUNTIME_AUTHORITY_PATHS)(
    "independently requires the generic GPU E2E when runtime authority owner %s changes",
    async (changedFile, { expect }) => {
      const result = await selectGenericGpuLane([changedFile]);
      expect(result).toBe(
        expectedSelection(
          true,
          WSL_ARM64_GENERIC_RUNTIME_OWNER_PATHS.some((path) => path === changedFile),
        ),
      );
    },
  );

  it.for(WSL_ARM64_QUALIFICATION_PATHS)(
    "selects physical WSL ARM64 qualification without substituting AMD64 evidence for %s",
    async (changedFile, { expect }) => {
      const result = await selectGenericGpuLane([changedFile]);
      expect(result).toBe(expectedSelection(changedFile === WORKFLOW_PATH, true));
    },
  );

  it("does not select the Docker-qualified GPU job for a Podman-only change", async ({
    expect,
  }) => {
    const result = await selectGenericGpuLane(["src/lib/onboard/runtime-provider/podman.ts"]);
    expect(result).toBe(expectedSelection(false, false));
  });

  it("does not treat an N1x identity-only change as generic x86 GPU evidence", async ({
    expect,
  }) => {
    const result = await selectGenericGpuLane(["src/lib/inference/platform-identity/n1x.ts"]);
    expect(result).toBe(expectedSelection(false, false));
  });

  it("does not select the generic NVIDIA GPU E2E job for unrelated documentation", async ({
    expect,
  }) => {
    const result = await selectGenericGpuLane(["docs/get-started/quickstart.mdx"]);
    expect(result).toBe(expectedSelection(false, false));
  });

  it("rejects a copied branch whose commit does not match the current PR head", async ({
    expect,
  }) => {
    const rejected = selectGenericGpuLane(["scripts/install.sh"], "b".repeat(40));
    await expect(rejected).rejects.toThrow(
      "Copied PR branch SHA does not match the current PR head",
    );
  });

  it("rejects a PR whose base SHA is not a lowercase 40-character SHA", async ({ expect }) => {
    const rejected = selectGenericGpuLane(["scripts/install.sh"], CANDIDATE_SHA, "main");
    await expect(rejected).rejects.toThrow();
  });

  it("fails closed when WSL ARM64 proof owners change without a reviewed runner label", async ({
    expect,
  }) => {
    const rejected = selectGenericGpuLane(
      [ARM64_PROOF_AUTHORITY_PATHS[0]],
      CANDIDATE_SHA,
      BASE_SHA,
      "",
    );
    await expect(rejected).rejects.toThrow(
      "WSL_ARM64_MULTI_GPU_RUNNER_LABEL must name the reviewed physical WSL ARM64 multi-GPU runner",
    );
  });

  it("pins the Docker-qualified GPU job and captures post-request runtime diagnostics", ({
    expect,
  }) => {
    assert.match(
      readFileSync(LLAMA_LIVE_TEST_PATH, "utf8"),
      /const agent = await host\.nemoclaw\([\s\S]*await captureManagedRuntimeLogs\([^)]*\);[\s\S]*expect\(agent\.exitCode/u,
      "llama.cpp runtime logs must be captured after the agent request and before its exit assertion",
    );
    expect(workflow().jobs["llama-cpp-generic-gpu"]?.env?.NEMOCLAW_GATEWAY_RUNTIME).toBe("docker");
  });

  // source-shape-contract: security -- The copied PR workflow must use the base-reviewed verifier to bind the exact PR managed-image publication before the generic GPU job receives its revision
  it("binds the exact PR publication to the generic NVIDIA GPU job", ({ expect }) => {
    const value = workflow();
    const selector = value.jobs["select-llama-cpp-generic-gpu"];

    expect(selector?.permissions).toEqual({
      actions: "read",
      contents: "read",
    });
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

    const reviewedNpm = selector?.steps?.find((step) => step.name === "Install reviewed npm");
    expect(reviewedNpm).toMatchObject({
      if: "${{ steps.changed.outputs.selected == 'true' }}",
      uses: "NVIDIA/NemoClaw/.github/actions/setup-reviewed-npm@98669f24d35f18e49b6b2769cd68709509ea24f2",
    });

    const publication = selector?.steps?.find((step) => step.id === "publication");
    expect(publication).toMatchObject({
      env: {
        BASE_SHA: "${{ steps.changed.outputs.base_sha }}",
        CANDIDATE_REPOSITORY: "${{ github.repository }}",
        CANDIDATE_SHA: "${{ steps.changed.outputs.head_sha }}",
        GITHUB_TOKEN: "${{ github.token }}",
        MANAGED_IMAGE_SHA: "${{ steps.changed.outputs.head_sha }}",
        PR_NUMBER: "${{ steps.changed.outputs.pr_number }}",
      },
      if: "${{ steps.changed.outputs.selected == 'true' }}",
    });
    expect(publication?.run).toContain("tools/e2e/pr-managed-image-publication.mts");
    expect(publication?.run).toContain("candidate-catalog)");
    expect(publication?.run).toContain("base-cohort)");
    expect(publication?.run).toContain("sleep 30");
    expect(publication?.run).toContain("export GITHUB_REF=refs/heads/main");
    expect(publication?.run).toContain('export GITHUB_SHA="$EXPECTED_SHA"');
    expect(publication?.run).toContain(
      "node --no-warnings tools/e2e/base-image-publication.mts \\",
    );

    expect(value.jobs["llama-cpp-generic-gpu"]?.env?.E2E_MANAGED_IMAGE_REVISION).toBe(
      "${{ needs.select-llama-cpp-generic-gpu.outputs.managed_image_revision }}",
    );
    expect(selector?.outputs).toMatchObject({
      wsl_arm64_runner_label: "${{ steps.changed.outputs.wsl_arm64_runner_label }}",
      wsl_arm64_selected: "${{ steps.changed.outputs.wsl_arm64_selected }}",
    });
    const selectionStep = selector?.steps?.find(
      (step) => step.name === "Select llama.cpp generic GPU E2E from PR files",
    );
    expect(selectionStep?.env?.WSL_ARM64_MULTI_GPU_RUNNER_LABEL).toBe(
      "${{ vars.WSL_ARM64_MULTI_GPU_RUNNER_LABEL }}",
    );
    expect(selectionStep?.run).toMatch(
      /WSL_ARM64_MULTI_GPU_RUNNER_LABEL.*reviewed physical WSL ARM64 multi-GPU runner/su,
    );

    const job = value.jobs["wsl-arm64-multi-gpu"];
    expect(job).toMatchObject({
      needs: "select-llama-cpp-generic-gpu",
      "runs-on": "${{ needs.select-llama-cpp-generic-gpu.outputs.wsl_arm64_runner_label }}",
      "timeout-minutes": 45,
    });
    expect(job?.steps?.find((step) => step.name === "Check out exact PR head")).toMatchObject({
      with: { "persist-credentials": false, ref: "${{ github.sha }}" },
    });
    const trustedCheckout = job?.steps?.find(
      (step) => step.name === "Check out trusted WSL helper from PR base",
    );
    expect(trustedCheckout).toMatchObject({
      with: {
        "persist-credentials": false,
        ref: "${{ needs.select-llama-cpp-generic-gpu.outputs.base_sha }}",
      },
    });
    expect(trustedCheckout?.with?.["sparse-checkout"]).toContain(
      ".github/actions/ci-install-dependencies.sh",
    );
    expect(trustedCheckout?.with?.["sparse-checkout"]).toContain(
      "scripts/checks/prepare-ci-npm-install.mts",
    );
    expect(
      job?.steps?.find((step) => step.name === "Verify physical Windows ARM64 runner")?.run,
    ).toContain("OSArchitecture");
    expect(
      job?.steps?.find(
        (step) => step.name === "Require configured Ubuntu WSL and Docker Desktop GPU integration",
      )?.run,
    ).toMatch(/aarch64.*\/dev\/dxg.*docker info.*nvidia-smi -L/su);
    expect(
      job?.steps?.find((step) => step.name === "Run WSL ARM64 multi-GPU live qualification")?.run,
    ).toContain("tools/e2e/wsl-arm64-multi-gpu-qualification.mts");
    const install = job?.steps?.find(
      (step) => step.name === "Install dependencies and build in WSL",
    );
    expect(install?.env?.NODE_AUTH_TOKEN).toBe("${{ github.token }}");
    expect(install?.run).toContain("$trustedWorkdir/.github/actions/ci-install-dependencies.sh");
    expect(install?.run).toContain("unset NODE_AUTH_TOKEN");
    expect(install?.run).not.toContain("bash .github/actions/ci-install-dependencies.sh");
    expect(
      job?.steps?.find(
        (step) => step.name === "Upload WSL ARM64 multi-GPU qualification artifacts",
      ),
    ).toMatchObject({
      if: "always()",
      uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      with: { "if-no-files-found": "error", "retention-days": 14 },
    });
    const uploadIndex = job?.steps?.findIndex(
      (step) => step.name === "Upload WSL ARM64 multi-GPU qualification artifacts",
    );
    const cleanupIndex = job?.steps?.findIndex(
      (step) => step.name === "Remove WSL ARM64 qualification workspaces",
    );
    expect(cleanupIndex).toBeGreaterThan(uploadIndex ?? -1);
    expect(job?.steps?.[cleanupIndex ?? -1]).toMatchObject({
      if: "always()",
      run: expect.stringContaining("rm -rf -- $workdir $trustedWorkdir"),
    });
  });
});

describe("OpenClaw managed-image copied-PR qualification", () => {
  // source-shape-contract: security -- Copied PR qualification must run the exact typed final-image security test and retain its evidence
  it("runs the typed security test against the produced image and uploads evidence", () => {
    const job = workflow().jobs["managed-image-openclaw-security"];
    expect(job).toMatchObject({
      env: {
        E2E_TARGET_ID: "managed-image-openclaw-security",
        NEMOCLAW_E2E_SHARD: "default",
        NEMOCLAW_MANAGED_IMAGE_SECURITY_COHORT: "pr-${{ github.run_id }}-${{ github.run_attempt }}",
        NEMOCLAW_RUN_LIVE_E2E: "1",
        NEMOCLAW_TEST_IMAGE: "nemoclaw-production",
      },
      needs: "build-sandbox-images",
      "timeout-minutes": 15,
    });
    expect(
      job.steps?.find((step) => step.name === "Bind managed-image risk signal identity"),
    ).toMatchObject({
      run: expect.stringMatching(/NEMOCLAW_E2E_EXPECTED_SHA[\s\S]*NEMOCLAW_E2E_CORRELATION_ID/u),
    });
    expect(
      job.steps?.find((step) => step.name === "Validate OpenClaw managed-image security boundary"),
    ).toMatchObject({
      run: expect.stringContaining(
        "vitest run --project integration test/e2e-runtime/managed-image-openclaw-security.test.ts",
      ),
    });
    expect(job.steps?.find((step) => step.name === "Validate glibc probe lifecycle")).toMatchObject(
      {
        if: "${{ !cancelled() }}",
        env: { NEMOCLAW_RUN_GLIBC_PROBE_DOCKER_E2E: "1" },
        run: expect.stringContaining(
          "test/e2e-runtime/image-compatibility-docker-lifecycle.test.ts",
        ),
      },
    );
    expect(
      job.steps?.find((step) => step.name === "Remove managed-image security resources"),
    ).toMatchObject({
      if: "${{ always() }}",
      run: expect.stringMatching(
        /managed-image\.cohort[\s\S]*docker ps -aq[\s\S]*docker rm -f[\s\S]*docker volume rm -f[\s\S]*docker ps -aq[\s\S]*docker volume ls -q[\s\S]*cleanup_failed/u,
      ),
    });
    expect(
      job.steps?.find((step) => step.name === "Upload OpenClaw managed-image security evidence"),
    ).toMatchObject({
      if: "${{ always() }}",
      uses: "./.github/actions/upload-e2e-artifacts",
      with: {
        name: "managed-image-openclaw-security-evidence",
        path: "${{ env.E2E_ARTIFACT_DIR }}",
      },
    });
  });
});

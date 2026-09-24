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
const REQUIRED_RUNTIME_AUTHORITY_PATHS = [
  "src/lib/inference/nim.ts",
  "src/lib/onboard/provider-selection.ts",
  "src/lib/onboard/runtime-provider/configured-runtime.ts",
  "src/lib/onboard/runtime-provider/current.ts",
  "src/lib/onboard/setup-nim-flow.ts",
] as const;
const ARM64_PROOF_AUTHORITY_PATHS = [
  "src/lib/container-gpu-proof.ts",
  "src/lib/onboard/runtime-provider/nvidia-container-proof.ts",
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

function declaredSelectionPaths(): readonly string[] {
  const script = selectorScript();
  const exactPaths = [...script.matchAll(/\.filename == "([^"]+)"/gu)].map(([, value]) => {
    assert(typeof value === "string", "exact selector path is missing");
    return value;
  });
  const representativePrefixPaths = [...script.matchAll(/startswith\("([^"]+)"\)/gu)].map(
    ([, value]) => {
      assert(typeof value === "string", "selector prefix is missing");
      return `${value}selector-contract.ts`;
    },
  );
  const paths = [...new Set([...exactPaths, ...representativePrefixPaths])].sort();
  assert(paths.length > 0, "llama.cpp GPU selector inventory is empty");
  return paths;
}

async function selectGenericGpuLane(
  changedFiles: readonly string[],
  copiedSha = CANDIDATE_SHA,
  baseSha = BASE_SHA,
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
        `base_sha=${BASE_SHA}\nhead_sha=${CANDIDATE_SHA}\npr_number=8748\nselected=true`,
      );
    },
  );

  it.for(REQUIRED_RUNTIME_AUTHORITY_PATHS)(
    "independently requires the generic GPU E2E when runtime authority owner %s changes",
    async (changedFile, { expect }) => {
      const result = await selectGenericGpuLane([changedFile]);
      expect(result).toBe(
        `base_sha=${BASE_SHA}\nhead_sha=${CANDIDATE_SHA}\npr_number=8748\nselected=true`,
      );
    },
  );

  it.for(ARM64_PROOF_AUTHORITY_PATHS)(
    "does not select the Docker-qualified AMD64 GPU job for ARM64 proof owner %s",
    async (changedFile, { expect }) => {
      const result = await selectGenericGpuLane([changedFile]);
      expect(result).toBe(
        `base_sha=${BASE_SHA}\nhead_sha=${CANDIDATE_SHA}\npr_number=8748\nselected=false`,
      );
    },
  );

  it("does not select the Docker-qualified GPU job for a Podman-only change", async ({
    expect,
  }) => {
    const result = await selectGenericGpuLane(["src/lib/onboard/runtime-provider/podman.ts"]);
    expect(result).toBe(
      `base_sha=${BASE_SHA}\nhead_sha=${CANDIDATE_SHA}\npr_number=8748\nselected=false`,
    );
  });

  it("does not treat an N1x identity-only change as generic x86 GPU evidence", async ({
    expect,
  }) => {
    const result = await selectGenericGpuLane(["src/lib/inference/platform-identity/n1x.ts"]);
    expect(result).toBe(
      `base_sha=${BASE_SHA}\nhead_sha=${CANDIDATE_SHA}\npr_number=8748\nselected=false`,
    );
  });

  it("does not select the generic NVIDIA GPU E2E job for unrelated documentation", async ({
    expect,
  }) => {
    const result = await selectGenericGpuLane(["docs/get-started/quickstart.mdx"]);
    expect(result).toBe(
      `base_sha=${BASE_SHA}\nhead_sha=${CANDIDATE_SHA}\npr_number=8748\nselected=false`,
    );
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

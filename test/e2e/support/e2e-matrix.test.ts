// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { target } from "../registry/builder.ts";
import { buildLiveTargetMatrix } from "../registry/run.ts";
import { resolveRunnerForTarget } from "../registry/runner-routing.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const RUN_TARGETS = path.join(REPO_ROOT, "test/e2e/registry/run.ts");
const TSX = path.join(REPO_ROOT, "node_modules/.bin/tsx");

function runEmitLiveMatrix(args: string[] = []) {
  return spawnSync(TSX, [RUN_TARGETS, "--emit-live-matrix", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
  });
}

describe("live E2E target matrix", () => {
  it("honors an explicit runs-on:<label> requirement override", () => {
    const custom = target("test-runs-on-override")
      .description("test fixture")
      .manifest("test/e2e/manifests/openclaw-nvidia.yaml")
      .environment({
        platform: "ubuntu-local",
        install: "repo-current",
        runtime: "docker-running",
        onboarding: "cloud-openclaw",
      })
      .expectedState("cloud-openclaw-ready")
      .onboardingAssertions(["base-installed"])
      .suites(["smoke"])
      .runnerRequirements(["runs-on:custom-self-hosted"])
      .build();
    expect(resolveRunnerForTarget(custom).runner).toBe("custom-self-hosted");
  });

  it("rejects empty runs-on requirement overrides", () => {
    const broken = target("test-empty-runs-on-override")
      .description("test fixture")
      .manifest("test/e2e/manifests/openclaw-nvidia.yaml")
      .environment({
        platform: "ubuntu-local",
        install: "repo-current",
        runtime: "docker-running",
        onboarding: "cloud-openclaw",
      })
      .expectedState("cloud-openclaw-ready")
      .onboardingAssertions(["base-installed"])
      .suites(["smoke"])
      .runnerRequirements(["runs-on:   "])
      .build();
    expect(() => resolveRunnerForTarget(broken)).toThrow(/empty runs-on override/);
  });

  it("fails loudly when a platform has no default runner mapping", () => {
    const broken = target("test-unknown-platform")
      .description("test fixture")
      .manifest("test/e2e/manifests/openclaw-nvidia.yaml")
      .environment({
        platform: "made-up-platform",
        install: "repo-current",
        runtime: "docker-running",
        onboarding: "cloud-openclaw",
      })
      .expectedState("cloud-openclaw-ready")
      .onboardingAssertions(["base-installed"])
      .suites(["smoke"])
      .build();
    expect(() => resolveRunnerForTarget(broken)).toThrow(/no default for platform/);
  });

  it("builds the default live matrix from fixture-supported targets only", () => {
    expect(buildLiveTargetMatrix().map((entry) => entry.id)).toEqual([
      "ubuntu-repo-cloud-langchain-deepagents-code",
      "ubuntu-repo-cloud-openclaw",
      "ubuntu-repo-docker-post-reboot-recovery",
    ]);
    expect(buildLiveTargetMatrix()[0]).toMatchObject({
      id: "ubuntu-repo-cloud-langchain-deepagents-code",
      runner: "ubuntu-latest",
      platform: "ubuntu-local",
      install: "repo-current",
      runtime: "docker-running",
      onboarding: "cloud-langchain-deepagents-code",
      expectedStateId: "cloud-deepagents-code-ready",
      requiredSecrets: ["NVIDIA_INFERENCE_API_KEY"],
      supported: true,
      supportReasons: [],
      pendingRuntimeSuites: ["smoke", "inference", "terminal-agent", "deepagents-code-policy"],
    });
    expect(buildLiveTargetMatrix()[1]).toMatchObject({
      id: "ubuntu-repo-cloud-openclaw",
      runner: "ubuntu-latest",
      platform: "ubuntu-local",
      install: "repo-current",
      runtime: "docker-running",
      onboarding: "cloud-openclaw",
      expectedStateId: "cloud-openclaw-ready",
      requiredSecrets: ["NVIDIA_INFERENCE_API_KEY"],
      supported: true,
      supportReasons: [],
      pendingRuntimeSuites: ["smoke", "inference", "credentials"],
    });
    // Failing-test-first guard for #4423. Pinned in the matrix to
    // confirm the lifecycle whitelist + post-reboot-recovery target
    // are wired together; the actual RED/GREEN behavior is exercised
    // by the live runner (gates on the fix landing in src/lib/).
    expect(buildLiveTargetMatrix()[2]).toMatchObject({
      id: "ubuntu-repo-docker-post-reboot-recovery",
      runner: "ubuntu-latest",
      platform: "ubuntu-local",
      install: "repo-current",
      runtime: "docker-running",
      onboarding: "cloud-openclaw",
      expectedStateId: "post-reboot-recovery-ready",
      requiredSecrets: ["NVIDIA_INFERENCE_API_KEY"],
      supported: true,
      supportReasons: [],
    });
  });

  it("keeps explicitly selected unsupported live targets in the matrix with skip reasons", () => {
    expect(buildLiveTargetMatrix(["ubuntu-repo-cloud-hermes"])).toEqual([
      expect.objectContaining({
        id: "ubuntu-repo-cloud-hermes",
        supported: false,
        supportReasons: ["onboarding 'cloud-hermes' is not wired for live fixtures"],
      }),
    ]);
  });

  it("prints a single-line JSON array of supported live E2E targets for --emit-live-matrix", () => {
    const result = runEmitLiveMatrix();
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines.length, "live matrix output must be a single line").toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.map((entry: { id: string }) => entry.id)).toEqual([
      "ubuntu-repo-cloud-langchain-deepagents-code",
      "ubuntu-repo-cloud-openclaw",
      "ubuntu-repo-docker-post-reboot-recovery",
    ]);
  });

  it("honors explicit target selections for --emit-live-matrix", () => {
    const result = runEmitLiveMatrix(["--targets", "ubuntu-repo-cloud-hermes"]);
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toEqual([
      expect.objectContaining({
        id: "ubuntu-repo-cloud-hermes",
        supported: false,
      }),
    ]);
  });

  it("rejects retired typed-shell runner flags", () => {
    const result = spawnSync(TSX, [RUN_TARGETS, "--emit-matrix"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("Unknown argument: --emit-matrix");
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { scenario } from "../scenarios/builder.ts";
import { buildLiveScenarioMatrix } from "../scenarios/run.ts";
import { resolveRunnerForScenario } from "../scenarios/runner-routing.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const RUN_SCENARIOS = path.join(REPO_ROOT, "test/e2e-scenario/scenarios/run.ts");
const TSX = path.join(REPO_ROOT, "node_modules/.bin/tsx");

function runEmitLiveMatrix(args: string[] = []) {
  return spawnSync(TSX, [RUN_SCENARIOS, "--emit-live-matrix", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
  });
}

describe("live Vitest scenario matrix", () => {
  it("honors an explicit runs-on:<label> requirement override", () => {
    const custom = scenario("test-runs-on-override")
      .description("test fixture")
      .manifest("test/e2e-scenario/manifests/openclaw-nvidia.yaml")
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
    expect(resolveRunnerForScenario(custom).runner).toBe("custom-self-hosted");
  });

  it("rejects empty runs-on requirement overrides", () => {
    const broken = scenario("test-empty-runs-on-override")
      .description("test fixture")
      .manifest("test/e2e-scenario/manifests/openclaw-nvidia.yaml")
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
    expect(() => resolveRunnerForScenario(broken)).toThrow(/empty runs-on override/);
  });

  it("fails loudly when a platform has no default runner mapping", () => {
    const broken = scenario("test-unknown-platform")
      .description("test fixture")
      .manifest("test/e2e-scenario/manifests/openclaw-nvidia.yaml")
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
    expect(() => resolveRunnerForScenario(broken)).toThrow(/no default for platform/);
  });

  it("builds the default live Vitest matrix from fixture-supported scenarios only", () => {
    expect(buildLiveScenarioMatrix().map((entry) => entry.id)).toEqual([
      "ubuntu-repo-cloud-openclaw",
      "ubuntu-repo-docker-post-reboot-recovery",
    ]);
    expect(buildLiveScenarioMatrix()[0]).toMatchObject({
      id: "ubuntu-repo-cloud-openclaw",
      runner: "ubuntu-latest",
      platform: "ubuntu-local",
      install: "repo-current",
      runtime: "docker-running",
      onboarding: "cloud-openclaw",
      expectedStateId: "cloud-openclaw-ready",
      requiredSecrets: ["NVIDIA_API_KEY"],
      supported: true,
      supportReasons: [],
      pendingRuntimeSuites: ["smoke", "inference", "credentials"],
    });
    // Failing-test-first guard for #4423. Pinned in the matrix to
    // confirm the lifecycle whitelist + post-reboot-recovery scenario
    // are wired together; the actual RED/GREEN behavior is exercised
    // by the live runner (gates on the fix landing in src/lib/).
    expect(buildLiveScenarioMatrix()[1]).toMatchObject({
      id: "ubuntu-repo-docker-post-reboot-recovery",
      runner: "ubuntu-latest",
      platform: "ubuntu-local",
      install: "repo-current",
      runtime: "docker-running",
      onboarding: "cloud-openclaw",
      expectedStateId: "post-reboot-recovery-ready",
      requiredSecrets: ["NVIDIA_API_KEY"],
      supported: true,
      supportReasons: [],
    });
  });

  it("keeps explicitly selected unsupported live scenarios in the matrix with skip reasons", () => {
    expect(buildLiveScenarioMatrix(["ubuntu-repo-cloud-hermes"])).toEqual([
      expect.objectContaining({
        id: "ubuntu-repo-cloud-hermes",
        supported: false,
        supportReasons: ["onboarding 'cloud-hermes' is not wired for live Vitest fixtures"],
      }),
    ]);
  });

  it("--emit-live-matrix prints a single-line JSON array for supported live Vitest scenarios", () => {
    const result = runEmitLiveMatrix();
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines.length, "live matrix output must be a single line").toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.map((entry: { id: string }) => entry.id)).toEqual([
      "ubuntu-repo-cloud-openclaw",
      "ubuntu-repo-docker-post-reboot-recovery",
    ]);
  });

  it("--emit-live-matrix honors explicit scenario selections", () => {
    const result = runEmitLiveMatrix(["--scenarios", "ubuntu-repo-cloud-hermes"]);
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
    const result = spawnSync(TSX, [RUN_SCENARIOS, "--emit-matrix"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("Unknown argument: --emit-matrix");
  });
});

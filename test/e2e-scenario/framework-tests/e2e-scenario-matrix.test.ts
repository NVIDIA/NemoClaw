// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildScenarioMatrix } from "../scenarios/run.ts";
import { listScenarios } from "../scenarios/registry.ts";
import { resolveRunnerForScenario } from "../scenarios/runner-routing.ts";
import { scenario } from "../scenarios/builder.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const RUN_SCENARIOS = path.join(REPO_ROOT, "test/e2e-scenario/scenarios/run.ts");
const TSX = path.join(REPO_ROOT, "node_modules/.bin/tsx");

function runEmitMatrix() {
  return spawnSync(TSX, [RUN_SCENARIOS, "--emit-matrix"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
  });
}

describe("typed scenario matrix", () => {
  it("emits one matrix entry per registered scenario", () => {
    const matrix = buildScenarioMatrix();
    const ids = listScenarios().map((s) => s.id);
    expect(matrix.map((entry) => entry.id).sort()).toEqual([...ids].sort());
  });

  it("resolves a runner label for every scenario", () => {
    const matrix = buildScenarioMatrix();
    expect(matrix.length).toBeGreaterThan(0);
    for (const entry of matrix) {
      expect(entry.runner, `runner missing for ${entry.id}`).toMatch(/[A-Za-z0-9-]/);
      expect(entry.label, `label missing for ${entry.id}`).toContain(entry.id);
    }
  });

  it("routes platforms to their canonical runners", () => {
    const byId = new Map(buildScenarioMatrix().map((entry) => [entry.id, entry]));
    expect(byId.get("ubuntu-repo-cloud-openclaw")?.runner).toBe("ubuntu-latest");
    expect(byId.get("macos-repo-cloud-openclaw")?.runner).toBe("macos-26");
    expect(byId.get("wsl-repo-cloud-openclaw")?.runner).toBe("windows-latest");
    expect(byId.get("gpu-repo-local-ollama-openclaw")?.runner).toBe(
      "linux-amd64-gpu-rtxpro6000-latest-1",
    );
  });

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

  it("--emit-matrix prints a single-line JSON array compatible with $GITHUB_OUTPUT", () => {
    const result = runEmitMatrix();
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines.length, "matrix output must be a single line").toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(listScenarios().length);
    for (const entry of parsed) {
      expect(entry).toMatchObject({
        id: expect.any(String),
        runner: expect.any(String),
        label: expect.any(String),
        platform: expect.any(String),
        suites: expect.any(Array),
      });
    }
  });
});

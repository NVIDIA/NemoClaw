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

function expectExecutableTypedTargetCoverage(): void {
  for (const row of buildLiveTargetMatrix()) {
    expect(row.agentRuntime).not.toBe("unresolved");
    expect(row.observableOutcome).not.toBe("unresolved");
    expect(row.environmentOrInferenceEndpoint).not.toBe("unresolved");
    expect(row.unresolvedReason).toBe("");
  }
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

  it("rejects a removed placeholder instead of producing an empty execution", () => {
    expect(() => buildLiveTargetMatrix(["ubuntu-repo-cloud-hermes"])).toThrow(
      "Unknown target 'ubuntu-repo-cloud-hermes'",
    );
    const result = runEmitLiveMatrix(["--targets", "ubuntu-repo-cloud-hermes"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown target 'ubuntu-repo-cloud-hermes'");
  });

  it.each(["", " , "])(
    "rejects a blank explicit selection %j with available targets",
    (selection) => {
      const result = runEmitLiveMatrix(["--targets", selection]);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("--targets requires");
      expect(result.stderr).toMatch(/Available targets: .*ubuntu-repo-cloud-openclaw/);
    },
  );

  it("exposes execution coverage for every executable typed target (#9167)", () => {
    expect(buildLiveTargetMatrix()).toEqual(buildLiveTargetMatrix([], ["docker"]));
    expect(buildLiveTargetMatrix()).toHaveLength(4);
    expectExecutableTypedTargetCoverage();
  });

  it("includes managed-runtime typed fixtures in the native Podman matrix", () => {
    expect(buildLiveTargetMatrix([], ["podman"]).map((row) => row.id)).toEqual([
      "ubuntu-policy-custom-missing-presets-negative",
      "ubuntu-repo-cloud-langchain-deepagents-code",
      "ubuntu-repo-cloud-openclaw",
    ]);
  });

  it("assigns a 160-minute job timeout only to post-reboot recovery (#9622)", () => {
    expect(
      Object.fromEntries(buildLiveTargetMatrix().map((row) => [row.id, row.timeout_minutes])),
    ).toEqual({
      "ubuntu-policy-custom-missing-presets-negative": 45,
      "ubuntu-repo-cloud-langchain-deepagents-code": 45,
      "ubuntu-repo-cloud-openclaw": 45,
      "ubuntu-repo-docker-post-reboot-recovery": 160,
    });
  });

  it("prints a single-line JSON array of supported live E2E targets for --emit-live-matrix", () => {
    const result = runEmitLiveMatrix();
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines.length, "live matrix output must be a single line").toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toEqual(buildLiveTargetMatrix());
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

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { target } from "../registry/builder.ts";
import { listTargets } from "../registry/registry.ts";
import { buildLiveTargetMatrix } from "../registry/run.ts";
import { resolveRunnerForTarget } from "../registry/runner-routing.ts";
import { liveTargetSupport } from "../registry/runtime-support.ts";

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

function requireUnsupportedTarget() {
  const unsupported = listTargets().find((entry) => !liveTargetSupport(entry).supported);
  expect(unsupported, "expected at least one unsupported live E2E target").toBeDefined();
  return unsupported!;
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

  // source-shape-contract: compatibility -- Default live matrix output must cover every fixture-supported registered target once
  it("builds the default live matrix from every fixture-supported target", () => {
    const targets = listTargets();
    const supportedTargets = targets.filter((entry) => liveTargetSupport(entry).supported);
    const matrix = buildLiveTargetMatrix();

    expect(matrix).not.toHaveLength(0);
    expect(matrix.map((entry) => entry.id)).toEqual(supportedTargets.map((entry) => entry.id));
    expect(new Set(matrix.map((entry) => entry.id)).size).toBe(matrix.length);
    for (const entry of matrix) {
      const registered = supportedTargets.find((target) => target.id === entry.id);
      expect(
        registered,
        `matrix entry '${entry.id}' must resolve to a supported target`,
      ).toBeDefined();
      expect(entry).toMatchObject({
        runner: resolveRunnerForTarget(registered!).runner,
        supported: true,
        supportReasons: [],
        pendingRuntimeSuites: registered!.suiteIds ?? [],
      });
    }
  });

  it("keeps explicitly selected unsupported live targets in the matrix with skip reasons", () => {
    const unsupported = requireUnsupportedTarget();
    const support = liveTargetSupport(unsupported);

    expect(buildLiveTargetMatrix([unsupported.id])).toEqual([
      expect.objectContaining({
        id: unsupported.id,
        supported: false,
        supportReasons: support.reasons,
      }),
    ]);
  });

  it("prints a single-line JSON array of supported live E2E targets for --emit-live-matrix", () => {
    const result = runEmitLiveMatrix();
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines.length, "live matrix output must be a single line").toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toEqual(buildLiveTargetMatrix());
  });

  it("honors explicit target selections for --emit-live-matrix", () => {
    const unsupported = requireUnsupportedTarget();
    const result = runEmitLiveMatrix(["--targets", unsupported.id]);
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toEqual(buildLiveTargetMatrix([unsupported.id]));
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

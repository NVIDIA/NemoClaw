// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { listTargets } from "../registry/registry.ts";
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
  // source-shape-contract: compatibility -- Matrix generation must reject platforms without a reviewed GitHub Actions runner route
  it("fails loudly when a platform has no default runner mapping", () => {
    const target = listTargets()[0];
    const broken = {
      ...target,
      environment: { ...target.environment, platform: "made-up-platform" },
    };
    expect(() => resolveRunnerForTarget(broken)).toThrow(/no executable route for platform/);
  });

  it("rejects a removed placeholder instead of emitting an empty matrix row (#11407)", () => {
    expect(() => buildLiveTargetMatrix(["ubuntu-repo-cloud-hermes"])).toThrow(
      "Unknown target 'ubuntu-repo-cloud-hermes'",
    );
  });

  it("exposes execution coverage for every executable typed target (#9167)", () => {
    expect(buildLiveTargetMatrix()).toEqual(buildLiveTargetMatrix([], ["docker"]));
    expect(buildLiveTargetMatrix()).toHaveLength(3);
    expectExecutableTypedTargetCoverage();
  });

  it("includes managed-runtime typed fixtures in the native Podman matrix", () => {
    expect(buildLiveTargetMatrix([], ["podman"]).map((row) => row.id)).toEqual([
      "ubuntu-policy-custom-missing-presets-negative",
      "ubuntu-repo-cloud-langchain-deepagents-code",
      "ubuntu-repo-cloud-openclaw",
    ]);
  });

  it("includes ordered Deep Agents and automatic config-export budgets", () => {
    expect(
      Object.fromEntries(buildLiveTargetMatrix().map((row) => [row.id, row.timeout_minutes])),
    ).toEqual({
      "ubuntu-policy-custom-missing-presets-negative": 63,
      "ubuntu-repo-cloud-langchain-deepagents-code": 163,
      "ubuntu-repo-cloud-openclaw": 63,
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

  it("honors explicit target selections for --emit-live-matrix", () => {
    const selected = "ubuntu-repo-cloud-openclaw";
    const result = runEmitLiveMatrix(["--targets", selected]);
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toEqual(buildLiveTargetMatrix([selected]));
  });

  it("rejects removed target selections for --emit-live-matrix (#11407)", () => {
    const result = runEmitLiveMatrix(["--targets", "ubuntu-repo-cloud-hermes"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Unknown target 'ubuntu-repo-cloud-hermes'",
    );
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

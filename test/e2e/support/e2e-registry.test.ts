// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { target } from "../registry/builder.ts";
import { buildTargetRegistry, listTargets } from "../registry/registry.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const RUN_TARGETS = path.join(REPO_ROOT, "test/e2e/registry/run.ts");
const TSX = path.join(REPO_ROOT, "node_modules/.bin/tsx");

function runTargetCli(args: string[]) {
  return spawnSync(TSX, [RUN_TARGETS, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
  });
}

describe("deterministic target registry", () => {
  it("should reject duplicate target IDs", () => {
    const first = target("duplicate-id")
      .manifest("test/e2e/manifests/openclaw-nvidia.yaml")
      .build();
    const second = target("duplicate-id").manifest("test/e2e/manifests/hermes-nvidia.yaml").build();

    expect(() => buildTargetRegistry([first, second])).toThrow(/duplicate-id/);
  });

  it("should reject target IDs that are unsafe for workflow regex filters and artifact paths", () => {
    const unsafe = target("bad.id").manifest("test/e2e/manifests/openclaw-nvidia.yaml").build();

    expect(() => buildTargetRegistry([unsafe])).toThrow(/not safe for workflow regex filters/);

    const result = runTargetCli(["--emit-live-matrix", "--targets", "../escape"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /Selected target ID '\.\.\/escape' is not safe/,
    );
  });

  it("should return actionable unknown target error", () => {
    const result = runTargetCli(["--emit-live-matrix", "--targets", "does-not-exist"]);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/does-not-exist/);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Available targets:/);
    expect(`${result.stdout}${result.stderr}`).toMatch(/ubuntu-repo-cloud-openclaw/);
  });

  it("CLI should emit multiple selected live matrix entries", () => {
    const result = runTargetCli([
      "--emit-live-matrix",
      "--targets",
      "ubuntu-repo-cloud-openclaw,ubuntu-repo-cloud-hermes",
    ]);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.map((entry: { id: string }) => entry.id)).toEqual([
      "ubuntu-repo-cloud-openclaw",
      "ubuntu-repo-cloud-hermes",
    ]);
  });

  it("models missing custom policy presets as an expected onboarding failure", () => {
    const policyTarget = listTargets().find(
      (entry) => entry.id === "ubuntu-policy-custom-missing-presets-negative",
    );

    expect(policyTarget).toBeTruthy();
    expect(policyTarget?.manifestPath).toBe(
      "test/e2e/manifests/openclaw-nvidia-policy-custom-missing-presets.yaml",
    );
    expect(policyTarget?.expectedStateId).toBe("onboarding-failure-policy-presets-required");
    expect(policyTarget?.expectedFailure).toEqual({
      phase: "onboarding",
      errorClass: "policy-presets-required",
    });
  });
});

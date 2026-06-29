// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { scenario } from "../scenarios/builder.ts";
import { buildScenarioRegistry } from "../scenarios/registry.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const RUN_SCENARIOS = path.join(REPO_ROOT, "test/e2e-scenario/scenarios/run.ts");
const TSX = path.join(REPO_ROOT, "node_modules/.bin/tsx");

function runScenarioCli(args: string[]) {
  return spawnSync(TSX, [RUN_SCENARIOS, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
  });
}

describe("deterministic scenario registry", () => {
  it("should reject duplicate scenario IDs", () => {
    const first = scenario("duplicate-id")
      .manifest("test/e2e-scenario/manifests/openclaw-nvidia.yaml")
      .build();
    const second = scenario("duplicate-id")
      .manifest("test/e2e-scenario/manifests/hermes-nvidia.yaml")
      .build();

    expect(() => buildScenarioRegistry([first, second])).toThrow(/duplicate-id/);
  });

  it("should reject scenario IDs that are unsafe for workflow regex filters and artifact paths", () => {
    const unsafe = scenario("bad.id")
      .manifest("test/e2e-scenario/manifests/openclaw-nvidia.yaml")
      .build();

    expect(() => buildScenarioRegistry([unsafe])).toThrow(/not safe for workflow regex filters/);

    const result = runScenarioCli(["--emit-live-matrix", "--scenarios", "../escape"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /Selected scenario ID '\.\.\/escape' is not safe/,
    );
  });

  it("should return actionable unknown scenario error", () => {
    const result = runScenarioCli(["--emit-live-matrix", "--scenarios", "does-not-exist"]);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/does-not-exist/);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Available scenarios:/);
    expect(`${result.stdout}${result.stderr}`).toMatch(/ubuntu-repo-cloud-openclaw/);
  });

  it("CLI should emit multiple selected live matrix entries", () => {
    const result = runScenarioCli([
      "--emit-live-matrix",
      "--scenarios",
      "ubuntu-repo-cloud-openclaw,ubuntu-repo-cloud-hermes",
    ]);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.map((entry: { id: string }) => entry.id)).toEqual([
      "ubuntu-repo-cloud-openclaw",
      "ubuntu-repo-cloud-hermes",
    ]);
  });
});

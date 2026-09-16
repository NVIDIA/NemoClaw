// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadManifest } from "../registry/manifests.ts";
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
  // source-shape-contract: compatibility -- Duplicate IDs would make workflow selectors and artifact ownership ambiguous
  it("should reject duplicate target IDs", () => {
    const registered = listTargets()[0]!;
    const first = { ...registered, id: "duplicate-id" };
    const second = { ...registered, id: "duplicate-id" };

    expect(() => buildTargetRegistry([first, second])).toThrow(/duplicate-id/);
  });

  // source-shape-contract: security -- Target IDs cross workflow regex and artifact-path boundaries and must remain path-safe
  it("should reject target IDs that are unsafe for workflow regex filters and artifact paths", () => {
    const unsafe = { ...listTargets()[0]!, id: "bad.id" };

    expect(() => buildTargetRegistry([unsafe])).toThrow(/not safe for workflow regex filters/);

    const result = runTargetCli(["--emit-live-matrix", "--targets", "../escape"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /Selected target ID '\.\.\/escape' is not safe/,
    );
  });

  // source-shape-contract: compatibility -- The registry inventory must contain only targets that the live runner can execute
  it("contains only the four executable typed targets (#11407)", () => {
    expect(listTargets().map((target) => target.id)).toEqual([
      "ubuntu-policy-custom-missing-presets-negative",
      "ubuntu-repo-cloud-langchain-deepagents-code",
      "ubuntu-repo-cloud-openclaw",
      "ubuntu-repo-docker-post-reboot-recovery",
    ]);
  });

  // source-shape-contract: compatibility -- A registered target must resolve to an expected-state contract before live execution
  it("rejects dangling expected-state references (#11407)", () => {
    const registered = listTargets()[0]!;
    expect(() =>
      buildTargetRegistry([{ ...registered, expectedStateId: "missing-expected-state" }]),
    ).toThrow("Unknown expected_state id 'missing-expected-state'");
  });

  it.each(listTargets())(
    "resolves $id to a valid repository manifest (#11407)",
    ({ manifestPath }) => {
      loadManifest(path.join(REPO_ROOT, manifestPath));
    },
  );

  // source-shape-contract: compatibility -- The target CLI must reject unknown selectors with actionable registered choices
  it("should return actionable unknown target error", () => {
    const result = runTargetCli(["--emit-live-matrix", "--targets", "does-not-exist"]);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toMatch(/does-not-exist/);
    expect(output).toMatch(/Available targets:/);
    expect(listTargets().every((registered) => output.includes(registered.id))).toBe(true);
  });

  // source-shape-contract: compatibility -- The target CLI must preserve requested ordering for multiple live selectors
  it("CLI should emit multiple selected live matrix entries", () => {
    const selectedIds = listTargets()
      .slice(0, 2)
      .map((registered) => registered.id);
    const result = runTargetCli(["--emit-live-matrix", "--targets", selectedIds.join(",")]);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.map((entry: { id: string }) => entry.id)).toEqual(selectedIds);
  });
});

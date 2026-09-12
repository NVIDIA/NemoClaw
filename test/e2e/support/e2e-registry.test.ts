// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { target } from "../registry/builder.ts";
import {
  buildExecutionInventory,
  listTargets,
  sharedTarget,
} from "../../../tools/e2e/target-inventory.mts";

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
    const second = target("duplicate-id").manifest("synthetic/second-manifest.yaml").build();

    expect(() =>
      buildExecutionInventory(
        [first, second].map((definition) => ({
          id: definition.id,
          route: "typed" as const,
          definition,
        })),
      ),
    ).toThrow(/duplicate-id/);
  });

  it("rejects a typed target that reuses a shared target ID", () => {
    const shared = sharedTarget("vllm-docker-storage");
    const typed = target(shared.id).build();
    expect(() =>
      buildExecutionInventory([
        { id: shared.id, route: "shared", definition: shared },
        { id: typed.id, route: "typed", definition: typed },
      ]),
    ).toThrow("Duplicate target IDs: vllm-docker-storage");
  });

  it("should reject target IDs that are unsafe for workflow regex filters and artifact paths", () => {
    const unsafe = target("bad.id").manifest("test/e2e/manifests/openclaw-nvidia.yaml").build();

    expect(() =>
      buildExecutionInventory([{ id: unsafe.id, route: "typed", definition: unsafe }]),
    ).toThrow(/not safe for workflow regex filters/);

    const result = runTargetCli(["--emit-live-matrix", "--targets", "../escape"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /Selected target ID '\.\.\/escape' is not safe/,
    );
  });

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

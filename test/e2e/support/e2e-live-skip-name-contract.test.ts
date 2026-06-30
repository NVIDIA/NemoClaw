// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { listTargets } from "../registry/registry.ts";
import { liveTargetSupport, liveTargetTestName } from "../registry/runtime-support.ts";

/**
 * Locks the contract that the live registry-targets test file registers
 * each target under a name equal to `target.id` (no `[not wired: ...]`
 * suffix), so the workflow's exact `-t "^${TARGET_ID}$"` filter matches
 * supported AND unsupported entries identically. Without this contract,
 * explicit unsupported selections on `workflow_dispatch` would match zero
 * tests and Vitest would exit non-zero with no structured skip reason.
 */
describe("live registry-targets skip-name contract", () => {
  it("registers every target under a name equal to its id", () => {
    const targets = listTargets();
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(liveTargetTestName(target)).toBe(target.id);
    }
  });

  it('matches the workflow\'s exact `-t "^${TARGET_ID}$"` regex for every target', () => {
    for (const target of listTargets()) {
      const name = liveTargetTestName(target);
      const filter = new RegExp(`^${target.id}$`);
      expect(filter.test(name), `workflow filter must match registered name for ${target.id}`).toBe(
        true,
      );
    }
  });

  it("matches an explicit unsupported selection through the workflow filter", () => {
    const unsupported = listTargets().find((entry) => entry.id === "ubuntu-repo-cloud-hermes");
    expect(
      unsupported,
      "ubuntu-repo-cloud-hermes must remain a canonical unsupported example",
    ).toBeTruthy();
    const support = liveTargetSupport(unsupported!);
    expect(support.supported).toBe(false);

    const name = liveTargetTestName(unsupported!);
    const filter = new RegExp(`^${unsupported!.id}$`);
    expect(filter.test(name)).toBe(true);
    // Negative: any historical `[not wired: ...]` suffix would break the workflow filter.
    expect(name).not.toMatch(/\[not wired:/);
  });

  it("registers the canonical supported target under its bare id", () => {
    const supported = listTargets().find((entry) => entry.id === "ubuntu-repo-cloud-openclaw");
    expect(supported).toBeTruthy();
    expect(liveTargetSupport(supported!).supported).toBe(true);
    expect(liveTargetTestName(supported!)).toBe("ubuntu-repo-cloud-openclaw");
  });

  // Note: the workflow's `-t "^${TARGET_ID}$"` filter pattern itself is
  // locked by `tools/e2e/workflow-boundary.mts` and exercised by
  // `e2e-workflow.test.ts`. This file only needs to guarantee
  // that the test names registered under that filter equal `target.id`.
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { target } from "../registry/builder.ts";
import { listTargets } from "../registry/registry.ts";
import { liveTargetSupport, liveTargetTestTitle } from "../registry/runtime-support.ts";
import type { TargetDefinition } from "../registry/types.ts";

function syntheticTarget(platform: string): TargetDefinition {
  const definition = target(`synthetic-${platform}`)
    .environment({
      platform,
      install: "repo-current",
      runtime: "docker-running",
      onboarding: "cloud-openclaw",
    })
    .expectedState("synthetic-ready")
    .build();
  return platform === "ubuntu-local"
    ? {
        ...definition,
        executionCoverage: {
          agentRuntime: "openclaw",
          observableOutcome: "Synthetic target reaches the expected state",
          environmentOrInferenceEndpoint: "Ubuntu test fixture; no inference endpoint",
          unresolvedReason: "",
        },
      }
    : definition;
}

/**
 * Locks the contract that the live registry-targets test file registers
 * each target under a title prefixed by `target.id`, so the workflow's stable
 * ID filter matches supported and unsupported entries identically. Without
 * this contract, explicit unsupported selections on `workflow_dispatch` would
 * match zero tests and Vitest would exit non-zero with no structured skip reason.
 */
describe("live registry-targets skip-name contract", () => {
  it("keeps an unsupported target selectable by stable ID with an unresolved title", () => {
    const unsupported = syntheticTarget("synthetic-unwired-platform");
    const support = liveTargetSupport(unsupported);
    expect(support.supported).toBe(false);

    const title = liveTargetTestTitle(unsupported);
    const filter = new RegExp(`^${unsupported.id}:`);
    expect(title).toBe(`${unsupported.id}: unresolved [unresolved; unresolved]`);
    expect(filter.test(title)).toBe(true);
    expect(new RegExp(`^other-target:`).test(title)).toBe(false);
    expect(title).not.toMatch(/\[not wired:/);
  });

  it("keeps a supported target selectable by stable ID with its semantic title", () => {
    const supported = syntheticTarget("ubuntu-local");
    const title = liveTargetTestTitle(supported);

    expect(liveTargetSupport(supported).supported).toBe(true);
    expect(title).toBe(
      `${supported.id}: Synthetic target reaches the expected state [openclaw; Ubuntu test fixture; no inference endpoint]`,
    );
    expect(new RegExp(`^${supported.id}:`).test(title)).toBe(true);
  });
});

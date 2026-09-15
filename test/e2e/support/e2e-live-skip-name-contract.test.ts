// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { target } from "../registry/builder.ts";
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

describe("live registry target titles", () => {
  it("rejects an unsupported target before registering a test title", () => {
    const unsupported = syntheticTarget("synthetic-unwired-platform");
    expect(() => liveTargetTestTitle(unsupported)).toThrow(
      "is not executable: platform 'synthetic-unwired-platform' is not wired for live fixtures",
    );
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

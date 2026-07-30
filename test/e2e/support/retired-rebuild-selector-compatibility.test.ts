// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  prepareRetiredRebuildSelectorCompatibility,
  retiredRebuildCompatibilitySandboxName,
} from "../live/retired-rebuild-selector-compatibility.ts";

describe("retired rebuild selector compatibility", () => {
  it.each([
    "sandbox-rebuild",
    "upgrade-stale-sandbox",
  ] as const)("prepares %s to use isolated canonical rebuild state (#7615)", (selector) => {
    const environment = {
      E2E_TARGET_ID: selector,
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "30587862523",
      NEMOCLAW_SANDBOX_NAME: "legacy-name",
    };

    prepareRetiredRebuildSelectorCompatibility(selector, environment);

    expect(environment.NEMOCLAW_SANDBOX_NAME).toBe(
      `e2e-rebuild-openclaw-${selector}-30587862523-2`,
    );
  });

  it("rejects a legacy path invoked for another job (#7615)", () => {
    expect(() =>
      prepareRetiredRebuildSelectorCompatibility("sandbox-rebuild", {
        E2E_TARGET_ID: "upgrade-stale-sandbox",
      }),
    ).toThrow("requires matching E2E_TARGET_ID or GITHUB_JOB");
  });

  it("rejects untrusted run identity fragments (#7615)", () => {
    expect(() =>
      retiredRebuildCompatibilitySandboxName("sandbox-rebuild", {
        GITHUB_RUN_ID: "3058;echo",
      }),
    ).toThrow("GITHUB_RUN_ID must contain only decimal digits");
  });
});

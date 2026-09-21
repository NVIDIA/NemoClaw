// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  MANAGED_STARTUP_AGENTS,
  MANAGED_STARTUP_PROFILE_CAPABILITIES,
  MANAGED_STARTUP_PROFILE_EXCLUDED_DOCKER_INPUTS,
} from "./managed-startup/profile";

describe("managed startup profile release contract", () => {
  it("exports complete, fail-closed capabilities for every supported agent", () => {
    expect(Object.keys(MANAGED_STARTUP_PROFILE_CAPABILITIES).sort()).toEqual(
      [...MANAGED_STARTUP_AGENTS].sort(),
    );
    expect(MANAGED_STARTUP_PROFILE_CAPABILITIES.openclaw.dashboardModes).toEqual([
      "loopback",
      "remote",
    ]);
    expect(MANAGED_STARTUP_PROFILE_CAPABILITIES.openclaw.supportsDeviceAuth).toBe(false);
    expect(MANAGED_STARTUP_PROFILE_CAPABILITIES.hermes.dashboardModes).toEqual([
      "disabled",
      "loopback-forwarded",
    ]);
    expect(MANAGED_STARTUP_PROFILE_CAPABILITIES.hermes.inputModalities).toEqual([]);
    expect(MANAGED_STARTUP_PROFILE_CAPABILITIES["langchain-deepagents-code"].inferenceApis).toEqual(
      ["openai-completions"],
    );
    expect(
      MANAGED_STARTUP_PROFILE_CAPABILITIES["langchain-deepagents-code"].inputModalities,
    ).toEqual([]);
  });

  it("tracks the active OpenClaw release pins outside runtime startup intent", () => {
    expect(MANAGED_STARTUP_PROFILE_EXCLUDED_DOCKER_INPUTS.openclaw).toEqual(
      expect.arrayContaining([
        { input: "OPENCLAW_2026_9_1_INTEGRITY", reason: "integrity-pin" },
        { input: "OPENCLAW_2026_9_1_TARBALL", reason: "release-composition" },
        {
          input: "OPENCLAW_DIAGNOSTICS_OTEL_2026_9_1_INTEGRITY",
          reason: "integrity-pin",
        },
        {
          input: "OPENCLAW_BRAVE_PLUGIN_2026_9_1_INTEGRITY",
          reason: "integrity-pin",
        },
      ]),
    );
    expect(
      MANAGED_STARTUP_PROFILE_EXCLUDED_DOCKER_INPUTS.openclaw.map(({ input }) => input),
    ).not.toEqual(expect.arrayContaining([expect.stringContaining("2026_7_1")]));
  });
});

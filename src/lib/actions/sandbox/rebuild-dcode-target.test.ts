// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveDcodeRebuildTarget } from "./rebuild-dcode-target";

describe("resolveDcodeRebuildTarget", () => {
  it("resolves the terminal DCode target without importing dashboard metadata (#6195)", () => {
    const entry = {
      name: "dcode-workspace",
      agent: "langchain-deepagents-code",
      dashboardPort: 0,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    } as Parameters<typeof resolveDcodeRebuildTarget>[0];
    const resumeConfig = {
      provider: "compatible-endpoint",
      model: "nvidia/nemotron-3-super-120b-a12b",
      preferredInferenceApi: "openai-completions",
    } as Parameters<typeof resolveDcodeRebuildTarget>[1];

    const target = resolveDcodeRebuildTarget(entry, resumeConfig, 8080);

    expect(target).toEqual({
      agent: "langchain-deepagents-code",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      provider: "compatible-endpoint",
      model: "nvidia/nemotron-3-super-120b-a12b",
      preferredInferenceApi: "openai-completions",
    });
    expect(target).not.toHaveProperty("dashboardPort");
  });
});

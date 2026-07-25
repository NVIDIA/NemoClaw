// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildOldHermesDockerfile } from "../live/rebuild-hermes-dockerfile.ts";

describe("Hermes rebuild Docker fixture", () => {
  it("renders legacy state as the sandbox user without broadening its policy", () => {
    const dockerfile = buildOldHermesDockerfile({
      baseTag: "example/hermes-old:fixture",
      discordPlaceholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
    });
    expect(dockerfile).toContain("FROM example/hermes-old:fixture");
    expect(dockerfile).toContain("USER sandbox");
    expect(dockerfile).toContain("DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN");
    expect(dockerfile).not.toContain("USER root");
    expect(dockerfile).not.toContain("/etc/openshell/policy.yaml");
  });
});

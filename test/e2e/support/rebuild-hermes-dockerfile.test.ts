// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildOldHermesDockerfile } from "../live/rebuild-hermes-dockerfile.ts";

describe("Hermes rebuild Docker fixture", () => {
  it("makes the old Hermes console script executable before dropping to the sandbox user", () => {
    const dockerfile = buildOldHermesDockerfile({
      baseTag: "example/hermes-old:fixture",
      discordPlaceholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
    });
    const rootUser = dockerfile.indexOf("USER root");
    const executable = dockerfile.indexOf("chmod 0755 /opt/hermes/.venv/bin/hermes");
    const sandboxUser = dockerfile.indexOf("USER sandbox");

    expect(rootUser).toBeGreaterThanOrEqual(0);
    expect(executable).toBeGreaterThan(rootUser);
    expect(sandboxUser).toBeGreaterThan(executable);
    expect(dockerfile).toContain(
      'test "$(readlink -f /usr/local/bin/hermes)" = "/opt/hermes/.venv/bin/hermes"',
    );
  });
});

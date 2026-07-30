// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { resolveDockerStartupCommandPatch } from "./docker-startup-command-agent";

describe("Docker managed startup adapter selection", () => {
  it("does not recreate OpenClaw solely to apply a managed profile", () => {
    expect(
      resolveDockerStartupCommandPatch(
        { name: "openclaw" } as Parameters<typeof resolveDockerStartupCommandPatch>[0],
        true,
      ),
    ).toEqual({ persistStartupCommand: false, requiredUlimits: null });
  });

  it("does not select Docker lifecycle behavior for a native non-Docker driver", () => {
    expect(
      resolveDockerStartupCommandPatch(
        { name: "openclaw" } as Parameters<typeof resolveDockerStartupCommandPatch>[0],
        false,
      ),
    ).toEqual({
      persistStartupCommand: false,
      requiredUlimits: null,
    });
  });

  it("leaves the legacy OpenClaw Dockerfile path unchanged", () => {
    expect(
      resolveDockerStartupCommandPatch(
        { name: "openclaw" } as Parameters<typeof resolveDockerStartupCommandPatch>[0],
        true,
      ),
    ).toEqual({
      persistStartupCommand: false,
      requiredUlimits: null,
    });
  });

  it("retains resource-only restart recreation for Hermes and DCode", () => {
    expect(
      resolveDockerStartupCommandPatch(
        { name: "hermes" } as Parameters<typeof resolveDockerStartupCommandPatch>[0],
        true,
      ).persistStartupCommand,
    ).toBe(true);
    const dcode = resolveDockerStartupCommandPatch(
      {
        name: "langchain-deepagents-code",
      } as Parameters<typeof resolveDockerStartupCommandPatch>[0],
      true,
    );
    expect(dcode.persistStartupCommand).toBe(true);
    expect(dcode.requiredUlimits).toHaveLength(2);
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runOpenshellProviderCommand: vi.fn(),
}));

vi.mock("../../adapters/openshell/provider-command", () => ({
  runOpenshellProviderCommand: mocks.runOpenshellProviderCommand,
}));

import { assertHermesMcpMutationRuntimeCapability } from "./mcp-bridge-adapter-hermes";

describe("Hermes MCP recovery guidance", () => {
  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_INVOKED_AS", "nemohermes");
    mocks.runOpenshellProviderCommand.mockReset().mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "Hermes gateway is not running under the managed service lifecycle",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the invoked CLI name when the managed lifecycle is unavailable", () => {
    expect(() => assertHermesMcpMutationRuntimeCapability("alpha")).toThrow(
      "Run `nemohermes alpha recover` and retry.",
    );
  });
});

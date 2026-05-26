// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { createOpenclawSetup } from "./openclaw-setup";

function createDeps() {
  return {
    step: vi.fn(),
    agentProductName: vi.fn(() => "OpenClaw"),
    getProviderSelectionConfig: vi.fn(() => ({ provider: "nvidia-prod", model: "model" })),
    buildSandboxConfigSyncScript: vi.fn(() => "echo sync"),
    writeSandboxConfigSyncFile: vi.fn(() => "/tmp/nemoclaw-sync-test.sh"),
    run: vi.fn(),
    openshellArgv: vi.fn((args: string[]) => ["openshell", ...args]),
    cleanupTempDir: vi.fn(),
  };
}

describe("createOpenclawSetup", () => {
  it("runs the sync script through an explicit bash connect command", async () => {
    const deps = createDeps();
    vi.spyOn(fs, "readFileSync").mockReturnValue("echo sync from file");

    await createOpenclawSetup(deps)("demo", "model", "nvidia-prod");

    expect(deps.openshellArgv).toHaveBeenCalledWith([
      "sandbox",
      "connect",
      "demo",
      "--",
      "bash",
      "-s",
    ]);
    expect(deps.run).toHaveBeenCalledWith(
      ["openshell", "sandbox", "connect", "demo", "--", "bash", "-s"],
      expect.objectContaining({
        stdio: ["pipe", "ignore", "inherit"],
        input: "echo sync from file",
      }),
    );
  });
});

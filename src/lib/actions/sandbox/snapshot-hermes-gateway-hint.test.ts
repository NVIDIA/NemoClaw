// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { executeOrdinarySandboxCommand } from "../../adapters/sandbox/ordinary-command";
import {
  HERMES_DASHBOARD_STATE_MIGRATION_COMMAND,
  HERMES_DASHBOARD_STATE_MIGRATION_TIMEOUT_MS,
  migrateHermesLegacyDashboardState,
} from "./snapshot-hermes-gateway-hint";

vi.mock("../../adapters/sandbox/ordinary-command", () => ({
  executeOrdinarySandboxCommand: vi.fn(),
}));

describe("migrateHermesLegacyDashboardState", () => {
  it("uses the onboarding command executor and named gateway", async () => {
    const commandExecutor = { runBuffered: vi.fn() };
    vi.mocked(executeOrdinarySandboxCommand).mockResolvedValue({
      status: 0,
      stdout: "",
      stderr: "",
    });

    await migrateHermesLegacyDashboardState("hermes", undefined, {
      commandExecutor,
      gatewayName: "nemoclaw-8080",
    });

    expect(executeOrdinarySandboxCommand).toHaveBeenCalledWith(
      "hermes",
      HERMES_DASHBOARD_STATE_MIGRATION_COMMAND,
      HERMES_DASHBOARD_STATE_MIGRATION_TIMEOUT_MS,
      {
        honorCallerTimeout: true,
        commandExecutor,
        gatewayName: "nemoclaw-8080",
      },
    );
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { executeOrdinarySandboxCommand } from "../../adapters/sandbox/ordinary-command";
import {
  HERMES_DASHBOARD_STATE_MIGRATION_COMMAND,
  HERMES_DASHBOARD_STATE_MIGRATION_TIMEOUT_MS,
  migrateHermesLegacyDashboardState,
  printHermesGatewayRestoreHint,
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

describe("printHermesGatewayRestoreHint (#7312)", () => {
  it("recommends a gateway restart after restoring a Hermes SQLite state file", () => {
    const writeLine = vi.fn();

    printHermesGatewayRestoreHint(
      "clone-test",
      "hermes",
      ["runtime/state.db"],
      [{ path: "runtime/state.db", strategy: "sqlite_backup" }],
      "nemoclaw",
      writeLine,
    );

    expect(writeLine).toHaveBeenCalledTimes(1);
    expect(writeLine.mock.calls[0][0]).toContain("clone-test gateway restart");
  });

  it("does not print a restart hint for non-database Hermes state files", () => {
    const writeLine = vi.fn();

    printHermesGatewayRestoreHint(
      "clone-test",
      "hermes",
      ["SOUL.md"],
      [
        { path: "SOUL.md", strategy: "copy" },
        { path: "runtime/state.db", strategy: "sqlite_backup" },
      ],
      "nemoclaw",
      writeLine,
    );

    expect(writeLine).not.toHaveBeenCalled();
  });

  it("does not print a Hermes restart hint for other agents", () => {
    const writeLine = vi.fn();

    printHermesGatewayRestoreHint(
      "clone-test",
      "openclaw",
      ["openclaw.json"],
      [{ path: "openclaw.json", strategy: "copy" }],
      "nemoclaw",
      writeLine,
    );
    printHermesGatewayRestoreHint(
      "clone-test",
      undefined,
      ["runtime/state.db"],
      [{ path: "runtime/state.db", strategy: "sqlite_backup" }],
      "nemoclaw",
      writeLine,
    );

    expect(writeLine).not.toHaveBeenCalled();
  });
});

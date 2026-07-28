// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DashboardUrlCliCommand, {
  resetDashboardUrlRuntimeBridgeFactoryForTest,
  setDashboardUrlRuntimeBridgeFactoryForTest,
} from "./dashboard-url";

describe("dashboard-url CLI output", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setDashboardUrlRuntimeBridgeFactoryForTest(() => ({
      fetchGatewayAuthTokenFromSandbox: () => "secret-token",
      getSandbox: () => ({ agent: "openclaw", dashboardPort: 18789 }),
      getAccessUrl: () => "http://127.0.0.1:18789",
    }));
  });

  afterEach(() => {
    resetDashboardUrlRuntimeBridgeFactoryForTest();
    vi.restoreAllMocks();
  });

  it("prints the authenticated URL with connection and management guidance (#7473)", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message: string) => output.push(message));
    vi.spyOn(console, "error").mockImplementation((message: string) => errors.push(message));

    const previousExitCode = process.exitCode;
    try {
      await DashboardUrlCliCommand.run(["alpha"], process.cwd());

      expect(output).toContain("  http://127.0.0.1:18789/#token=secret-token");
      expect(output).toContain("    nemoclaw alpha connect");
      expect(output).toContain("  Manage later");
      expect(output).toContain("    Status:      nemoclaw alpha status");
      expect(output).toContain("    Logs:        nemoclaw alpha logs --follow");
      expect(errors.join("\n")).toContain("Treat this URL like a password");
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

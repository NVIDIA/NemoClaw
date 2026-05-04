// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import SandboxLogsCommand, {
  setSandboxLogsRuntimeBridgeFactoryForTest,
} from "./sandbox-logs-cli-command";

const rootDir = process.cwd();

describe("SandboxLogsCommand", () => {
  it("runs sandbox logs with default options", async () => {
    const sandboxLogs = vi.fn();
    setSandboxLogsRuntimeBridgeFactoryForTest(() => ({ sandboxLogs }));

    await SandboxLogsCommand.run(["alpha"], rootDir);

    expect(sandboxLogs).toHaveBeenCalledWith("alpha", {
      follow: false,
      lines: "200",
      since: null,
    });
  });

  it("runs sandbox logs with the follow flag", async () => {
    const sandboxLogs = vi.fn();
    setSandboxLogsRuntimeBridgeFactoryForTest(() => ({ sandboxLogs }));

    await SandboxLogsCommand.run(["alpha", "--follow"], rootDir);

    expect(sandboxLogs).toHaveBeenCalledWith("alpha", {
      follow: true,
      lines: "200",
      since: null,
    });
  });

  it("runs sandbox logs with tail and since filters", async () => {
    const sandboxLogs = vi.fn();
    setSandboxLogsRuntimeBridgeFactoryForTest(() => ({ sandboxLogs }));

    await SandboxLogsCommand.run(["alpha", "--tail", "50", "--since", "5m"], rootDir);

    expect(sandboxLogs).toHaveBeenCalledWith("alpha", {
      follow: false,
      lines: "50",
      since: "5m",
    });
  });

  it("maps -n to the tail line count", async () => {
    const sandboxLogs = vi.fn();
    setSandboxLogsRuntimeBridgeFactoryForTest(() => ({ sandboxLogs }));

    await SandboxLogsCommand.run(["alpha", "-n", "25"], rootDir);

    expect(sandboxLogs).toHaveBeenCalledWith("alpha", {
      follow: false,
      lines: "25",
      since: null,
    });
  });
});

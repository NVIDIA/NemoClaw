// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const showSandboxLogs = vi.hoisted(() => vi.fn());

vi.mock("../../lib/actions/sandbox/logs", () => ({ showSandboxLogs }));

import SandboxLogsCommand from "./logs";

const rootDir = process.cwd();

describe("SandboxLogsCommand", () => {
  beforeEach(() => {
    showSandboxLogs.mockClear();
  });

  it("runs sandbox logs with default options", async () => {
    await SandboxLogsCommand.run(["alpha"], rootDir);

    expect(showSandboxLogs).toHaveBeenCalledWith("alpha", {
      follow: false,
      lines: "200",
      since: null,
    });
  });

  it("runs sandbox logs with the follow flag", async () => {
    await SandboxLogsCommand.run(["alpha", "--follow"], rootDir);

    expect(showSandboxLogs).toHaveBeenCalledWith("alpha", {
      follow: true,
      lines: "200",
      since: null,
    });
  });

  it("runs sandbox logs with tail and since filters", async () => {
    await SandboxLogsCommand.run(["alpha", "--tail", "50", "--since", "5m"], rootDir);

    expect(showSandboxLogs).toHaveBeenCalledWith("alpha", {
      follow: false,
      lines: "50",
      since: "5m",
    });
  });

  it("maps -n to the tail line count", async () => {
    await SandboxLogsCommand.run(["alpha", "-n", "25"], rootDir);

    expect(showSandboxLogs).toHaveBeenCalledWith("alpha", {
      follow: false,
      lines: "25",
      since: null,
    });
  });
});

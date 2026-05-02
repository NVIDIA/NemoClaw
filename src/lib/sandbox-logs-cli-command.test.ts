// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import SandboxLogsCommand, {
  setSandboxLogsRuntimeBridgeFactoryForTest,
} from "./sandbox-logs-cli-command";

const rootDir = process.cwd();

describe("SandboxLogsCommand", () => {
  it("runs sandbox logs with the follow flag", async () => {
    const sandboxLogs = vi.fn();
    setSandboxLogsRuntimeBridgeFactoryForTest(() => ({ sandboxLogs }));

    await SandboxLogsCommand.run(["alpha", "--follow"], rootDir);

    expect(sandboxLogs).toHaveBeenCalledWith("alpha", true);
  });
});

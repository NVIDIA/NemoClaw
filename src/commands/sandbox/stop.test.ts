// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stopSandbox = vi.hoisted(() => vi.fn());

vi.mock("../../lib/actions/sandbox/stop", () => ({ stopSandbox }));

import SandboxStopCommand from "./stop";

const rootDir = process.cwd();

describe("SandboxStopCommand", () => {
  beforeEach(() => {
    stopSandbox.mockClear();
    stopSandbox.mockReturnValue({ exitCode: 0 });
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  it("stops the named sandbox (#6026)", async () => {
    await SandboxStopCommand.run(["alpha"], rootDir);

    expect(stopSandbox).toHaveBeenCalledWith("alpha");
    expect(process.exitCode).toBe(0);
  });

  it("propagates the action's failure exit code (#6026)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    stopSandbox.mockReturnValue({ exitCode: 1, message: "  boom" });

    await SandboxStopCommand.run(["alpha"], rootDir);

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith("  boom");
    error.mockRestore();
  });

  it("requires a sandbox name (#6026)", async () => {
    await expect(SandboxStopCommand.run([], rootDir)).rejects.toThrow(/sandbox/i);

    expect(stopSandbox).not.toHaveBeenCalled();
  });

  it("rejects extra positional arguments (#6026)", async () => {
    await expect(SandboxStopCommand.run(["alpha", "extra"], rootDir)).rejects.toThrow();

    expect(stopSandbox).not.toHaveBeenCalled();
  });
});

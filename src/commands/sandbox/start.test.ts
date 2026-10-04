// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startSandbox = vi.hoisted(() => vi.fn());

vi.mock("../../lib/actions/sandbox/start", () => ({ startSandbox }));

import SandboxStartCommand from "./start";

const rootDir = process.cwd();

describe("SandboxStartCommand", () => {
  beforeEach(() => {
    startSandbox.mockClear();
    startSandbox.mockResolvedValue({ exitCode: 0 });
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  it("starts the named sandbox (#6026)", async () => {
    await SandboxStartCommand.run(["alpha"], rootDir);

    expect(startSandbox).toHaveBeenCalledWith("alpha");
    expect(process.exitCode).toBe(0);
  });

  it("propagates the action's failure exit code (#6026)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    startSandbox.mockResolvedValue({ exitCode: 1, message: "  boom" });

    await SandboxStartCommand.run(["alpha"], rootDir);

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith("  boom");
    error.mockRestore();
  });

  it("requires a sandbox name (#6026)", async () => {
    await expect(SandboxStartCommand.run([], rootDir)).rejects.toThrow(/sandbox/i);

    expect(startSandbox).not.toHaveBeenCalled();
  });

  it("rejects extra positional arguments (#6026)", async () => {
    await expect(SandboxStartCommand.run(["alpha", "extra"], rootDir)).rejects.toThrow();

    expect(startSandbox).not.toHaveBeenCalled();
  });
});

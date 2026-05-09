// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { NEMOCLAW_UPDATE_COMMAND, runUpdateAction } from "./update";

describe("runUpdateAction", () => {
  it("--check reports update availability without running the installer", async () => {
    const spawnSyncImpl = vi.fn();
    const log = vi.fn();

    const result = await runUpdateAction(
      { check: true },
      {
        currentVersion: () => "0.1.0",
        getLatestVersion: () => "0.2.0",
        isSourceCheckout: () => false,
        log,
        spawnSyncImpl,
      },
    );

    expect(result).toEqual(
      expect.objectContaining({
        ranInstaller: false,
        status: 0,
        updateAvailable: true,
      }),
    );
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Current NemoClaw version: 0.1.0"));
  });

  it("does not run the installer for source checkouts", async () => {
    const error = vi.fn();
    const spawnSyncImpl = vi.fn();

    const result = await runUpdateAction(
      { yes: true },
      {
        currentVersion: () => "0.1.0",
        error,
        getLatestVersion: () => "0.2.0",
        isSourceCheckout: () => true,
        log: vi.fn(),
        spawnSyncImpl,
      },
    );

    expect(result.status).toBe(1);
    expect(result.ranInstaller).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("source checkout"));
    expect(spawnSyncImpl).not.toHaveBeenCalled();
  });

  it("prompts before running the maintained installer", async () => {
    const prompt = vi.fn(async () => "yes");
    const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: "", stderr: "", signal: null } as never));

    const result = await runUpdateAction(
      {},
      {
        currentVersion: () => "0.1.0",
        getLatestVersion: () => "0.2.0",
        isSourceCheckout: () => false,
        log: vi.fn(),
        prompt,
        spawnSyncImpl,
      },
    );

    expect(result.status).toBe(0);
    expect(result.ranInstaller).toBe(true);
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining("Run the maintained NemoClaw installer"));
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "bash",
      ["-lc", NEMOCLAW_UPDATE_COMMAND],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("--yes runs the maintained installer without prompting", async () => {
    const prompt = vi.fn(async () => "no");
    const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: "", stderr: "", signal: null } as never));

    const result = await runUpdateAction(
      { yes: true },
      {
        currentVersion: () => "0.1.0",
        getLatestVersion: () => "0.2.0",
        isSourceCheckout: () => false,
        log: vi.fn(),
        prompt,
        spawnSyncImpl,
      },
    );

    expect(result.status).toBe(0);
    expect(result.ranInstaller).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("skips installer when package install is already current", async () => {
    const spawnSyncImpl = vi.fn();

    const result = await runUpdateAction(
      { yes: true },
      {
        currentVersion: () => "0.2.0",
        getLatestVersion: () => "0.2.0",
        isSourceCheckout: () => false,
        log: vi.fn(),
        spawnSyncImpl,
      },
    );

    expect(result.status).toBe(0);
    expect(result.ranInstaller).toBe(false);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
  });
});

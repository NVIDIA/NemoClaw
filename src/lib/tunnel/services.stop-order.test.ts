// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stopMocks = vi.hoisted(() => ({
  stopSandboxChannels: vi.fn(),
  releaseGatewayPortForStop: vi.fn(),
}));

vi.mock("./sandbox-gateway-stop", () => ({
  stopSandboxChannels: stopMocks.stopSandboxChannels,
}));
vi.mock("./gateway-stop", () => ({
  releaseGatewayPortForStop: stopMocks.releaseGatewayPortForStop,
}));

import { type ProcessControl, stopAll } from "./services";
import { isMcpLifecycleLockHeld } from "../state/mcp-lifecycle-lock";

describe("stopAll tunnel stop ordering", () => {
  let tmpDir: string;
  let pidDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nemoclaw-stop-order-test-"));
    pidDir = join(tmpDir, "pids");
    mkdirSync(pidDir, { recursive: true });
    stopMocks.stopSandboxChannels.mockClear();
    stopMocks.releaseGatewayPortForStop.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not tear down dependent services when cloudflared cannot be stopped", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "4242");
    writeFileSync(join(pidDir, "cloudflared.dashboard-port"), "18791");
    const signal = vi.fn();
    const processControl: ProcessControl = {
      isAlive: () => true,
      commandLine: () => "cloudflared tunnel run",
      signal,
    };
    const unloadOllamaModels = vi.fn(() => undefined);
    let now = 3000;
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockImplementation(() => (now += 100));
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(() =>
      stopAll({
        pidDir,
        sandboxName: "test-box",
        processControl,
        unloadOllamaModels,
        releaseGatewayPort: true,
      }),
    ).toThrow("cloudflared could not be stopped");

    expect(signal).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(signal).toHaveBeenCalledWith(4242, "SIGKILL");
    expect(stopMocks.stopSandboxChannels).not.toHaveBeenCalled();
    expect(unloadOllamaModels).not.toHaveBeenCalled();
    expect(stopMocks.releaseGatewayPortForStop).not.toHaveBeenCalled();
  });

  it("holds the tunnel lifecycle lock through dependent service teardown", () => {
    const lockName = `cloudflared-${createHash("sha256").update(resolve(pidDir)).digest("hex")}`;
    const expectLockHeld = (): void => {
      expect(isMcpLifecycleLockHeld(lockName)).toBe(true);
    };
    stopMocks.stopSandboxChannels.mockImplementation(expectLockHeld);
    stopMocks.releaseGatewayPortForStop.mockImplementation(expectLockHeld);
    const unloadOllamaModels = vi.fn(() => {
      expectLockHeld();
      return undefined;
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    stopAll({
      pidDir,
      sandboxName: "test-box",
      unloadOllamaModels,
      releaseGatewayPort: true,
    });

    expect(stopMocks.stopSandboxChannels).toHaveBeenCalledOnce();
    expect(unloadOllamaModels).toHaveBeenCalledOnce();
    expect(stopMocks.releaseGatewayPortForStop).toHaveBeenCalledOnce();
  });
});

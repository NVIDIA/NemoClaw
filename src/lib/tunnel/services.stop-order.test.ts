// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

import { type ProcessControl, stopAll, stopCloudflared } from "./services";
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
    const signalCloudflared = vi.fn(() => "signaled" as const);
    const processControl: ProcessControl = {
      isAlive: () => true,
      commandLine: () => "cloudflared tunnel run",
      signalCloudflared,
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

    expect(signalCloudflared).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(signalCloudflared).toHaveBeenCalledWith(4242, "SIGKILL");
    expect(stopMocks.stopSandboxChannels).not.toHaveBeenCalled();
    expect(unloadOllamaModels).not.toHaveBeenCalled();
    expect(stopMocks.releaseGatewayPortForStop).not.toHaveBeenCalled();
    expect(readFileSync(join(pidDir, "cloudflared.dashboard-port"), "utf-8")).toBe("18791");
  });

  it("clears the dashboard-port record only after cloudflared stop is confirmed", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "4242");
    writeFileSync(join(pidDir, "cloudflared.dashboard-port"), "18791");
    let alive = true;
    const processControl: ProcessControl = {
      isAlive: () => alive,
      commandLine: () => "cloudflared tunnel run",
      signalCloudflared: () => {
        alive = false;
        return "signaled";
      },
    };
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(stopCloudflared({ pidDir, processControl })).toBe(true);
    expect(existsSync(join(pidDir, "cloudflared.pid"))).toBe(false);
    expect(existsSync(join(pidDir, "cloudflared.dashboard-port"))).toBe(false);
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

  it.each([
    {
      name: "an unmanaged cloudflared process remains",
      inspect: () => [4242],
      expected: "cloudflared remains running outside NemoClaw ownership (PID 4242)",
    },
    {
      name: "unmanaged-process ownership inspection fails",
      inspect: () => {
        throw new Error("ownership inspection unavailable");
      },
      expected: "ownership inspection unavailable",
    },
  ])("finishes dependent cleanup when $name", ({ inspect, expected }) => {
    const unloadOllamaModels = vi.fn(() => undefined);
    stopMocks.stopSandboxChannels.mockImplementation(() => {});
    stopMocks.releaseGatewayPortForStop.mockImplementation(() => "attempted");
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(() =>
      stopAll({
        pidDir,
        sandboxName: "test-box",
        unmanagedCloudflaredPids: inspect,
        unloadOllamaModels,
        releaseGatewayPort: true,
      }),
    ).toThrow(expected);

    expect(stopMocks.stopSandboxChannels).toHaveBeenCalledOnce();
    expect(unloadOllamaModels).toHaveBeenCalledOnce();
    expect(stopMocks.releaseGatewayPortForStop).toHaveBeenCalledOnce();
  });

  it("uses the explicit PID directory lock when the sandbox name is invalid", () => {
    const lockName = `cloudflared-${createHash("sha256").update(resolve(pidDir)).digest("hex")}`;
    const unloadOllamaModels = vi.fn(() => {
      expect(isMcpLifecycleLockHeld(lockName)).toBe(true);
      return undefined;
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    stopAll({
      pidDir,
      sandboxName: "../invalid",
      unloadOllamaModels,
    });

    expect(unloadOllamaModels).toHaveBeenCalledOnce();
  });
});

describe("stopCloudflared lifecycle lock", () => {
  it("holds the tunnel lifecycle lock while stopping the registered process", () => {
    const pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-stop-cloudflared-lock-test-"));
    const lockName = `cloudflared-${createHash("sha256").update(resolve(pidDir)).digest("hex")}`;
    writeFileSync(join(pidDir, "cloudflared.pid"), "4242");
    let alive = true;
    const signalCloudflared = vi.fn(() => {
      expect(isMcpLifecycleLockHeld(lockName)).toBe(true);
      alive = false;
      return "signaled" as const;
    });
    const processControl: ProcessControl = {
      isAlive: () => alive,
      commandLine: () => "cloudflared tunnel run",
      signalCloudflared,
    };
    vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      expect(stopCloudflared({ pidDir, processControl })).toBe(true);
      expect(signalCloudflared).toHaveBeenCalledWith(4242, "SIGTERM");
    } finally {
      rmSync(pidDir, { recursive: true, force: true });
    }
  });
});

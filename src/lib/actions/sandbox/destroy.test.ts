// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { cleanupSandboxServices } from "./destroy";

const SANDBOX = "mybox";
const mainPidDir = path.resolve("/tmp", `nemoclaw-services-${SANDBOX}`);
const googlechatPidDir = `${mainPidDir}-googlechat`;

describe("cleanupSandboxServices Google Chat tunnel cleanup (#7317)", () => {
  it("fails closed before later cleanup when the Google Chat tunnel cannot stop", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rmSync = vi.fn();
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const stopAll = vi.fn();
    const getSandbox = vi.fn(() => null);
    const googlechatWebhookTunnelPidDir = vi.fn(() => googlechatPidDir);
    const stopGooglechatWebhookTunnel = vi.fn(() => {
      throw new Error("cloudflared refused to stop");
    });

    expect(() =>
      cleanupSandboxServices(
        SANDBOX,
        { stopHostServices: true },
        {
          stopAll,
          getSandbox,
          rmSync,
          runOpenshell,
          stopGooglechatWebhookTunnel,
          googlechatWebhookTunnelPidDir,
        },
      ),
    ).toThrow(/public Google Chat webhook endpoint may still be running/);

    expect(googlechatWebhookTunnelPidDir).toHaveBeenCalledWith(mainPidDir);
    // Preserve both PID directories and refuse every later side effect so a
    // repeated destroy can still prove and stop the public endpoint.
    expect(rmSync).not.toHaveBeenCalled();
    expect(stopAll).not.toHaveBeenCalled();
    expect(getSandbox).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it("removes the Google Chat PID directory after a successful tunnel stop", () => {
    const rmSync = vi.fn();
    const stopGooglechatWebhookTunnel = vi.fn(() => googlechatPidDir);
    const googlechatWebhookTunnelPidDir = vi.fn(() => googlechatPidDir);

    cleanupSandboxServices(
      SANDBOX,
      { stopHostServices: true },
      {
        stopAll: vi.fn(),
        getSandbox: vi.fn(() => null),
        rmSync,
        runOpenshell: vi.fn(() => ({ status: 0 })),
        stopGooglechatWebhookTunnel,
        googlechatWebhookTunnelPidDir,
      },
    );

    expect(rmSync).toHaveBeenCalledWith(googlechatPidDir, { recursive: true, force: true });
  });
});

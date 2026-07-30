// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { cleanupSandboxServices } from "./destroy";

const SANDBOX = "mybox";
const mainPidDir = path.resolve("/tmp", `nemoclaw-services-${SANDBOX}`);
const googlechatPidDir = `${mainPidDir}-googlechat`;

describe("cleanupSandboxServices Google Chat tunnel cleanup (#7317)", () => {
  it("keeps the Google Chat PID directory when the tunnel stop fails so a later destroy can stop the orphaned processes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rmSync = vi.fn();
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const googlechatWebhookTunnelPidDir = vi.fn(() => googlechatPidDir);
    const stopGooglechatWebhookTunnel = vi.fn(() => {
      throw new Error("cloudflared refused to stop");
    });

    cleanupSandboxServices(
      SANDBOX,
      { stopHostServices: true },
      {
        stopAll: vi.fn(),
        getSandbox: vi.fn(() => null),
        rmSync,
        runOpenshell,
        stopGooglechatWebhookTunnel,
        googlechatWebhookTunnelPidDir,
      },
    );

    // The main services directory is still removed.
    expect(rmSync).toHaveBeenCalledWith(mainPidDir, { recursive: true, force: true });
    // The Google Chat directory is preserved because its stop failed — deleting
    // it would orphan the public tunnel with no PID handle for a later destroy.
    expect(rmSync).not.toHaveBeenCalledWith(googlechatPidDir, expect.anything());
    expect(googlechatWebhookTunnelPidDir).toHaveBeenCalledWith(mainPidDir);
    // Destroy stays best-effort: provider cleanup still runs after the failure.
    expect(runOpenshell).toHaveBeenCalled();
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

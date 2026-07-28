// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGatewayHostRuntime, type GatewayHostRuntimeDeps } from "./gateway-host-runtime";
import type { PortProbeResult } from "./preflight";

// Homebrew 6.x refuses to load formulae from taps it has not marked trusted,
// so `brew info --json=v2 openshell` fails even though the formula is the
// pinned official one. The refusal reaches the gateway-owner resolution
// through the real spawnSync path, not an injected seam (#7707).
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn((command: string, args: readonly string[]) =>
      command === "brew" && args[0] === "info"
        ? {
            status: 1,
            stderr:
              "Error: Refusing to load formula nvidia/openshell/openshell from untrusted tap nvidia/openshell.",
            stdout: "",
          }
        : command === "launchctl"
          ? {
              status: 113,
              stderr: 'Could not find service "homebrew.mxcl.openshell" in domain for port',
              stdout: "",
            }
          : { status: 0, stderr: "", stdout: "" },
    ),
  };
});

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

function createDeps(): GatewayHostRuntimeDeps {
  return {
    applyOverlayfsAutoFix: () => null,
    checkGatewayPortAvailable: async () => ({ ok: true }) as PortProbeResult,
    gatewayName: () => "nemoclaw",
    gatewayPort: () => 8080,
    getGatewayPortListenerRawScan: () => ({ pids: [], complete: true }),
    getInstalledOpenshellVersion: () => "0.0.85",
    runCaptureOpenshell: () => "healthy",
    runOpenshell: () => ({ status: 0 }),
    resolveOpenShellGatewayBinary: () => null,
    waitForGatewayHttpReady: async () => true,
  };
}

describe("gateway host runtime on Homebrew 6.x untrusted tap", () => {
  it("resolves a standalone owner instead of aborting when brew refuses the pinned tap (#7707)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createGatewayHostRuntime(createDeps());

    expect(runtime.getGatewayOwner()).toMatchObject({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      mode: "nemoclaw-managed",
      source: "standalone",
    });
    expect(runtime.getGatewayOwner()).toMatchObject({ source: "standalone" });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

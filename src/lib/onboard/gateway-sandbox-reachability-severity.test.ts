// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  formatSandboxBridgeUnreachableMessage,
  verifySandboxBridgeGatewayReachableOrExit,
} from "./gateway-sandbox-reachability";

async function withColoredStderr<T>(callback: () => T | Promise<T>): Promise<T> {
  const originalIsTTY = process.stderr.isTTY;
  const originalGetColorDepth = process.stderr.getColorDepth;
  Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stderr, "getColorDepth", {
    value: () => 24,
    configurable: true,
  });
  vi.stubEnv("NO_COLOR", "");
  try {
    return await callback();
  } finally {
    Object.defineProperty(process.stderr, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
    Object.defineProperty(process.stderr, "getColorDepth", {
      value: originalGetColorDepth,
      configurable: true,
    });
    vi.unstubAllEnvs();
  }
}

describe("sandbox bridge reachability severity (#6004)", () => {
  it("routes warning and fatal first lines through the stderr severity renderer", async () => {
    await withColoredStderr(() => {
      const warning = formatSandboxBridgeUnreachableMessage({
        ok: false,
        reason: "probe_unavailable",
      });
      const fatal = formatSandboxBridgeUnreachableMessage({
        ok: false,
        reason: "veth_unsupported",
      });

      expect(warning.split("\n")[0]).toBe(
        "  \x1b[33m⚠ Could not verify sandbox bridge reachability.\x1b[39m",
      );
      expect(fatal.split("\n")[0]).toBe(
        "  \x1b[31m✗ Docker could not create the sandbox bridge veth pair.\x1b[39m",
      );
    });
  });

  it("colors the UFW auto-apply fallback warning", async () => {
    await withColoredStderr(async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await expect(
          verifySandboxBridgeGatewayReachableOrExit(false, {
            autoApplyImpl: () => ({
              applied: false,
              reason: "sudo_unavailable",
              detail: "passwordless sudo is unavailable",
            }),
            autoApplyOptedInImpl: () => true,
            reachabilityImpl: () => ({
              ok: false,
              reason: "tcp_failed",
              routeKind: "bridge_gateway",
              subnet: "172.18.0.0/16",
              gatewayIp: "172.18.0.1",
            }),
          }),
        ).rejects.toThrow("sandbox-bridge unreachable");
        expect(warn.mock.calls[0]?.[0]).toMatch(
          /^  \x1b\[33m⚠ NEMOCLAW_AUTO_FIX_FIREWALL=1 set but could not auto-apply UFW rule/,
        );
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
    });
  });
});

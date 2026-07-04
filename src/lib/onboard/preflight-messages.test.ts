// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  printDockerNotReachableError,
  printLowMemoryWarning,
  printMessagingProviderMissing,
  printSwapCreationFailed,
  printUnderProvisionedRuntimeWarning,
  printUnsupportedRuntimeError,
} from "./preflight-messages";

function lines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) => String(call[0]));
}

function withStderrColorDepth<T>(colorDepth: number, callback: () => T): T {
  const stderr = Object.assign(Object.create(process.stderr), {
    getColorDepth: () => colorDepth,
    isTTY: true,
  }) as typeof process.stderr;
  const getStderr = vi.spyOn(process, "stderr", "get").mockReturnValue(stderr);
  vi.stubEnv("NO_COLOR", "");
  try {
    return callback();
  } finally {
    getStderr.mockRestore();
    vi.unstubAllEnvs();
  }
}

describe("onboard preflight severity messages (#6004)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("colors representative failure and warning messages when stderr supports color", () => {
    withStderrColorDepth(24, () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      printDockerNotReachableError();
      printLowMemoryWarning({ totalRamMB: 4000, totalSwapMB: 0, totalMB: 4000 });
      expect(lines(err)[0]).toBe(
        "  \x1b[31m✗ Docker is not reachable. Please fix Docker and try again.\x1b[39m",
      );
      expect(lines(warn)[0]).toBe(
        "  \x1b[33m⚠ Low memory detected (4000 MB RAM + 0 MB swap = 4000 MB total)\x1b[39m",
      );
    });
  });

  it("prints representative failure and warning messages without ANSI on plain stderr", () => {
    withStderrColorDepth(1, () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      printDockerNotReachableError();
      printLowMemoryWarning({ totalRamMB: 4000, totalSwapMB: 0, totalMB: 4000 });
      expect(lines(err)[0]).toBe("  ✗ Docker is not reachable. Please fix Docker and try again.");
      expect(lines(warn)[0]).toBe(
        "  ⚠ Low memory detected (4000 MB RAM + 0 MB swap = 4000 MB total)",
      );
      expect([...lines(err), ...lines(warn)].join("\n")).not.toContain("\x1b[");
    });
  });

  it("prints the unsupported-runtime failure to stderr with a ✗ marker", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    printUnsupportedRuntimeError();
    expect(err).toHaveBeenCalledTimes(3);
    expect(lines(err)[0]).toContain("✗");
    expect(lines(err)[0]).toContain("Docker driver");
    expect(lines(err).join("\n")).toContain("Switch to Docker Engine");
  });

  it("prints the under-provisioned warning to stderr with a ⚠ marker and colima resize", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    printUnderProvisionedRuntimeWarning({
      detectedStr: "2 vCPU / 2.0 GiB",
      runtime: "colima",
      recommendedCpus: 4,
      recommendedMemGib: 12,
    });
    expect(lines(warn)[0]).toContain("⚠");
    expect(lines(warn)[0]).toContain("under-provisioned: 2 vCPU / 2.0 GiB");
    expect(lines(warn).join("\n")).toContain("colima start --cpu 4 --memory 12");
  });

  it("prints the Docker Desktop resize hint for the docker-desktop runtime", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    printUnderProvisionedRuntimeWarning({
      detectedStr: "x",
      runtime: "docker-desktop",
      recommendedCpus: 4,
      recommendedMemGib: 12,
    });
    expect(lines(warn).join("\n")).toContain("Docker Desktop → Settings → Resources");
  });

  it("prints the swap-creation failure to stderr with a ⚠ marker", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    printSwapCreationFailed("mkswap failed");
    expect(lines(warn)[0]).toContain("⚠ Could not create swap: mkswap failed");
    expect(lines(warn).join("\n")).toContain("may fail with OOM");
  });

  it("prints a missing messaging provider to stderr with a ⚠ marker and fix hint", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    printMessagingProviderMissing("slack");
    expect(lines(warn)[0]).toContain("⚠ Messaging provider 'slack' was not found in the gateway.");
    expect(lines(warn).join("\n")).toContain("openshell provider create --name slack");
  });
});

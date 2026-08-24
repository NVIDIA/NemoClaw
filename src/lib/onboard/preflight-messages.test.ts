// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GpuDetection } from "../inference/nim";
import { setOnboardBrandingAgent } from "./branding";
import {
  printCdiSpecUnavailableError,
  printDockerNotReachableError,
  printGpuPreflightLines,
  printLowMemoryWarning,
  printMessagingProviderMissing,
  printSwapCreationFailed,
  printUnderProvisionedRuntimeWarning,
  printUnsupportedRuntimeError,
} from "./preflight-messages";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";

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
    setOnboardBrandingAgent(null);
    vi.unstubAllEnvs();
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
    // macOS reporters use Docker Desktop or Colima, not native Docker Engine (#7320).
    expect(lines(err).join("\n")).toContain("Docker Desktop");
    expect(lines(err).join("\n")).toContain("Colima");
  });

  it("preserves the CDI failure message through the shared presenter (#7411)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);

    printCdiSpecUnavailableError();

    expect(lines(err)[0]).toContain("✗ Docker is configured for CDI device injection");
    expect(lines(err)[0]).toContain("NVIDIA GPU CDI spec is missing or stale");
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

  it("routes missing messaging provider repair through profile-aware onboarding (#9875)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setOnboardBrandingAgent("hermes");
    vi.stubEnv("NEMOCLAW_INVOKED_AS", "nemohermes");
    printMessagingProviderMissing("slack");
    expect(lines(warn)[0]).toContain("⚠ Messaging provider 'slack' was not found in the gateway.");
    expect(lines(warn).join("\n")).toContain(
      "rerun nemohermes onboard with the required messaging credentials",
    );
  });
});

const sandboxGpuDisabled: SandboxGpuConfig = {
  mode: "auto",
  hostGpuDetected: false,
  hostGpuPlatform: null,
  sandboxGpuEnabled: false,
  sandboxGpuDevice: null,
  errors: [],
};

const nvidiaGpu: GpuDetection = {
  type: "nvidia",
  name: "NVIDIA GeForce RTX 4090",
  count: 1,
  totalMemoryMB: 24564,
  perGpuMB: 24564,
  nimCapable: true,
};

function collectLines(options: {
  gpu: GpuDetection | null;
  sandboxGpuConfig?: SandboxGpuConfig;
  gpuTrustGateRejection?: string;
}): string[] {
  const lines: string[] = [];
  printGpuPreflightLines({
    gpu: options.gpu,
    sandboxGpuConfig: options.sandboxGpuConfig ?? sandboxGpuDisabled,
    gpuTrustGateRejection: options.gpuTrustGateRejection,
    log: (message) => lines.push(message),
  });
  return lines;
}

describe("printGpuPreflightLines", () => {
  it("prints the detected NVIDIA GPU with the sandbox GPU state", () => {
    const lines = collectLines({
      gpu: nvidiaGpu,
      sandboxGpuConfig: {
        ...sandboxGpuDisabled,
        mode: "1",
        hostGpuDetected: true,
        sandboxGpuEnabled: true,
      },
    });
    expect(lines).toEqual([
      "  ✓ NVIDIA GPU detected (NVIDIA GeForce RTX 4090, 24564 MB)",
      "  ✓ Sandbox GPU: enabled (1)",
    ]);
  });

  it("marks local NIM unavailable when GPU VRAM is too small", () => {
    const lines = collectLines({ gpu: { ...nvidiaGpu, nimCapable: false } });
    expect(lines).toContain("  ⓘ Local NIM unavailable — GPU VRAM too small");
  });

  it("marks local NIM unavailable for an Apple GPU", () => {
    const lines = collectLines({
      gpu: {
        type: "apple",
        name: "Apple M3 Max",
        count: 1,
        totalMemoryMB: 65536,
        perGpuMB: 65536,
        cores: 40,
        nimCapable: false,
      },
    });
    expect(lines).toEqual([
      "  ✓ Apple GPU detected: Apple M3 Max (40 cores), 65536 MB unified memory",
      "  ⓘ Local NIM unavailable — requires NVIDIA GPU",
      "  ⓘ Sandbox GPU: disabled (no NVIDIA GPU detected)",
    ]);
  });

  it("prints the trust-gate rejection reason under the no-GPU line (#9000)", () => {
    const lines = collectLines({
      gpu: null,
      gpuTrustGateRejection:
        "/proc/driver/nvidia is absent and the bounded CUDA proof was not attempted",
    });
    expect(lines).toEqual([
      "  ⓘ Local NIM unavailable — no GPU detected",
      "    GPU detection rejected the nvidia-smi report: /proc/driver/nvidia is absent and the bounded CUDA proof was not attempted",
      "  ⓘ Sandbox GPU: disabled (no NVIDIA GPU detected)",
    ]);
  });

  it("keeps the bare no-GPU line when detection records no rejection reason", () => {
    const lines = collectLines({ gpu: null });
    expect(lines).toEqual([
      "  ⓘ Local NIM unavailable — no GPU detected",
      "  ⓘ Sandbox GPU: disabled (no NVIDIA GPU detected)",
    ]);
  });

  it("prints the configuration-disabled sandbox GPU state", () => {
    const lines = collectLines({
      gpu: null,
      sandboxGpuConfig: { ...sandboxGpuDisabled, mode: "0" },
    });
    expect(lines).toContain("  ✓ Sandbox GPU: disabled by configuration");
  });
});

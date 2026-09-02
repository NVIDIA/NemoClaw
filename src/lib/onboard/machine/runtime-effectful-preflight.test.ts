// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostAssessment } from "../preflight";
import type { SandboxGpuConfig } from "../sandbox-gpu-mode";
import type {
  RuntimeProviderBundle,
  RuntimeProviderGatewayHostRuntime,
} from "../runtime-provider/contract";
import { assertConfiguredRuntimeProviderHealthy } from "./runtime-effectful-preflight";

const host = { platform: "linux", isWsl: false } as HostAssessment;
const sandboxGpuConfig = {
  sandboxGpuEnabled: false,
  errors: [],
} as unknown as SandboxGpuConfig;

function gatewayRuntime(
  run: RuntimeProviderGatewayHostRuntime["network"]["run"],
  ensureProbeImageCached: RuntimeProviderGatewayHostRuntime["network"]["ensureProbeImageCached"],
): RuntimeProviderGatewayHostRuntime {
  return {
    providerId: "candidate",
    openShellDriver: "candidate",
    bindAddress: "127.0.0.1",
    grpcHost: "127.0.0.1",
    sshGatewayHost: "127.0.0.1",
    portCheckHost: "127.0.0.1",
    socketPath: null,
    requiredServerIpSans: [],
    sandboxHostAddress: null,
    usesHostGatewayRoute: false,
    resourceOwnership: { label: "managed-by", value: "test" },
    gatewayConfig: {
      sandboxNamespace: "scoped",
      hostGatewayIp: null,
      includeSupervisorBin: true,
      processOwnership: "scoped-namespace",
    },
    network: {
      sandboxSourceCidrs: vi.fn(() => ["172.18.0.0/16"]),
      inspect: vi.fn(),
      usesHostGatewayRoute: vi.fn(() => false),
      run,
      ensureProbeImageCached,
    },
  };
}

function providerBundle(
  inspectHost: RuntimeProviderBundle["preflightDoctor"]["inspectHost"],
  prepareHostRuntime: RuntimeProviderBundle["gateway"]["prepareHostRuntime"],
): RuntimeProviderBundle {
  return {
    identity: {
      contractVersion: 1,
      id: "candidate",
      displayName: "Candidate Runtime",
    },
    preflightDoctor: {
      providerId: "candidate",
      supported: true,
      inspectHost,
      validateSandboxGpu: vi.fn(),
      preflightLifecycle: vi.fn(() => null),
    },
    gateway: {
      providerId: "candidate",
      supported: true,
      launcher: "nemoclaw",
      inspectLegacyContainer: false,
      prepareHostRuntime,
    },
  } as unknown as RuntimeProviderBundle;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("configured runtime provider effectful preflight", () => {
  it("resolves one provider and runs doctor, bridge, and DNS through its gateway network", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const run = vi
      .fn<RuntimeProviderGatewayHostRuntime["network"]["run"]>()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({
        status: 1,
        stdout:
          "Server: 10.0.0.1\nAddress: 10.0.0.1:53\n** server can't find test.invalid: NXDOMAIN\n",
      });
    const ensureProbeImageCached = vi.fn(() => ({
      ok: true,
      alreadyCached: true,
    }));
    const runtime = gatewayRuntime(run, ensureProbeImageCached);
    const inspectHost = vi.fn(() => ({
      group: "Host" as const,
      label: "Candidate runtime",
      status: "ok" as const,
      detail: "ready",
    }));
    const prepareHostRuntime = vi.fn(() => runtime);
    const provider = providerBundle(inspectHost, prepareHostRuntime);
    const resolveProvider = vi.fn(() => provider);

    assertConfiguredRuntimeProviderHealthy(host, sandboxGpuConfig, false, process.exit, {
      environment: {},
      platform: "linux",
      architecture: "x64",
      isPortableProfile: () => false,
      resolveProvider,
    });

    expect(resolveProvider).toHaveBeenCalledOnce();
    expect(resolveProvider).toHaveBeenCalledWith("linux", "x64", {});
    expect(inspectHost).toHaveBeenCalledOnce();
    expect(provider.preflightDoctor.validateSandboxGpu).toHaveBeenCalledWith(
      sandboxGpuConfig,
      process.exit,
    );
    expect(prepareHostRuntime).toHaveBeenCalledOnce();
    expect(ensureProbeImageCached).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[0]).toEqual([
      "run",
      "--rm",
      "--pull=missing",
      "--network",
      "bridge",
      expect.stringContaining("busybox@sha256:"),
      "true",
    ]);
    expect(run.mock.calls[1]?.[0]).toEqual([
      "run",
      "--rm",
      "--pull=missing",
      "--network",
      "bridge",
      expect.stringContaining("busybox@sha256:"),
      "nslookup",
      expect.stringMatching(/^nemoclaw-dns-probe-[a-f0-9]+\.invalid$/u),
    ]);
  });

  it("preserves the portable profile Docker compatibility preflight", () => {
    const assertPortableRuntimeHealthy = vi.fn();
    const resolveProvider = vi.fn();

    assertConfiguredRuntimeProviderHealthy(host, sandboxGpuConfig, true, process.exit, {
      environment: {},
      isPortableProfile: () => true,
      assertPortableRuntimeHealthy,
      resolveProvider,
    });

    expect(assertPortableRuntimeHealthy).toHaveBeenCalledWith(host, true, process.exit);
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it("stops on provider doctor failure before preparing gateway networking", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitProcess = vi.fn((_code: number): never => {
      throw new Error("exit");
    });
    const prepareHostRuntime = vi.fn();
    const provider = providerBundle(
      () => ({
        group: "Host",
        label: "Candidate runtime",
        status: "fail",
        detail: "unavailable",
        hint: "start it",
      }),
      prepareHostRuntime,
    );

    expect(() =>
      assertConfiguredRuntimeProviderHealthy(host, sandboxGpuConfig, false, exitProcess, {
        environment: {},
        isPortableProfile: () => false,
        resolveProvider: () => provider,
      }),
    ).toThrow("exit");
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(prepareHostRuntime).not.toHaveBeenCalled();
  });
});

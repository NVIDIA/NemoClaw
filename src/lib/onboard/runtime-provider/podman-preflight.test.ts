// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { ContainerEngine } from "../../adapters/container-engine";
import {
  inspectPodmanHost,
  isPodmanVersionSupported,
  normalizePodmanInferenceAuthorityReceipt,
  normalizeQualifiedPodmanInferenceAuthorityReceipt,
  PodmanHostPreflightError,
  qualifyPodmanEndpointHost,
  qualifyPodmanHost,
  qualifyPodmanInferenceAuthority,
  revalidatePodmanInferenceAuthority,
} from "./podman-preflight";

const INFO = JSON.stringify({
  host: {
    arch: "amd64",
    os: "linux",
    cgroupVersion: "v2",
    idMappings: {
      uidmap: [
        { container_id: 0, host_id: 1000, size: 1 },
        { container_id: 1, host_id: 100000, size: 65536 },
      ],
      gidmap: [
        { container_id: 0, host_id: 1000, size: 1 },
        { container_id: 1, host_id: 100000, size: 65536 },
      ],
    },
    networkBackend: "netavark",
    security: { rootless: true },
    discoveredDevices: [
      { source: "cdi", id: "nvidia.com/gpu=all" },
      { source: "cdi", id: "nvidia.com/gpu=0" },
    ],
  },
});

function engine(
  overrides: Partial<ContainerEngine> & {
    readonly info?: string;
    readonly serverVersion?: string;
    readonly version?: string;
  } = {},
): ContainerEngine {
  const capture = vi.fn((args: readonly string[]) => {
    switch (args[0]) {
      case "info":
        return { status: 0, stdout: overrides.info ?? INFO, stderr: "" };
      case "version":
        return {
          status: 0,
          stdout: JSON.stringify({
            Client: { Version: overrides.version ?? "5.6.2" },
            Server: { Version: overrides.serverVersion ?? overrides.version ?? "5.6.2" },
          }),
          stderr: "",
        };
      default:
        return { status: 125, stdout: "", stderr: "unexpected command" };
    }
  });
  const captureHost = vi.fn((args: readonly string[]) => ({
    status: 0,
    stdout: args[0] === "--version" ? (overrides.version ?? "podman version 5.6.2\n") : "",
    stderr: "",
  }));
  return {
    operation: overrides.operation ?? "host-doctor",
    engineId: overrides.engineId ?? "podman",
    displayName: overrides.displayName ?? "Podman",
    authorityId: overrides.authorityId ?? "test:podman-socket",
    capture: overrides.capture ?? capture,
    captureHost: overrides.captureHost ?? captureHost,
  };
}

describe("Podman host preflight", () => {
  it.each([
    ["4.9.9", false],
    ["5.0.0", true],
    ["5.6.2", true],
    ["6.0.0-dev", true],
    ["unknown", false],
  ])("classifies Podman version %s", (version, expected) => {
    expect(isPodmanVersionSupported(version)).toBe(expected);
  });

  it("qualifies Linux amd64 rootless CPU lifecycle through the injected engine", () => {
    const runtime = engine();

    expect(qualifyPodmanHost(runtime, { platform: "linux", architecture: "x64" })).toEqual({
      providerId: "podman",
      clientVersion: "5.6.2",
      serverVersion: "5.6.2",
      rootless: true,
      cgroupVersion: "v2",
      os: "linux",
      architecture: "amd64",
      networkBackend: "netavark",
    });
    expect(runtime.capture).toHaveBeenCalledWith(["info", "--format", "json"], 15_000);
    expect(runtime.capture).toHaveBeenCalledWith(["version", "--format", "json"], 10_000);
    expect(runtime.captureHost).toHaveBeenCalledWith(["--version"], 10_000);
    expect(runtime.captureHost).toHaveBeenCalledTimes(1);
  });

  it("qualifies the exact socket-bound Hermes portable Podman lifecycle", () => {
    const runtime = engine({ operation: "sandbox-lifecycle", version: "5.7.0" });

    expect(
      qualifyPodmanEndpointHost(runtime, {
        expectedVersion: "5.7.0",
        expectedNetworkBackend: "netavark",
        platform: "linux",
        architecture: "x64",
      }),
    ).toEqual({
      providerId: "podman",
      clientVersion: "5.7.0",
      serverVersion: "5.7.0",
      rootless: true,
      cgroupVersion: "v2",
      os: "linux",
      architecture: "amd64",
      networkBackend: "netavark",
    });
    expect(runtime.captureHost).not.toHaveBeenCalled();
  });

  it.each([
    ["client mismatch", { version: "5.6.2", serverVersion: "5.7.0" }, "client version"],
    ["server mismatch", { version: "5.7.0", serverVersion: "5.6.2" }, "server version"],
  ])("rejects exact lifecycle endpoint $0", (_label, versions, message) => {
    expect(() =>
      qualifyPodmanEndpointHost(engine({ operation: "sandbox-lifecycle", ...versions }), {
        expectedVersion: "5.7.0",
        expectedNetworkBackend: "netavark",
        platform: "linux",
        architecture: "x64",
      }),
    ).toThrow(message);
  });

  it("keeps the CPU receipt server version canonical while preserving exact inference authority", () => {
    expect(
      qualifyPodmanHost(engine({ version: "6.0.0-dev" }), {
        platform: "linux",
        architecture: "x64",
      }),
    ).toMatchObject({ clientVersion: "6.0.0", serverVersion: "6.0.0" });

    expect(
      qualifyPodmanInferenceAuthority(
        engine({ operation: "host-local-inference", version: "6.0.0-dev" }),
      ),
    ).toMatchObject({ serverVersion: "6.0.0-dev" });
  });

  it("does not normalize malformed whitespace into inference authority", () => {
    expect(
      qualifyPodmanHost(engine({ version: "6.0.0", serverVersion: " 6.0.0 " }), {
        platform: "linux",
        architecture: "x64",
      }),
    ).toMatchObject({ serverVersion: "6.0.0" });

    expect(() =>
      qualifyPodmanInferenceAuthority(
        engine({
          operation: "host-local-inference",
          version: "6.0.0",
          serverVersion: " 6.0.0 ",
        }),
      ),
    ).toThrow("Podman server version is malformed");
  });

  it("accepts arm64 aliases reported by the Podman service", () => {
    const info = JSON.stringify({
      ...JSON.parse(INFO),
      host: { ...JSON.parse(INFO).host, arch: "aarch64" },
    });
    expect(
      qualifyPodmanHost(engine({ info }), { platform: "linux", architecture: "arm64" }),
    ).toMatchObject({ architecture: "arm64" });
  });

  it("rejects an API service architecture that differs from the host", () => {
    expect(() => qualifyPodmanHost(engine(), { platform: "linux", architecture: "arm64" })).toThrow(
      "does not match host 'arm64'",
    );
  });

  it("rejects an old API service even when the local client is supported", () => {
    expect(() =>
      qualifyPodmanHost(engine({ version: "5.6.2", serverVersion: "4.9.9" }), {
        platform: "linux",
        architecture: "x64",
      }),
    ).toThrow("required on the server");
  });

  it.each([
    {
      label: "rootful service",
      info: {
        ...JSON.parse(INFO),
        host: { ...JSON.parse(INFO).host, security: { rootless: false } },
      },
      message: "rootless Podman",
    },
    {
      label: "cgroups v1",
      info: { ...JSON.parse(INFO), host: { ...JSON.parse(INFO).host, cgroupVersion: "v1" } },
      message: "cgroups v2",
    },
    {
      label: "unsupported architecture",
      info: { ...JSON.parse(INFO), host: { ...JSON.parse(INFO).host, arch: "ppc64le" } },
      message: "amd64 or arm64",
    },
  ])("rejects $label", ({ info, message }) => {
    expect(() =>
      qualifyPodmanHost(engine({ info: JSON.stringify(info) }), {
        platform: "linux",
        architecture: "x64",
      }),
    ).toThrow(message);
  });

  it("rejects missing subordinate user mappings", () => {
    const info = JSON.stringify({
      ...JSON.parse(INFO),
      host: {
        ...JSON.parse(INFO).host,
        idMappings: {
          ...JSON.parse(INFO).host.idMappings,
          uidmap: [{ container_id: 0, host_id: 1000, size: 1 }],
        },
      },
    });
    expect(() =>
      qualifyPodmanHost(engine({ info }), {
        platform: "linux",
        architecture: "x64",
      }),
    ).toThrow("subordinate UID range for the API service user");
  });

  it("rejects malformed API-service ID mappings", () => {
    const info = JSON.stringify({
      ...JSON.parse(INFO),
      host: {
        ...JSON.parse(INFO).host,
        idMappings: {
          ...JSON.parse(INFO).host.idMappings,
          gidmap: [{ container_id: 0, host_id: 1000, size: "65536" }],
        },
      },
    });
    expect(() =>
      qualifyPodmanHost(engine({ info }), {
        platform: "linux",
        architecture: "x64",
      }),
    ).toThrow("Podman API returned malformed gidmap");
  });

  it("fails before commands for another engine scope or unsupported host platform", () => {
    const wrongScope = engine({ operation: "sandbox-lifecycle" });
    expect(() => qualifyPodmanHost(wrongScope, { platform: "linux", architecture: "x64" })).toThrow(
      PodmanHostPreflightError,
    );
    expect(wrongScope.capture).not.toHaveBeenCalled();
    expect(wrongScope.captureHost).not.toHaveBeenCalled();

    const unsupportedHost = engine();
    expect(() =>
      qualifyPodmanHost(unsupportedHost, { platform: "darwin", architecture: "arm64" }),
    ).toThrow("requires Linux amd64 or arm64");
    expect(unsupportedHost.capture).not.toHaveBeenCalled();
  });

  it("reports a bounded doctor failure without throwing", () => {
    const failed = engine({
      captureHost: vi.fn(() => ({ status: 1, stdout: "", stderr: "runtime unavailable" })),
    });

    expect(inspectPodmanHost(failed, { platform: "linux", architecture: "x64" })).toEqual({
      group: "Host",
      label: "Podman runtime",
      status: "fail",
      detail: "Podman preflight failed: client version inspection: runtime unavailable",
      hint: "start a rootless Podman 5 API service on Linux and retry",
    });
  });
});

describe("Podman host-local-inference authority", () => {
  it("binds the exact endpoint and authoritative NVIDIA CDI subset", () => {
    const runtime = engine({ operation: "host-local-inference", version: "6.0.0" });

    const receipt = qualifyPodmanInferenceAuthority(runtime);

    expect(receipt).toEqual({
      schemaVersion: 1,
      providerId: "podman",
      operation: "host-local-inference",
      engineId: "podman",
      authorityId: "test:podman-socket",
      serverVersion: "6.0.0",
      rootless: true,
      cgroupVersion: "v2",
      os: "linux",
      architecture: "amd64",
      cdiDevices: ["nvidia.com/gpu=0", "nvidia.com/gpu=all"],
      receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.cdiDevices)).toBe(true);
    expect(runtime.capture).toHaveBeenCalledWith(["version", "--format", "json"], 10_000);
    expect(runtime.capture).toHaveBeenCalledWith(["info", "--format", "json"], 15_000);
  });

  it("keeps Podman 5 support for CPU preflight but requires Podman 6 CDI authority", () => {
    expect(
      qualifyPodmanHost(engine({ version: "5.8.4", serverVersion: "5.8.4" }), {
        platform: "linux",
        architecture: "x64",
      }),
    ).toMatchObject({ serverVersion: "5.8.4" });

    const runtime = engine({
      operation: "host-local-inference",
      version: "5.8.4",
      serverVersion: "5.8.4",
    });
    expect(() => qualifyPodmanInferenceAuthority(runtime)).toThrow(
      "Podman 6.0.0 or newer is required on the server",
    );
    expect(runtime.capture).not.toHaveBeenCalledWith(["info", "--format", "json"], 15_000);
  });

  it("binds exact Portable Podman 5.7 to a fresh external CDI inventory (#9596)", () => {
    const runtime = engine({
      operation: "host-local-inference",
      version: "5.7.0",
      serverVersion: "5.7.0",
    });
    const cdiDevices = [
      "nvidia.com/gpu=GPU-12345678-1234-1234-1234-123456789abc",
      "nvidia.com/gpu=all",
    ];
    const captureCurrentCdiDevices = vi.fn(() => cdiDevices);
    const options = { expectedVersion: "5.7.0", captureCurrentCdiDevices };

    const receipt = qualifyPodmanInferenceAuthority(runtime, options);

    expect(receipt).toMatchObject({ serverVersion: "5.7.0", cdiDevices });
    expect(() => normalizePodmanInferenceAuthorityReceipt(receipt)).toThrow(
      "inference authority receipt is malformed",
    );
    expect(normalizeQualifiedPodmanInferenceAuthorityReceipt(receipt)).toMatchObject({
      serverVersion: "5.7.0",
    });
    expect(() => normalizeQualifiedPodmanInferenceAuthorityReceipt({ ...receipt })).toThrow(
      "inference authority receipt is malformed",
    );
    expect(revalidatePodmanInferenceAuthority(runtime, receipt, options)).toEqual(receipt);
    expect(captureCurrentCdiDevices).toHaveBeenCalledTimes(2);
  });

  it("rejects partial or changed Portable Podman 5.7 authority (#9596)", () => {
    const runtime = engine({
      operation: "host-local-inference",
      version: "5.7.0",
      serverVersion: "5.7.0",
    });
    expect(() => qualifyPodmanInferenceAuthority(runtime, { expectedVersion: "5.7.0" })).toThrow(
      "version and CDI inventory must be supplied together",
    );

    const captureCurrentCdiDevices = vi
      .fn<() => readonly string[]>()
      .mockReturnValueOnce(["nvidia.com/gpu=all"])
      .mockReturnValueOnce([
        "nvidia.com/gpu=GPU-12345678-1234-1234-1234-123456789abc",
        "nvidia.com/gpu=all",
      ]);
    const options = { expectedVersion: "5.7.0", captureCurrentCdiDevices };
    const receipt = qualifyPodmanInferenceAuthority(runtime, options);

    expect(() => revalidatePodmanInferenceAuthority(runtime, receipt, options)).toThrow(
      "server or NVIDIA CDI authority changed before local-inference mutation",
    );
  });

  it("revalidates current authority when it is the only Podman 6 option (#9596)", () => {
    const runtime = engine({
      operation: "host-local-inference",
      version: "6.0.1",
      serverVersion: "6.0.1",
    });
    const receipt = qualifyPodmanInferenceAuthority(runtime);
    const assertCurrentAuthority = vi.fn();

    expect(
      revalidatePodmanInferenceAuthority(runtime, receipt, { assertCurrentAuthority }),
    ).toEqual(receipt);
    expect(assertCurrentAuthority).toHaveBeenCalledTimes(2);
  });

  it("treats Podman's omitted lowercase host.discoveredDevices field as exact empty authority", () => {
    const nestedOnly = JSON.stringify({
      ...JSON.parse(INFO),
      host: {
        ...JSON.parse(INFO).host,
        discoveredDevices: undefined,
        unrelated: { cdi: { devices: ["nvidia.com/gpu=all"] } },
      },
    });
    expect(
      qualifyPodmanInferenceAuthority(
        engine({ operation: "host-local-inference", version: "6.0.0", info: nestedOnly }),
      ).cdiDevices,
    ).toEqual([]);

    const uppercaseOnly = JSON.stringify({ Host: JSON.parse(INFO).host });
    expect(() =>
      qualifyPodmanInferenceAuthority(
        engine({ operation: "host-local-inference", version: "6.0.0", info: uppercaseOnly }),
      ),
    ).toThrow("rootless Linux Podman service");
  });

  it("canonicalizes omitted and explicit empty discovered-device inventories identically", () => {
    const base = JSON.parse(INFO);
    const omitted = JSON.stringify({
      ...base,
      host: { ...base.host, discoveredDevices: undefined },
    });
    const empty = JSON.stringify({
      ...base,
      host: { ...base.host, discoveredDevices: [] },
    });

    const omittedReceipt = qualifyPodmanInferenceAuthority(
      engine({ operation: "host-local-inference", version: "6.0.0", info: omitted }),
    );
    const emptyReceipt = qualifyPodmanInferenceAuthority(
      engine({ operation: "host-local-inference", version: "6.0.0", info: empty }),
    );

    expect(omittedReceipt.cdiDevices).toEqual([]);
    expect(emptyReceipt).toEqual(omittedReceipt);
  });

  it("rejects drift from exact empty authority to a discovered NVIDIA CDI inventory", () => {
    const first = JSON.parse(INFO);
    delete first.host.discoveredDevices;
    const changed = JSON.parse(INFO);
    const version = {
      status: 0,
      stdout: JSON.stringify({ Server: { Version: "6.0.0" } }),
      stderr: "",
    };
    const capture = vi
      .fn<ContainerEngine["capture"]>()
      .mockReturnValueOnce(version)
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(first), stderr: "" })
      .mockReturnValueOnce(version)
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(changed), stderr: "" });
    const runtime = engine({ operation: "host-local-inference", capture });
    const receipt = qualifyPodmanInferenceAuthority(runtime);

    expect(receipt.cdiDevices).toEqual([]);
    expect(() => revalidatePodmanInferenceAuthority(runtime, receipt)).toThrow(
      "server or NVIDIA CDI authority changed before local-inference mutation",
    );
  });

  it("ignores well-formed unrelated devices after strict entry validation", () => {
    const info = JSON.stringify({
      ...JSON.parse(INFO),
      host: {
        ...JSON.parse(INFO).host,
        discoveredDevices: [
          { source: "cdi", id: "vendor.example/accelerator=0" },
          { source: "pci", id: "0000:01:00.0" },
          { source: "cdi", id: "nvidia.com/gpu=GPU-deadbeef" },
        ],
      },
    });

    expect(
      qualifyPodmanInferenceAuthority(
        engine({ operation: "host-local-inference", version: "6.0.0", info }),
      ).cdiDevices,
    ).toEqual(["nvidia.com/gpu=GPU-deadbeef"]);
  });

  it.each([
    {
      label: "extra record key",
      devices: [{ source: "cdi", id: "nvidia.com/gpu=all", name: "untrusted" }],
      message: "contain only source and id",
    },
    {
      label: "duplicate NVIDIA identity",
      devices: [
        { source: "cdi", id: "nvidia.com/gpu=all" },
        { source: "cdi", id: "nvidia.com/gpu=all" },
      ],
      message: "duplicate NVIDIA device",
    },
    {
      label: "non-CDI NVIDIA identity",
      devices: [{ source: "pci", id: "nvidia.com/gpu=all" }],
      message: "ambiguous non-CDI device source",
    },
    {
      label: "malformed unrelated CDI identity",
      devices: [{ source: "cdi", id: "vendor device" }],
      message: "malformed CDI identity",
    },
  ])("rejects $label in the authoritative Podman schema", ({ devices, message }) => {
    const info = JSON.stringify({
      ...JSON.parse(INFO),
      host: { ...JSON.parse(INFO).host, discoveredDevices: devices },
    });
    expect(() =>
      qualifyPodmanInferenceAuthority(
        engine({ operation: "host-local-inference", version: "6.0.0", info }),
      ),
    ).toThrow(message);
  });

  it("refreshes the exact inventory and rejects CDI drift before mutation", () => {
    const first = JSON.parse(INFO);
    const changed = {
      ...first,
      host: {
        ...first.host,
        discoveredDevices: [{ source: "cdi", id: "nvidia.com/gpu=1" }],
      },
    };
    const version = {
      status: 0,
      stdout: JSON.stringify({ Server: { Version: "6.0.0" } }),
      stderr: "",
    };
    const capture = vi
      .fn<ContainerEngine["capture"]>()
      .mockReturnValueOnce(version)
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(first), stderr: "" })
      .mockReturnValueOnce(version)
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(changed), stderr: "" });
    const runtime = engine({ operation: "host-local-inference", capture });
    const receipt = qualifyPodmanInferenceAuthority(runtime);

    expect(() => revalidatePodmanInferenceAuthority(runtime, receipt)).toThrow(
      "server or NVIDIA CDI authority changed before local-inference mutation",
    );
    expect(capture).toHaveBeenCalledTimes(4);
  });

  it("returns a fresh receipt when endpoint and CDI authority remain exact", () => {
    const runtime = engine({ operation: "host-local-inference", version: "6.0.0" });
    const receipt = qualifyPodmanInferenceAuthority(runtime);

    expect(revalidatePodmanInferenceAuthority(runtime, receipt)).toEqual(receipt);
    expect(runtime.capture).toHaveBeenCalledTimes(4);
  });

  it("rejects an in-place Podman server-version replacement", () => {
    const capture = vi
      .fn<ContainerEngine["capture"]>()
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ Server: { Version: "6.0.0" } }),
        stderr: "",
      })
      .mockReturnValueOnce({ status: 0, stdout: INFO, stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ Server: { Version: "6.1.0" } }),
        stderr: "",
      })
      .mockReturnValueOnce({ status: 0, stdout: INFO, stderr: "" });
    const runtime = engine({ operation: "host-local-inference", capture });
    const receipt = qualifyPodmanInferenceAuthority(runtime);

    expect(() => revalidatePodmanInferenceAuthority(runtime, receipt)).toThrow(
      "server or NVIDIA CDI authority changed before local-inference mutation",
    );
  });

  it("rejects endpoint drift before reading from the replacement endpoint", () => {
    const receipt = qualifyPodmanInferenceAuthority(
      engine({ operation: "host-local-inference", version: "6.0.0" }),
    );
    const replacement = engine({
      operation: "host-local-inference",
      authorityId: "test:replacement-socket",
      version: "6.0.0",
    });

    expect(() => revalidatePodmanInferenceAuthority(replacement, receipt)).toThrow(
      "endpoint authority changed before local-inference mutation",
    );
    expect(replacement.capture).not.toHaveBeenCalled();
  });

  it("rejects a receipt whose CDI inventory changed without a new digest", () => {
    const receipt = qualifyPodmanInferenceAuthority(
      engine({ operation: "host-local-inference", version: "6.0.0" }),
    );

    expect(() =>
      normalizePodmanInferenceAuthorityReceipt({
        ...receipt,
        cdiDevices: ["nvidia.com/gpu=1"],
      }),
    ).toThrow("receipt digest does not match");
  });
});

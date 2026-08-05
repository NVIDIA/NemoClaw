// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { ContainerEngine } from "../../adapters/container-engine";
import {
  inspectPodmanHost,
  isPodmanVersionSupported,
  PodmanHostPreflightError,
  qualifyPodmanHost,
} from "./podman-preflight";

const INFO = JSON.stringify({
  host: {
    arch: "amd64",
    os: "linux",
    cgroupVersion: "v2",
    networkBackend: "netavark",
    security: { rootless: true },
  },
});

function engine(
  overrides: Partial<ContainerEngine> & {
    readonly info?: string;
    readonly serverVersion?: string;
    readonly version?: string;
    readonly idMap?: string;
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
            Server: { Version: overrides.serverVersion ?? "5.6.2" },
          }),
          stderr: "",
        };
      default:
        return { status: 125, stdout: "", stderr: "unexpected command" };
    }
  });
  const captureHost = vi.fn((args: readonly string[]) => ({
    status: 0,
    stdout:
      args[0] === "--version"
        ? (overrides.version ?? "podman version 5.6.2\n")
        : (overrides.idMap ?? "0 1000 1\n1 100000 65536\n"),
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
    expect(runtime.captureHost).toHaveBeenCalledWith(
      ["unshare", "cat", "/proc/self/uid_map"],
      10_000,
    );
    expect(runtime.captureHost).toHaveBeenCalledWith(
      ["unshare", "cat", "/proc/self/gid_map"],
      10_000,
    );
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
    expect(() =>
      qualifyPodmanHost(engine({ idMap: "0 1000 1\n" }), {
        platform: "linux",
        architecture: "x64",
      }),
    ).toThrow("subordinate UID range");
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

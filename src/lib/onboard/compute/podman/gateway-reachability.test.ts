// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  buildPodmanGatewayProbeArgs,
  verifyPodmanSandboxGatewayReachableOrExit,
} from "./gateway-reachability";

const REQUIRED_OPTIONS = {
  port: 8080,
  redact: (value: string) => value,
} as const;

describe("Podman driver gateway reachability", () => {
  it("probes the selected native Podman socket and Podman host route", () => {
    expect(
      buildPodmanGatewayProbeArgs({
        networkName: "openshell",
        podmanSocketPath: "/run/user/1000/podman/podman.sock",
        port: 8080,
        probeImage: "probe@sha256:test",
        probeName: "probe-name",
        timeoutSeconds: 5,
      }),
    ).toEqual([
      "--url",
      "unix:///run/user/1000/podman/podman.sock",
      "run",
      "--rm",
      "--name",
      "probe-name",
      "--pull=missing",
      "--network",
      "openshell",
      "probe@sha256:test",
      "sh",
      "-c",
      "nc -zw5 host.containers.internal 8080",
    ]);
  });

  it("accepts a successful native Podman probe without Docker compatibility", async () => {
    const spawnSyncImpl = vi.fn((_command: string, _args: string[]) => ({ status: 0 }));
    await verifyPodmanSandboxGatewayReachableOrExit(false, {
      ...REQUIRED_OPTIONS,
      podmanSocketPath: "/run/user/1000/podman/podman.sock",
      probeName: "probe-name",
      spawnSyncImpl,
    });
    expect(spawnSyncImpl).toHaveBeenCalledOnce();
    expect(spawnSyncImpl.mock.calls[0]?.[0]).toBe("podman");
    expect(spawnSyncImpl.mock.calls[0]?.[1]).not.toContain("docker");
    expect(spawnSyncImpl.mock.calls[0]?.[1]).toContainEqual(
      expect.stringMatching(/^docker\.io\/library\/busybox@sha256:/),
    );
  });

  it("removes only its named probe and fails a proved TCP-path error", async () => {
    const spawnSyncImpl = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "nc: timed out" })
      .mockReturnValueOnce({ status: 0 });
    await expect(
      verifyPodmanSandboxGatewayReachableOrExit(false, {
        ...REQUIRED_OPTIONS,
        podmanSocketPath: "/run/user/1000/podman/podman.sock",
        probeName: "probe-name",
        spawnSyncImpl,
      }),
    ).rejects.toThrow("Podman sandbox containers cannot reach");
    expect(spawnSyncImpl.mock.calls[1]?.[1]).toEqual([
      "--url",
      "unix:///run/user/1000/podman/podman.sock",
      "rm",
      "--force",
      "probe-name",
    ]);
  });

  it("warns only when the pinned probe image cannot be established", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await verifyPodmanSandboxGatewayReachableOrExit(false, {
      ...REQUIRED_OPTIONS,
      podmanSocketPath: "/run/user/1000/podman/podman.sock",
      probeName: "probe-name",
      spawnSyncImpl: vi
        .fn()
        .mockReturnValueOnce({ status: 125, stderr: "pulling image: registry unavailable" })
        .mockReturnValueOnce({ status: 0 }),
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("probe helper was unavailable"));
    warn.mockRestore();
  });

  it("fails closed when the selected Podman network is missing", async () => {
    await expect(
      verifyPodmanSandboxGatewayReachableOrExit(false, {
        ...REQUIRED_OPTIONS,
        podmanSocketPath: "/run/user/1000/podman/podman.sock",
        probeName: "probe-name",
        spawnSyncImpl: vi
          .fn()
          .mockReturnValueOnce({ status: 125, stderr: "network openshell not found" })
          .mockReturnValueOnce({ status: 0 }),
      }),
    ).rejects.toThrow("Podman sandbox containers cannot reach");
  });
});

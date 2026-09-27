// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildDockerDriverGatewayRuntimeMarker } from "../../../src/lib/onboard/docker-driver-gateway-runtime-marker";
import { snapshotPodmanOwner } from "../fixtures/podman-owner-snapshot";

const input = {
  environment: { HOME: "/home/fixture", SECRET: "never-publish-environment" },
  platform: "linux" as const,
  architecture: "x64" as const,
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  expectedEndpoint: "https://169.254.2.2:8080",
  managedGatewayEndpoints: [],
  portAvailable: false,
  installedOpenShellVersion: "0.0.116",
  trustedGatewayBin: "/trusted/gateway",
  runtimeSocketPath: "/run/user/1000/podman/podman.sock",
};
const marker = buildDockerDriverGatewayRuntimeMarker({
  pid: 42,
  desiredEnv: {},
  endpoint: input.expectedEndpoint,
  gatewayBin: "/trusted/gateway",
  runtimeProviderId: "podman",
  platform: "linux",
  arch: "x64",
});
function capture(record: string | null, executable = "/trusted/gateway") {
  return snapshotPodmanOwner(input, 42, {
    uid: () => 1000,
    ownedFile: (file) => (file.endsWith("runtime.json") ? record : "42\n"),
    executable: () => executable,
    realPath: (file) => file,
  });
}
describe("bounded Podman owner snapshot", () => {
  it("records facts without publishing marker, paths, endpoint or environment", () => {
    const result = capture(JSON.stringify({ ...marker, desiredEnvHash: "never-publish-marker" }));
    expect(result).toMatchObject({
      markerParsed: true,
      markerIsPodman: true,
      markerMatchesListener: true,
      markerEndpointMatchesExpected: true,
      markerExecutableMatchesTrusted: true,
      runningExecutableMatchesTrusted: true,
    });
    expect(
      Object.values(result).every(
        (value) => typeof value === "boolean" || value === "podman-owner-snapshot-v1",
      ),
    ).toBe(true);
  });
  it.each([
    ["driver", { driver: "docker" }, "markerIsPodman"],
    ["platform", { platform: "darwin" }, "markerPlatformMatchesExpected"],
    ["architecture", { arch: "arm64" }, "markerArchitectureMatchesExpected"],
    ["endpoint", { endpoint: "https://other:8080" }, "markerEndpointMatchesExpected"],
    ["binary", { gatewayBin: "/other/gateway" }, "markerExecutableMatchesTrusted"],
  ] as const)("distinguishes %s mismatch without adopting the listener", (_label, patch, key) => {
    expect(capture(JSON.stringify({ ...marker, ...patch }))).toHaveProperty(key, false);
  });
  it.each([null, "not-json"])("records absent or malformed marker safely", (record) => {
    expect(capture(record)).toMatchObject({ markerParsed: false, markerIsPodman: false });
  });
  it("records an independently different running executable", () => {
    expect(capture(JSON.stringify(marker), "/other/process")).toHaveProperty(
      "runningExecutableMatchesTrusted",
      false,
    );
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { dockerCapture } from "../../adapters/docker/local-model-runtime";
import { resolveManagedVllmBridgeHost } from "./vllm-host-local-network";

function capture(value: string): typeof dockerCapture {
  return vi.fn(() => value) as unknown as typeof dockerCapture;
}

describe("managed host-local vLLM bridge", () => {
  it("resolves one private OpenShell bridge gateway (#8379)", () => {
    const run = capture(JSON.stringify([{ Subnet: "172.18.0.0/16", Gateway: "172.18.0.1" }]));
    const dockerEnv = { DOCKER_CONTEXT: "default", PATH: "/usr/bin" };
    expect(resolveManagedVllmBridgeHost(run, dockerEnv)).toBe("172.18.0.1");
    expect(run).toHaveBeenCalledWith(
      ["network", "inspect", "--format", "{{json .IPAM.Config}}", "openshell-docker"],
      { env: dockerEnv, ignoreError: true, timeout: 10_000 },
    );
  });

  it.each([
    ["invalid JSON", "not-json"],
    ["missing gateway", JSON.stringify([{ Subnet: "172.18.0.0/16" }])],
    ["public gateway", JSON.stringify([{ Gateway: "203.0.113.1" }])],
    ["zero gateway", JSON.stringify([{ Gateway: "0.0.0.0" }])],
    ["multiple gateways", JSON.stringify([{ Gateway: "172.18.0.1" }, { Gateway: "172.19.0.1" }])],
  ])("rejects %s", (_label, value) => {
    expect(() => resolveManagedVllmBridgeHost(capture(value))).toThrow(/OpenShell bridge|private/);
  });
});

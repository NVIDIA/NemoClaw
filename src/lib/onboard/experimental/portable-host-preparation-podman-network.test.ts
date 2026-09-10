// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";
import { portableHostPreparationInternals } from "./portable-host-preparation";
import { PORTABLE_DOCKER_NETWORK_NAME, PORTABLE_DOCKER_NETWORK_SUBNET } from "./portable-profile";

type SpawnResult = ReturnType<typeof spawnSync>;

function result(status = 0, stdout = "", stderr = ""): SpawnResult {
  return { status, stdout, stderr } as SpawnResult;
}

describe("portable Podman network inspection", () => {
  it("reuses the expected network through podman-docker's native inspect schema", () => {
    const docker = vi
      .fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>()
      .mockReturnValueOnce(
        result(125, "", "template: inspect: can't evaluate field IPAM in type interface {}"),
      )
      .mockReturnValueOnce(
        result(
          0,
          JSON.stringify([{ subnet: PORTABLE_DOCKER_NETWORK_SUBNET, gateway: "10.87.0.1" }]),
        ),
      );

    portableHostPreparationInternals.ensurePortableSandboxNetwork(
      {},
      docker,
      vi.fn(),
      "unix:///run/user/1001/podman/podman.sock",
      PORTABLE_DOCKER_NETWORK_NAME,
      vi.fn(),
    );

    expect(docker.mock.calls[1]?.[0]).toEqual([
      "network",
      "inspect",
      "--format",
      "{{json .Subnets}}",
      PORTABLE_DOCKER_NETWORK_NAME,
    ]);
    expect(docker.mock.calls.some(([args]) => args[1] === "create")).toBe(false);
  });
});

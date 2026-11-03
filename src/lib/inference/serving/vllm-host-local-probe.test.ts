// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { dockerCapture as captureDocker } from "../../adapters/docker/local-model-runtime";
import { getLegacyHostLocalManagedVllmBridgeHost } from "./vllm-host-local-lifecycle";

function ownedContainer() {
  return {
    Id: "a".repeat(64),
    Name: "/nemoclaw-vllm",
    State: { Running: true },
    Config: { Labels: { "com.nvidia.nemoclaw.managed-vllm": "true" } as Record<string, string> },
    NetworkSettings: {
      Ports: {
        "8000/tcp": [
          { HostIp: "127.0.0.1", HostPort: "18080" },
          { HostIp: "172.18.0.1", HostPort: "18080" },
        ],
      },
    },
  };
}

function dockerCapture(row: ReturnType<typeof ownedContainer>, gateway = "172.18.0.1") {
  return vi.fn<typeof captureDocker>((argv, _options) =>
    argv[0] === "container" ? JSON.stringify([row]) : JSON.stringify([{ Gateway: gateway }]),
  );
}

describe("bearerless managed vLLM container probe", () => {
  it("selects the published OpenShell bridge with the same Docker environment (#14083)", () => {
    const capture = dockerCapture(ownedContainer());
    expect(getLegacyHostLocalManagedVllmBridgeHost(18080, capture)).toBe("172.18.0.1");
    expect(capture.mock.calls[1]?.[0]).toEqual([
      "network",
      "inspect",
      "--format",
      "{{json .IPAM.Config}}",
      "openshell-docker",
    ]);
    expect(capture.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        env: capture.mock.calls[0]?.[1]?.env,
      }),
    );
  });

  it.each([
    [
      "foreign container",
      (row) => {
        row.Config.Labels = {};
      },
    ],
    [
      "different name",
      (row) => {
        row.Name = "/other-vllm";
      },
    ],
    [
      "stopped container",
      (row) => {
        row.State.Running = false;
      },
    ],
    [
      "authenticated container",
      (row) => {
        row.Config.Labels["com.nvidia.nemoclaw.managed-vllm-auth"] = "a".repeat(64);
      },
    ],
    [
      "distributed container",
      (row) => {
        row.Config.Labels["com.nvidia.nemoclaw.vllm-role"] = "head";
      },
    ],
    [
      "all-interface binding",
      (row) => {
        row.NetworkSettings.Ports["8000/tcp"][1]!.HostIp = "0.0.0.0";
      },
    ],
    [
      "different port",
      (row) => {
        row.NetworkSettings.Ports["8000/tcp"][1]!.HostPort = "19000";
      },
    ],
  ] satisfies Array<[string, (row: ReturnType<typeof ownedContainer>) => void]>)(
    "does not select the bridge for a %s",
    (_label, change) => {
      const row = ownedContainer();
      change(row);
      expect(getLegacyHostLocalManagedVllmBridgeHost(18080, dockerCapture(row))).toBeNull();
    },
  );

  it("rejects a public OpenShell gateway", () => {
    expect(
      getLegacyHostLocalManagedVllmBridgeHost(
        18080,
        dockerCapture(ownedContainer(), "203.0.113.1"),
      ),
    ).toBeNull();
  });

  it("preserves the legacy probe when Docker inspection is unavailable", () => {
    expect(
      getLegacyHostLocalManagedVllmBridgeHost(
        18080,
        vi.fn(() => ""),
      ),
    ).toBeNull();
  });
});

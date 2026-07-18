// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createDockerGpuDnsInspectFixture as inspectFixture } from "./__test-helpers__/docker-gpu-patch-fixtures";
import { buildDockerGpuCloneRunArgs } from "./docker-gpu-patch-clone";
import { buildDockerGpuMode } from "./docker-gpu-patch-mode";
import { recreateOpenShellDockerSandboxWithGpu } from "./docker-gpu-patch-recreate";

function recreateDeps(dns: string | null) {
  const dockerResponses: Record<string, string> = {
    ps: "old-container-id\n",
    inspect: JSON.stringify([inspectFixture()]),
  };
  const dockerCapture = vi.fn((args: readonly string[]) => {
    return dockerResponses[args[0] ?? ""] ?? "";
  });
  return {
    dockerCapture,
    dockerRun: vi.fn(() => ({ status: 0, stdout: "probe-id\n" })),
    dockerRunDetached: vi.fn(() => ({ status: 0, stdout: "new-container-id\n" })),
    dockerRename: vi.fn(() => ({ status: 0 })),
    dockerStop: vi.fn(() => ({ status: 0 })),
    dockerRm: vi.fn(() => ({ status: 0 })),
    runOpenshell: vi.fn(() => ({ status: 0 })),
    sleep: vi.fn(),
    now: () => new Date("2026-05-15T00:00:00Z"),
    detectSandboxFallbackDns: vi.fn(() => dns),
  };
}

describe("Docker GPU recreate DNS fallback (#3579)", () => {
  it("injects a discovered upstream only when Docker DNS is otherwise unavailable", () => {
    const inspect = inspectFixture();
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"), {
      sandboxFallbackDns: "8.8.8.8",
    });
    expect(args).toEqual(expect.arrayContaining(["--dns", "8.8.8.8"]));

    inspect.HostConfig = { ...inspect.HostConfig, Dns: ["10.43.0.10"] };
    const configured = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"), {
      sandboxFallbackDns: "8.8.8.8",
    });
    expect(configured).toEqual(expect.arrayContaining(["--dns", "10.43.0.10"]));
    expect(configured).not.toEqual(expect.arrayContaining(["--dns", "8.8.8.8"]));

    const host = buildDockerGpuCloneRunArgs(inspectFixture(), buildDockerGpuMode("gpus"), {
      networkMode: "host",
      sandboxFallbackDns: "8.8.8.8",
    });
    expect(host).not.toEqual(expect.arrayContaining(["--dns", "8.8.8.8"]));
  });

  it("plumbs the discovered upstream through recreate into clone args", () => {
    const deps = recreateDeps("9.9.9.9");
    recreateOpenShellDockerSandboxWithGpu({ sandboxName: "alpha", timeoutSecs: 1 }, deps);

    expect(deps.detectSandboxFallbackDns).toHaveBeenCalled();
    expect(deps.dockerRunDetached).toHaveBeenCalledWith(
      expect.arrayContaining(["--dns", "9.9.9.9"]),
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("does not add DNS through recreate when no upstream is discovered", () => {
    const deps = recreateDeps(null);
    recreateOpenShellDockerSandboxWithGpu({ sandboxName: "alpha", timeoutSecs: 1 }, deps);

    expect(deps.dockerRunDetached).not.toHaveBeenCalledWith(
      expect.arrayContaining(["--dns"]),
      expect.anything(),
    );
  });

  it("preserves the complete hostname regression contract", () => {
    const args = buildDockerGpuCloneRunArgs(inspectFixture(), buildDockerGpuMode("gpus"), {
      sandboxFallbackDns: "8.8.8.8",
    });
    expect(args).toEqual(
      expect.arrayContaining(["--add-host", "host.openshell.internal:172.17.0.1"]),
    );
    expect(args).not.toEqual(expect.arrayContaining(["--network", "host"]));
    expect(args).toEqual(expect.arrayContaining(["--dns", "8.8.8.8"]));
  });
});

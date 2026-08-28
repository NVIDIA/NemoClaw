// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createDockerGpuJetsonInspectFixture as inspectFixture } from "./__test-helpers__/docker-gpu-patch-fixtures";
import { detectTegraDeviceGroupGids } from "./docker-gpu-jetson-groups";
import {
  buildDockerGpuCloneRunArgs,
  buildDockerGpuMode,
  recreateOpenShellDockerSandboxWithGpu,
} from "./docker-gpu-patch";

function dockerCaptureFixture() {
  const responses: Record<string, string> = {
    ps: "old-container-id\n",
    inspect: JSON.stringify([inspectFixture()]),
    info: "",
  };
  return vi.fn((args: readonly string[]) => responses[args[0]] ?? "");
}

describe("Jetson device-node group propagation (#4231, #7610)", () => {
  it("emits --group-add for extraGroupGids and dedupes against existing GroupAdd", () => {
    const inspect = inspectFixture();
    inspect.HostConfig!.GroupAdd = ["44"];
    const args = buildDockerGpuCloneRunArgs(
      inspect,
      buildDockerGpuMode("nvidia-runtime", null, { backend: "jetson" }),
      { extraGroupGids: ["44", "110"] },
    );
    expect(
      args.filter((arg, index) => args[index - 1] === "--group-add" && arg === "44").length,
    ).toBe(1);
    expect(args).toEqual(expect.arrayContaining(["--group-add", "110"]));
  });

  it("does not add --group-add when extraGroupGids is absent", () => {
    const inspect = inspectFixture();
    inspect.HostConfig!.GroupAdd = [];
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"));
    expect(args).not.toEqual(expect.arrayContaining(["--group-add"]));
  });

  it("passes all detected Tegra device GIDs into the Jetson recreate as --group-add", () => {
    const dockerRunDetached = vi.fn(() => ({
      status: 0,
      stdout: "new-container-id\n",
    }));
    const detectTegraDeviceGroupGidsStub = vi.fn(() =>
      detectTegraDeviceGroupGids({
        statDeviceAccess: (path) =>
          ({
            "/dev/nvmap": { gid: 44, mode: 0o660 },
            "/dev/nvhost-gpu": { gid: 995, mode: 0o660 },
            "/dev/dri/renderD128": { gid: 104, mode: 0o660 },
          })[path] ?? null,
        listDevicePaths: () => ["/dev/nvmap", "/dev/nvhost-gpu", "/dev/dri/renderD128"],
      }),
    );

    recreateOpenShellDockerSandboxWithGpu(
      { sandboxName: "alpha", timeoutSecs: 1, backend: "jetson", waitForSupervisor: false },
      {
        dockerCapture: dockerCaptureFixture(),
        dockerRun: vi.fn(() => ({ status: 0, stdout: "probe-id\n" })),
        dockerRunDetached,
        dockerRename: vi.fn(() => ({ status: 0 })),
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        runOpenshell: vi.fn(() => ({ status: 0 })),
        sleep: vi.fn(),
        now: () => new Date("2026-05-15T00:00:00Z"),
        detectSandboxFallbackDns: () => null,
        detectTegraDeviceGroupGids: detectTegraDeviceGroupGidsStub,
      },
    );

    expect(detectTegraDeviceGroupGidsStub).toHaveBeenCalled();
    expect(dockerRunDetached).toHaveBeenCalledWith(
      expect.arrayContaining(["--group-add", "44", "--group-add", "104", "--group-add", "995"]),
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("does not add Tegra device GIDs for the generic (non-Jetson) backend", () => {
    const dockerRunDetached = vi.fn(() => ({
      status: 0,
      stdout: "new-container-id\n",
    }));
    const detectTegraDeviceGroupGidsStub = vi.fn(() => ["44"]);

    recreateOpenShellDockerSandboxWithGpu(
      { sandboxName: "alpha", timeoutSecs: 1, backend: "generic", waitForSupervisor: false },
      {
        dockerCapture: dockerCaptureFixture(),
        dockerRun: vi.fn(() => ({ status: 0, stdout: "probe-id\n" })),
        dockerRunDetached,
        dockerRename: vi.fn(() => ({ status: 0 })),
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        runOpenshell: vi.fn(() => ({ status: 0 })),
        sleep: vi.fn(),
        now: () => new Date("2026-05-15T00:00:00Z"),
        detectSandboxFallbackDns: () => null,
        detectTegraDeviceGroupGids: detectTegraDeviceGroupGidsStub,
      },
    );

    expect(detectTegraDeviceGroupGidsStub).not.toHaveBeenCalled();
    expect(dockerRunDetached).not.toHaveBeenCalledWith(
      expect.arrayContaining(["--group-add", "44"]),
      expect.anything(),
    );
  });
});

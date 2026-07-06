// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  buildDockerGpuCloneRunArgs,
  buildDockerGpuMode,
  type DockerContainerInspect,
  detectTegraDeviceGroupGids,
  recreateOpenShellDockerSandboxWithGpu,
} from "./docker-gpu-patch";

function inspectFixture(): DockerContainerInspect {
  return {
    Id: "old-container-id",
    Name: "/openshell-alpha",
    Config: {
      Image: "openshell/sandbox:abc",
      Env: ["OPENSHELL_ENDPOINT=http://host.openshell.internal:8080/"],
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": "alpha",
      },
      Entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
      Cmd: [],
    },
    HostConfig: { NetworkMode: "openshell-docker" },
  };
}

function dockerCaptureFixture() {
  const responses: Record<string, string> = {
    ps: "old-container-id\n",
    inspect: JSON.stringify([inspectFixture()]),
    info: "",
  };
  return vi.fn((args: readonly string[]) => responses[args[0]] ?? "");
}

describe("Jetson /dev/nvmap group propagation (#4231)", () => {
  it("returns the owning GID(s) of present Tegra device nodes, skipping missing and root-owned", () => {
    const deviceGids: Record<string, number> = {
      "/dev/nvmap": 44,
      "/dev/nvhost-ctrl": 44,
      "/dev/nvhost-gpu": 0,
      "/dev/nvgpu/igpu0/ctrl": 110,
    };
    const gids = detectTegraDeviceGroupGids({
      statDeviceGid: (path: string) => (path in deviceGids ? deviceGids[path] : null),
    });
    expect(gids).toEqual(["44", "110"]);
  });

  it("returns no GIDs when no Tegra device nodes are present (non-Jetson host)", () => {
    expect(detectTegraDeviceGroupGids({ statDeviceGid: () => null })).toEqual([]);
  });

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

  it("plumbs detected Tegra device GIDs into the Jetson recreate as --group-add", () => {
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));
    const detectTegraDeviceGroupGidsStub = vi.fn(() => ["44"]);

    recreateOpenShellDockerSandboxWithGpu(
      { sandboxName: "alpha", timeoutSecs: 1, backend: "jetson" },
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
      expect.arrayContaining(["--group-add", "44"]),
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("does not add Tegra device GIDs for the generic (non-Jetson) backend", () => {
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));
    const detectTegraDeviceGroupGidsStub = vi.fn(() => ["44"]);

    recreateOpenShellDockerSandboxWithGpu(
      { sandboxName: "alpha", timeoutSecs: 1, backend: "generic" },
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

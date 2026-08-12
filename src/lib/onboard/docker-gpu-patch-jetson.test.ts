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

  it("runs the fixed OpenShell supervisor through the Jetson group helper (#7610)", () => {
    const args = buildDockerGpuCloneRunArgs(
      inspectFixture(),
      buildDockerGpuMode("nvidia-runtime", null, { backend: "jetson" }),
      { extraGroupGids: ["44"], preserveJetsonDeviceGroupMembership: true },
    );

    expect(args).toEqual(
      expect.arrayContaining([
        "--entrypoint",
        "/usr/local/lib/nemoclaw/jetson-device-group-bootstrap.sh",
      ]),
    );
    expect(args.slice(args.indexOf("openshell/sandbox:abc"))).toEqual([
      "openshell/sandbox:abc",
      "--device-group-gids",
      "44",
      "--",
      "/opt/openshell/bin/openshell-sandbox",
    ]);
  });

  it("rejects invalid, duplicate, or excessive supplementary groups (#7610)", () => {
    const build = (extraGroupGids: readonly string[]) =>
      buildDockerGpuCloneRunArgs(
        inspectFixture(),
        buildDockerGpuMode("nvidia-runtime", null, { backend: "jetson" }),
        { extraGroupGids, preserveJetsonDeviceGroupMembership: true },
      );

    for (const gids of [
      ["0"],
      ["2147483648"],
      ["44", "44"],
      Array.from({ length: 17 }, (_, index) => String(index + 1)),
    ]) {
      expect(() => build(gids)).toThrow(
        "Docker clone received invalid or excessive supplementary group IDs.",
      );
    }
  });

  it("rejects group preservation outside the fixed supervisor boundary (#7610)", () => {
    const inspect = inspectFixture();
    inspect.Config!.Entrypoint = ["/custom/entrypoint"];

    expect(() =>
      buildDockerGpuCloneRunArgs(
        inspect,
        buildDockerGpuMode("nvidia-runtime", null, { backend: "jetson" }),
        { extraGroupGids: ["44"], preserveJetsonDeviceGroupMembership: true },
      ),
    ).toThrow("Jetson device-group bootstrap requires the OpenShell supervisor entrypoint.");
  });

  it("passes all detected Tegra device GIDs into the Jetson recreate as --group-add", () => {
    const dockerRunDetached = vi.fn((_args: readonly string[]) => ({
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
      {
        sandboxName: "alpha",
        timeoutSecs: 1,
        backend: "jetson",
        preserveJetsonDeviceGroupMembership: true,
      },
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
    const createArgs = dockerRunDetached.mock.calls[0]?.[0] ?? [];
    expect(createArgs).toEqual(
      expect.arrayContaining([
        "--entrypoint",
        "/usr/local/lib/nemoclaw/jetson-device-group-bootstrap.sh",
      ]),
    );
    expect(createArgs.slice(createArgs.indexOf("openshell/sandbox:abc"))).toEqual([
      "openshell/sandbox:abc",
      "--device-group-gids",
      "44,104,995",
      "--",
      "/opt/openshell/bin/openshell-sandbox",
    ]);
  });

  it("does not add Tegra device GIDs for the generic (non-Jetson) backend", () => {
    const dockerRunDetached = vi.fn(() => ({
      status: 0,
      stdout: "new-container-id\n",
    }));
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

  it("keeps the original container running when the helper is missing (#7610)", () => {
    const dockerStop = vi.fn(() => ({ status: 0 }));

    expect(() =>
      recreateOpenShellDockerSandboxWithGpu(
        {
          sandboxName: "alpha",
          timeoutSecs: 1,
          backend: "jetson",
          preserveJetsonDeviceGroupMembership: true,
        },
        {
          dockerCapture: dockerCaptureFixture(),
          dockerRun: vi.fn((args: readonly string[]) => ({
            status: args[0] === "exec" ? 1 : 0,
          })),
          dockerRunDetached: vi.fn(() => ({ status: 0, stdout: "new-container-id\n" })),
          dockerRename: vi.fn(() => ({ status: 0 })),
          dockerStop,
          dockerRm: vi.fn(() => ({ status: 0 })),
          runOpenshell: vi.fn(() => ({ status: 0 })),
          sleep: vi.fn(),
          now: () => new Date("2026-05-15T00:00:00Z"),
          detectSandboxFallbackDns: () => null,
          detectTegraDeviceGroupGids: () => ["44"],
        },
      ),
    ).toThrow("OpenClaw sandbox image is missing executable");
    expect(dockerStop).not.toHaveBeenCalled();
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildDockerGpuCloneRunArgs,
  buildDockerGpuMode,
  buildDockerGpuModeCandidates,
  dockerReportsNvidiaCdiDevices,
  recreateOpenShellDockerSandboxWithGpu,
  selectDockerGpuPatchMode,
  shouldApplyDockerGpuPatch,
  type DockerContainerInspect,
} from "../../../dist/lib/onboard/docker-gpu-patch";

function inspectFixture(): DockerContainerInspect {
  return {
    Id: "old-container-id",
    Name: "/openshell-alpha",
    Config: {
      Image: "openshell/sandbox:abc",
      Env: ["A=1", "OPENSHELL_TEST=1", "NVIDIA_VISIBLE_DEVICES=void"],
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": "alpha",
        "openshell.ai/sandbox-id": "sandbox-id",
      },
      Entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
      Cmd: [],
      User: "0",
      WorkingDir: "/workspace",
      Hostname: "alpha-host",
      Tty: true,
    },
    HostConfig: {
      Binds: ["/host:/container:rw"],
      NetworkMode: "openshell-docker",
      RestartPolicy: { Name: "unless-stopped" },
      CapAdd: ["SYS_ADMIN", "NET_ADMIN"],
      SecurityOpt: ["apparmor=unconfined"],
      ExtraHosts: ["host.openshell.internal:172.17.0.1"],
      Memory: 8 * 1024 * 1024 * 1024,
      NanoCpus: 2_500_000_000,
    },
  };
}

describe("docker-gpu-patch", () => {
  it("detects only the Linux Docker-driver GPU path and honors the opt-out", () => {
    expect(
      shouldApplyDockerGpuPatch(
        { sandboxGpuEnabled: true },
        { env: {}, platform: "linux", dockerDriverGateway: true },
      ),
    ).toBe(true);
    expect(
      shouldApplyDockerGpuPatch(
        { sandboxGpuEnabled: true },
        { env: { NEMOCLAW_DOCKER_GPU_PATCH: "0" }, platform: "linux", dockerDriverGateway: true },
      ),
    ).toBe(false);
    expect(
      shouldApplyDockerGpuPatch(
        { sandboxGpuEnabled: true },
        { env: {}, platform: "darwin", dockerDriverGateway: true },
      ),
    ).toBe(false);
    expect(
      shouldApplyDockerGpuPatch(
        { sandboxGpuEnabled: false },
        { env: {}, platform: "linux", dockerDriverGateway: true },
      ),
    ).toBe(false);
  });

  it("builds clone args that preserve OpenShell labels and runtime settings", () => {
    const args = buildDockerGpuCloneRunArgs(inspectFixture(), buildDockerGpuMode("gpus"));

    expect(args).toEqual(
      expect.arrayContaining([
        "--name",
        "openshell-alpha",
        "--gpus",
        "all",
        "--env",
        "A=1",
        "--env",
        "OPENSHELL_TEST=1",
        "--label",
        "openshell.ai/managed-by=openshell",
        "--label",
        "openshell.ai/sandbox-name=alpha",
        "--volume",
        "/host:/container:rw",
        "--network",
        "openshell-docker",
        "--restart",
        "unless-stopped",
        "--cap-add",
        "SYS_ADMIN",
        "--security-opt",
        "apparmor=unconfined",
        "--add-host",
        "host.openshell.internal:172.17.0.1",
        "--memory",
        String(8 * 1024 * 1024 * 1024),
        "--cpus",
        "2.5",
        "--entrypoint",
        "/opt/openshell/bin/openshell-sandbox",
        "openshell/sandbox:abc",
      ]),
    );
    expect(args).not.toEqual(expect.arrayContaining(["--env", "NVIDIA_VISIBLE_DEVICES=void"]));
  });

  it("maps default and explicit GPU devices to Docker --gpus values", () => {
    expect(buildDockerGpuMode("gpus").args).toEqual(["--gpus", "all"]);
    expect(buildDockerGpuMode("gpus", "nvidia.com/gpu=0").args).toEqual([
      "--gpus",
      "device=0",
    ]);
    expect(buildDockerGpuMode("gpus", "1,2").args).toEqual(["--gpus", "device=1,2"]);
  });

  it("falls back to NVIDIA runtime when Docker rejects --gpus", () => {
    const dockerRun = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "could not select device driver" })
      .mockReturnValueOnce({ status: 0, stdout: "probe-id" });

    const selected = selectDockerGpuPatchMode(
      { image: "openshell/sandbox:abc" },
      {
        dockerCapture: vi.fn(() => ""),
        dockerRun,
        dockerRm: vi.fn(() => ({ status: 0 })),
      },
    );

    expect(selected.mode?.kind).toBe("nvidia-runtime");
    expect(selected.attempts.map((attempt) => attempt.mode.kind)).toEqual([
      "gpus",
      "nvidia-runtime",
    ]);
  });

  it("tries CDI only when Docker reports readable NVIDIA CDI specs", () => {
    expect(buildDockerGpuModeCandidates("all", { cdiAvailable: false }).map((m) => m.kind)).toEqual(
      ["gpus", "nvidia-runtime"],
    );
    expect(buildDockerGpuModeCandidates("all", { cdiAvailable: true }).map((m) => m.kind)).toEqual(
      ["gpus", "nvidia-runtime", "cdi"],
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-cdi-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "nvidia.yaml"),
        "cdiVersion: 0.6.0\nkind: nvidia.com/gpu\ndevices:\n  - name: all\n",
      );
      expect(
        dockerReportsNvidiaCdiDevices({
          dockerCapture: vi.fn(() => JSON.stringify([tmpDir])),
        }),
      ).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("recreates the OpenShell-managed container and waits for supervisor exec", () => {
    const dockerCapture = vi.fn((args: readonly string[]) => {
      if (args[0] === "ps") return "old-container-id\n";
      if (args[0] === "inspect") return JSON.stringify([inspectFixture()]);
      if (args[0] === "info") return "";
      return "";
    });
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "probe-id\n" }));
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));
    const dockerRename = vi.fn(() => ({ status: 0 }));
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn(() => ({ status: 0 }));
    const runOpenshell = vi.fn(() => ({ status: 0 }));

    const result = recreateOpenShellDockerSandboxWithGpu(
      { sandboxName: "alpha", timeoutSecs: 1 },
      {
        dockerCapture,
        dockerRun,
        dockerRunDetached,
        dockerRename,
        dockerStop,
        dockerRm,
        runOpenshell,
        sleep: vi.fn(),
        now: () => new Date("2026-05-12T00:00:00Z"),
      },
    );

    expect(result.newContainerId).toBe("new-container-id");
    expect(result.mode.kind).toBe("gpus");
    expect(dockerRunDetached).toHaveBeenCalledWith(
      expect.arrayContaining(["--name", "openshell-alpha", "--gpus", "all"]),
      expect.objectContaining({ ignoreError: true }),
    );
    expect(runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "exec", "-n", "alpha", "--", "true"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("can recreate during sandbox create before supervisor exec is allowed", () => {
    const dockerCapture = vi.fn((args: readonly string[]) => {
      if (args[0] === "ps") return "old-container-id\n";
      if (args[0] === "inspect") return JSON.stringify([inspectFixture()]);
      if (args[0] === "info") return "";
      return "";
    });
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "phase: Provisioning" }));

    const result = recreateOpenShellDockerSandboxWithGpu(
      { sandboxName: "alpha", timeoutSecs: 1, waitForSupervisor: false },
      {
        dockerCapture,
        dockerRun: vi.fn(() => ({ status: 0, stdout: "probe-id\n" })),
        dockerRunDetached: vi.fn(() => ({ status: 0, stdout: "new-container-id\n" })),
        dockerRename: vi.fn(() => ({ status: 0 })),
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        runOpenshell,
        sleep: vi.fn(),
        now: () => new Date("2026-05-12T00:00:00Z"),
      },
    );

    expect(result.newContainerId).toBe("new-container-id");
    expect(runOpenshell).not.toHaveBeenCalled();
  });
});

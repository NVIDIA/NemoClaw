// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildDockerGpuCloneRunArgs,
  buildDockerGpuCloneRunOptions,
  buildDockerGpuMode,
  buildDockerGpuModeCandidates,
  collectDockerGpuPatchDiagnostics,
  dockerReportsNvidiaCdiDevices,
  formatDockerInspectNetworkSummary,
  getDockerGpuPatchNetworkMode,
  getDockerGpuSupervisorReconnectTimeoutSecs,
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
      Env: [
        "A=1",
        "OPENSHELL_ENDPOINT=http://host.openshell.internal:8080/",
        "OPENSHELL_TEST=1",
        "NVIDIA_VISIBLE_DEVICES=void",
      ],
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
    NetworkSettings: {
      Networks: {
        "openshell-docker": {
          IPAddress: "172.18.0.2",
          Gateway: "172.18.0.1",
          Aliases: ["openshell-alpha"],
        },
      },
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
        "OPENSHELL_ENDPOINT=http://host.openshell.internal:8080/",
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
        "--network-alias",
        "openshell-alpha",
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

  it("formats sanitized network diagnostics without dumping provider secrets", () => {
    const inspect = inspectFixture();
    inspect.Config?.Env?.push("NVIDIA_API_KEY=secret");

    const summary = formatDockerInspectNetworkSummary("old-container-id", inspect);

    expect(summary).toContain("target=old-container-id");
    expect(summary).toContain("network_mode=openshell-docker");
    expect(summary).toContain("host.openshell.internal:172.17.0.1");
    expect(summary).toContain("env.OPENSHELL_ENDPOINT=http://host.openshell.internal:8080/");
    expect(summary).toContain("openshell-docker: ip=172.18.0.2 gateway=172.18.0.1");
    expect(summary).not.toContain("NVIDIA_API_KEY");
    expect(summary).not.toContain("secret");
  });

  it("can switch the recreated sandbox to host networking for OpenShell callbacks", () => {
    const inspect = inspectFixture();
    const options = buildDockerGpuCloneRunOptions(inspect, {
      NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "host",
    });
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"), options);

    expect(options).toEqual({
      networkMode: "host",
      openshellEndpoint: "http://127.0.0.1:8080/",
    });
    expect(args).toEqual(expect.arrayContaining(["--network", "host"]));
    expect(args).toEqual(
      expect.arrayContaining(["--env", "OPENSHELL_ENDPOINT=http://127.0.0.1:8080/"]),
    );
    expect(args).not.toEqual(
      expect.arrayContaining(["--add-host", "host.openshell.internal:172.17.0.1"]),
    );
    expect(args).not.toEqual(expect.arrayContaining(["--network-alias", "openshell-alpha"]));
    expect(
      buildDockerGpuCloneRunOptions(inspect, {
        NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "preserve",
      }),
    ).toEqual({});
  });

  it("reports the Docker GPU patch network mode", () => {
    expect(getDockerGpuPatchNetworkMode({})).toBe("host");
    expect(getDockerGpuPatchNetworkMode({ NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "host" })).toBe(
      "host",
    );
    expect(getDockerGpuPatchNetworkMode({ NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "preserve" })).toBe(
      "preserve",
    );
    expect(getDockerGpuPatchNetworkMode({ NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "bridge" })).toBe(
      "preserve",
    );
    expect(getDockerGpuPatchNetworkMode({ NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "bogus" })).toBe(
      "preserve",
    );
  });

  it("maps default and explicit GPU devices to Docker --gpus values", () => {
    expect(buildDockerGpuMode("gpus").args).toEqual(["--gpus", "all"]);
    expect(buildDockerGpuMode("gpus", "nvidia.com/gpu=0").args).toEqual([
      "--gpus",
      "device=0",
    ]);
    expect(buildDockerGpuMode("gpus", "1,2").args).toEqual(["--gpus", "device=1,2"]);
  });

  it("uses a Docker-GPU-specific supervisor reconnect wait with an override", () => {
    expect(getDockerGpuSupervisorReconnectTimeoutSecs(180, {})).toBe(900);
    expect(getDockerGpuSupervisorReconnectTimeoutSecs(600, {})).toBe(900);
    expect(getDockerGpuSupervisorReconnectTimeoutSecs(1200, {})).toBe(1200);
    expect(
      getDockerGpuSupervisorReconnectTimeoutSecs(180, {
        NEMOCLAW_DOCKER_GPU_SUPERVISOR_RECONNECT_TIMEOUT: "30",
      }),
    ).toBe(30);
  });

  it("keeps Docker network diagnostics when old patch containers are gone", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-gpu-diag-"));
    try {
      const liveInspect = inspectFixture();
      liveInspect.Id = "new-container-id";
      const dockerCapture = vi.fn((args: readonly string[]) => {
        if (args[0] === "ps") return "new-container-id\n";
        if (args[0] === "inspect" && args[1] === "new-container-id") {
          return JSON.stringify([liveInspect]);
        }
        throw new Error(`missing target ${String(args[1])}`);
      });

      const diagnostics = collectDockerGpuPatchDiagnostics(
        "alpha",
        {
          context: {
            sandboxName: "alpha",
            oldContainerId: "old-container-id",
            newContainerId: "new-container-id",
            backupContainerName: "backup-container",
          },
        },
        {
          dockerCapture,
          dockerLogs: vi.fn(() => ""),
          homedir: () => tmpDir,
          now: () => new Date("2026-05-12T00:00:00Z"),
        },
      );

      expect(diagnostics?.dir).toBeTruthy();
      const summary = fs.readFileSync(
        path.join(diagnostics?.dir || "", "docker-network-summary.txt"),
        "utf-8",
      );
      expect(summary).toContain("target=new-container-id");
      expect(summary).toContain("network_mode=openshell-docker");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
      expect.arrayContaining([
        "--name",
        "openshell-alpha",
        "--gpus",
        "all",
        "--network",
        "host",
        "--env",
        "OPENSHELL_ENDPOINT=http://127.0.0.1:8080/",
      ]),
      expect.objectContaining({ ignoreError: true }),
    );
    expect(runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "exec", "-n", "alpha", "--", "true"],
      expect.objectContaining({ ignoreError: true }),
    );
    const dockerRmCalls = dockerRm.mock.calls as unknown[][];
    const backupRmCall = dockerRmCalls.findIndex((call) =>
      String(call[0]).includes("nemoclaw-gpu-backup"),
    );
    expect(backupRmCall).toBeGreaterThanOrEqual(0);
    expect(dockerRm.mock.invocationCallOrder[backupRmCall]).toBeLessThan(
      runOpenshell.mock.invocationCallOrder[0],
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

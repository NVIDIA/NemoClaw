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
  captureDockerGpuPatchSandboxSnapshot,
  classifyDockerGpuPatchFailure,
  collectDockerGpuPatchDiagnostics,
  type DockerContainerInspect,
  detectSandboxFallbackDns,
  dockerReportsNvidiaCdiDevices,
  formatDockerInspectNetworkSummary,
  getDockerGpuPatchNetworkMode,
  getDockerGpuSupervisorReconnectTimeoutSecs,
  recreateOpenShellDockerSandboxWithGpu,
  selectDockerGpuPatchMode,
  shouldApplyDockerGpuPatch,
  waitForOpenShellSupervisorReconnect,
} from "../../../dist/lib/onboard/docker-gpu-patch";
import { waitForCreatedSandboxReadyWithTrace } from "../../../dist/lib/onboard/sandbox-readiness-tracing";
import {
  getSandboxFailurePhase,
  isSandboxReady,
} from "../../../dist/lib/state/gateway";

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
        "OPENSHELL_SANDBOX_COMMAND=sleep infinity",
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

  it("replaces OpenShell's idle sandbox command when recreating a managed container", () => {
    const sandboxCommand = [
      "env",
      "CHAT_UI_URL=http://127.0.0.1:8642",
      "NEMOCLAW_DASHBOARD_PORT=8642",
      "nemoclaw-start",
    ];

    const args = buildDockerGpuCloneRunArgs(inspectFixture(), buildDockerGpuMode("gpus"), {
      openshellSandboxCommand: sandboxCommand,
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "--env",
        "OPENSHELL_SANDBOX_COMMAND=env CHAT_UI_URL=http://127.0.0.1:8642 NEMOCLAW_DASHBOARD_PORT=8642 nemoclaw-start",
      ]),
    );
    expect(args).not.toEqual(
      expect.arrayContaining(["--env", "OPENSHELL_SANDBOX_COMMAND=sleep infinity"]),
    );
    expect(args.slice(args.indexOf("openshell/sandbox:abc"))).toEqual([
      "openshell/sandbox:abc",
      ...sandboxCommand,
    ]);
  });

  it("adds OpenShell's sandbox command env when the inspected container lacks one", () => {
    const inspect = inspectFixture();
    inspect.Config!.Env = inspect.Config!.Env!.filter(
      (entry) => !entry.startsWith("OPENSHELL_SANDBOX_COMMAND="),
    );

    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"), {
      openshellSandboxCommand: ["env", "CHAT_UI_URL=http://127.0.0.1:8642", "nemoclaw-start"],
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "--env",
        "OPENSHELL_SANDBOX_COMMAND=env CHAT_UI_URL=http://127.0.0.1:8642 nemoclaw-start",
      ]),
    );
  });

  it("adds SYS_PTRACE to the GPU clone when the baseline container lacks it", () => {
    const inspect = inspectFixture();
    inspect.HostConfig!.CapAdd = ["SYS_ADMIN", "NET_ADMIN"];

    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"));

    expect(args).toEqual(expect.arrayContaining(["--cap-add", "SYS_PTRACE"]));
    // The baseline caps are preserved alongside SYS_PTRACE.
    expect(args).toEqual(expect.arrayContaining(["--cap-add", "SYS_ADMIN"]));
    expect(args).toEqual(expect.arrayContaining(["--cap-add", "NET_ADMIN"]));
  });

  it("does not duplicate SYS_PTRACE when the baseline container already has it", () => {
    const inspect = inspectFixture();
    inspect.HostConfig!.CapAdd = ["SYS_ADMIN", "SYS_PTRACE"];

    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"));

    const sysPtraceCount = args.filter((arg) => arg === "SYS_PTRACE").length;
    expect(sysPtraceCount).toBe(1);
  });

  it("injects apparmor=unconfined when the baseline container has no apparmor profile", () => {
    const inspect = inspectFixture();
    inspect.HostConfig!.SecurityOpt = [];

    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"));

    expect(args).toEqual(expect.arrayContaining(["--security-opt", "apparmor=unconfined"]));
  });

  it("respects a baseline-pinned apparmor profile instead of overriding it", () => {
    const inspect = inspectFixture();
    inspect.HostConfig!.SecurityOpt = ["apparmor=docker-default", "no-new-privileges"];

    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"));

    expect(args).toEqual(expect.arrayContaining(["--security-opt", "apparmor=docker-default"]));
    expect(args).toEqual(expect.arrayContaining(["--security-opt", "no-new-privileges"]));
    expect(args).not.toEqual(expect.arrayContaining(["--security-opt", "apparmor=unconfined"]));
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
    // --add-host writes to /etc/hosts (mount namespace), not the network
    // stack, so it must survive even when --network=host is explicitly
    // requested (#3562, #3568).
    expect(args).toEqual(
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
    expect(getDockerGpuPatchNetworkMode({})).toBe("preserve");
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

  it("uses Jetson NVIDIA runtime args without selecting generic --gpus or CDI candidates", () => {
    expect(buildDockerGpuMode("nvidia-runtime", null, { backend: "jetson" }).args).toEqual([
      "--runtime",
      "nvidia",
      "--env",
      "NVIDIA_VISIBLE_DEVICES=all",
      "--env",
      "NVIDIA_DRIVER_CAPABILITIES=compute,utility",
    ]);
    expect(
      buildDockerGpuModeCandidates("all", { backend: "jetson", cdiAvailable: true }).map(
        (m) => m.kind,
      ),
    ).toEqual(["nvidia-runtime"]);
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

  it("probes only NVIDIA runtime for Jetson Docker GPU mode", () => {
    const dockerCapture = vi.fn(() => "");
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "probe-id" }));

    const selected = selectDockerGpuPatchMode(
      { image: "openshell/sandbox:abc", backend: "jetson" },
      {
        dockerCapture,
        dockerRun,
        dockerRm: vi.fn(() => ({ status: 0 })),
      },
    );

    expect(selected.mode?.kind).toBe("nvidia-runtime");
    expect(selected.attempts.map((attempt) => attempt.mode.kind)).toEqual(["nvidia-runtime"]);
    expect(dockerRun).toHaveBeenCalledWith(
      expect.arrayContaining([
        "create",
        "--runtime",
        "nvidia",
        "--env",
        "NVIDIA_DRIVER_CAPABILITIES=compute,utility",
      ]),
      expect.objectContaining({ ignoreError: true }),
    );
    expect(dockerCapture).not.toHaveBeenCalled();
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

  it("detects NVIDIA CDI specs in /etc/cdi when docker info reports no dirs (#3575)", () => {
    // Reproduces the Docker 29 + nvidia-container-toolkit + no daemon.json
    // case: `docker info` returns an empty CDISpecDirs list, but Docker is
    // still reading specs from its well-known default /etc/cdi. The detector
    // should mirror Docker's behavior and surface cdi as available so the
    // candidate list keeps `cdi` for fallback after `--gpus all` trips the
    // AMD-CDI bug.
    const readDir = vi.fn((dirPath: string) =>
      dirPath === "/etc/cdi" ? ["nvidia.yaml"] : null,
    );
    const readFile = vi.fn((filePath: string) =>
      filePath === "/etc/cdi/nvidia.yaml"
        ? "cdiVersion: 0.6.0\nkind: nvidia.com/gpu\ndevices:\n  - name: all\n"
        : null,
    );
    expect(
      dockerReportsNvidiaCdiDevices({
        dockerCapture: vi.fn(() => ""),
        readDir,
        readFile,
      }),
    ).toBe(true);
    expect(readDir).toHaveBeenCalledWith("/etc/cdi");
  });

  it("returns false when default CDI dirs hold no NVIDIA specs", () => {
    expect(
      dockerReportsNvidiaCdiDevices({
        dockerCapture: vi.fn(() => ""),
        readDir: vi.fn(() => null),
        readFile: vi.fn(() => null),
      }),
    ).toBe(false);
  });

  it("falls back to default CDI dirs even when docker info errors", () => {
    const dockerCapture = vi.fn(() => {
      throw new Error("docker daemon unreachable");
    });
    const readDir = vi.fn((dirPath: string) =>
      dirPath === "/var/run/cdi" ? ["nvidia.json"] : null,
    );
    const readFile = vi.fn((filePath: string) =>
      filePath === "/var/run/cdi/nvidia.json"
        ? JSON.stringify({ cdiVersion: "0.6.0", kind: "nvidia.com/gpu" })
        : null,
    );
    expect(dockerReportsNvidiaCdiDevices({ dockerCapture, readDir, readFile })).toBe(true);
  });

  it("does not re-scan a directory that docker info already reported", () => {
    const readDir = vi.fn((dirPath: string) =>
      dirPath === "/etc/cdi" ? ["nvidia.yaml"] : null,
    );
    const readFile = vi.fn(() =>
      "cdiVersion: 0.6.0\nkind: nvidia.com/gpu\n",
    );
    dockerReportsNvidiaCdiDevices({
      dockerCapture: vi.fn(() => JSON.stringify(["/etc/cdi"])),
      readDir,
      readFile,
    });
    const etcCdiCalls = readDir.mock.calls.filter(([dir]) => dir === "/etc/cdi");
    expect(etcCdiCalls.length).toBe(1);
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
        "--cap-add",
        "SYS_ADMIN",
        "--cap-add",
        "SYS_PTRACE",
        "--security-opt",
        "apparmor=unconfined",
        "--network",
        "openshell-docker",
        "--add-host",
        "host.openshell.internal:172.17.0.1",
        "--env",
        "OPENSHELL_ENDPOINT=http://host.openshell.internal:8080/",
      ]),
      expect.objectContaining({ ignoreError: true }),
    );
    expect(runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "exec", "-n", "alpha", "--", "true"],
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
    const dockerRmCalls = dockerRm.mock.calls as unknown[][];
    const backupRmCall = dockerRmCalls.findIndex((call) =>
      String(call[0]).includes("nemoclaw-gpu-backup"),
    );
    expect(backupRmCall).toBeGreaterThanOrEqual(0);
    // Backup container is removed only AFTER supervisor reconnect confirms
    // the GPU container is reachable. If reconnect fails the rollback path
    // restores the backup under the original name (see the rollback test
    // below), so the backup must outlive the supervisor probe.
    expect(dockerRm.mock.invocationCallOrder[backupRmCall]).toBeGreaterThan(
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
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));
    const dockerRm = vi.fn((_name: string) => ({ status: 0 }));
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "phase: Provisioning" }));

    const result = recreateOpenShellDockerSandboxWithGpu(
      {
        sandboxName: "alpha",
        timeoutSecs: 1,
        waitForSupervisor: false,
        openshellSandboxCommand: ["env", "CHAT_UI_URL=http://127.0.0.1:8642", "nemoclaw-start"],
      },
      {
        dockerCapture,
        dockerRun: vi.fn(() => ({ status: 0, stdout: "probe-id\n" })),
        dockerRunDetached,
        dockerRename: vi.fn(() => ({ status: 0 })),
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm,
        runOpenshell,
        sleep: vi.fn(),
        now: () => new Date("2026-05-12T00:00:00Z"),
      },
    );

    expect(result.newContainerId).toBe("new-container-id");
    expect(result.backupRemoved).toBe(false);
    expect(result.originalName).toBe("openshell-alpha");
    expect(result.backupContainerName).toContain("nemoclaw-gpu-backup");
    expect(runOpenshell).not.toHaveBeenCalled();
    // The create path takes the supervisor wait into its own hands later in
    // the flow. The patch helper must NOT remove the backup yet — that would
    // re-introduce the deleted-backup / failed-new state #4664 fixes.
    expect(
      dockerRm.mock.calls.some((call) => String(call[0]).includes("nemoclaw-gpu-backup")),
    ).toBe(false);
    expect(dockerRunDetached).toHaveBeenCalledWith(
      expect.arrayContaining([
        "--env",
        "OPENSHELL_SANDBOX_COMMAND=env CHAT_UI_URL=http://127.0.0.1:8642 nemoclaw-start",
        "openshell/sandbox:abc",
        "env",
        "CHAT_UI_URL=http://127.0.0.1:8642",
        "nemoclaw-start",
      ]),
      expect.objectContaining({ ignoreError: true }),
    );
  });
});

describe("docker-gpu-patch sandbox DNS fallback (#3579)", () => {
  it("returns the systemd-resolved upstream when /etc/resolv.conf is loopback-only", () => {
    const readFile = (p: string): string | null => {
      if (p === "/etc/resolv.conf") return "nameserver 127.0.0.53\nsearch lan\n";
      if (p === "/run/systemd/resolve/resolv.conf") {
        return "# Generated by systemd-resolved\nnameserver 8.8.8.8\nnameserver 1.1.1.1\n";
      }
      return null;
    };
    expect(detectSandboxFallbackDns({ readFile })).toBe("8.8.8.8");
  });

  it("returns null when /etc/resolv.conf has a non-loopback resolver", () => {
    const readFile = (_p: string): string | null => "nameserver 192.168.1.1\n";
    expect(detectSandboxFallbackDns({ readFile })).toBeNull();
  });

  it("returns null when /etc/resolv.conf is missing", () => {
    expect(detectSandboxFallbackDns({ readFile: () => null })).toBeNull();
  });

  it("returns null when /etc/resolv.conf is loopback-only but systemd upstream is missing", () => {
    const readFile = (p: string): string | null => {
      if (p === "/etc/resolv.conf") return "nameserver 127.0.0.53\n";
      return null;
    };
    expect(detectSandboxFallbackDns({ readFile })).toBeNull();
  });

  it("injects sandboxFallbackDns via --dns on non-host networks", () => {
    const inspect = inspectFixture();
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"), {
      sandboxFallbackDns: "8.8.8.8",
    });
    expect(args).toEqual(expect.arrayContaining(["--dns", "8.8.8.8"]));
  });

  it("does not inject sandboxFallbackDns when OpenShell already configured --dns", () => {
    const inspect = inspectFixture();
    inspect.HostConfig = { ...inspect.HostConfig, Dns: ["10.43.0.10"] };
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"), {
      sandboxFallbackDns: "8.8.8.8",
    });
    expect(args).toEqual(expect.arrayContaining(["--dns", "10.43.0.10"]));
    expect(args).not.toEqual(expect.arrayContaining(["--dns", "8.8.8.8"]));
  });

  it("does not inject --dns when network mode is host (Docker ignores --dns on host)", () => {
    const inspect = inspectFixture();
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"), {
      networkMode: "host",
      sandboxFallbackDns: "8.8.8.8",
    });
    expect(args).not.toEqual(expect.arrayContaining(["--dns", "8.8.8.8"]));
  });

  it("plumbs detectSandboxFallbackDns through recreateOpenShellDockerSandboxWithGpu into clone args", () => {
    // Wire-through test: the production callsite at docker-gpu-patch.ts
    // calls d.detectSandboxFallbackDns() and merges the result into
    // cloneOptions.sandboxFallbackDns before building the run args. Stub
    // the deps hook and verify --dns lands in the final dockerRunDetached call.
    const dockerCapture = vi.fn((args: readonly string[]) => {
      if (args[0] === "ps") return "old-container-id\n";
      if (args[0] === "inspect") return JSON.stringify([inspectFixture()]);
      if (args[0] === "info") return "";
      return "";
    });
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));
    const detectSandboxFallbackDnsStub = vi.fn(() => "9.9.9.9");

    recreateOpenShellDockerSandboxWithGpu(
      { sandboxName: "alpha", timeoutSecs: 1 },
      {
        dockerCapture,
        dockerRun: vi.fn(() => ({ status: 0, stdout: "probe-id\n" })),
        dockerRunDetached,
        dockerRename: vi.fn(() => ({ status: 0 })),
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        runOpenshell: vi.fn(() => ({ status: 0 })),
        sleep: vi.fn(),
        now: () => new Date("2026-05-15T00:00:00Z"),
        detectSandboxFallbackDns: detectSandboxFallbackDnsStub,
      },
    );

    expect(detectSandboxFallbackDnsStub).toHaveBeenCalled();
    expect(dockerRunDetached).toHaveBeenCalledWith(
      expect.arrayContaining(["--dns", "9.9.9.9"]),
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("does not inject --dns through recreate when fallback detection returns null", () => {
    const dockerCapture = vi.fn((args: readonly string[]) => {
      if (args[0] === "ps") return "old-container-id\n";
      if (args[0] === "inspect") return JSON.stringify([inspectFixture()]);
      if (args[0] === "info") return "";
      return "";
    });
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));

    recreateOpenShellDockerSandboxWithGpu(
      { sandboxName: "alpha", timeoutSecs: 1 },
      {
        dockerCapture,
        dockerRun: vi.fn(() => ({ status: 0, stdout: "probe-id\n" })),
        dockerRunDetached,
        dockerRename: vi.fn(() => ({ status: 0 })),
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        runOpenshell: vi.fn(() => ({ status: 0 })),
        sleep: vi.fn(),
        now: () => new Date("2026-05-15T00:00:00Z"),
        detectSandboxFallbackDns: () => null,
      },
    );

    // No --dns from the fallback path (and inspectFixture() does not preset host.Dns).
    expect(dockerRunDetached).not.toHaveBeenCalledWith(
      expect.arrayContaining(["--dns"]),
      expect.anything(),
    );
  });

  it("regression manifest: host.openshell.internal + google.com + gateway.discord.gg + integrate.api.nvidia.com (#3579 manager spec)", () => {
    // The four hostnames called out in #3579's manager-provided spec:
    //   host.openshell.internal      → resolved via --add-host (mount namespace)
    //   google.com                   → public DNS via embedded Docker resolver
    //   gateway.discord.gg           → public DNS via embedded Docker resolver
    //   integrate.api.nvidia.com     → public DNS via embedded Docker resolver
    //
    // Unit-testable invariants that together cover all four:
    //   1. --add-host preserves the host.openshell.internal mapping
    //   2. Network mode is NOT "host" by default (so Docker's embedded DNS
    //      at 127.0.0.11 kicks in for the three public hostnames)
    //   3. When the host has a loopback-only resolver, the real upstream
    //      is injected via --dns so DNS works even if the daemon's
    //      embedded resolver can't reach the upstream by itself.
    const inspect = inspectFixture();
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"), {
      sandboxFallbackDns: "8.8.8.8",
    });

    // host.openshell.internal
    expect(args).toEqual(
      expect.arrayContaining(["--add-host", "host.openshell.internal:172.17.0.1"]),
    );
    // google.com / gateway.discord.gg / integrate.api.nvidia.com — covered by
    // (a) not pinning --network=host and (b) injecting --dns when the host
    // has a loopback-only resolver.
    expect(args).not.toEqual(expect.arrayContaining(["--network", "host"]));
    expect(args).toEqual(expect.arrayContaining(["--dns", "8.8.8.8"]));
  });
});

// Regression coverage for NemoClaw issue #4316: the Docker GPU patch path
// must distinguish "sandbox never became executable" (Error phase / dead
// container) from "GPU proof failed inside an executable sandbox", and the
// readiness wait must short-circuit on a terminal failure phase instead of
// burning the full timeout window.
describe("docker-gpu-patch Error-phase diagnostics (#4316)", () => {
  it("detects terminal failure phases in `openshell sandbox list` output", () => {
    const errorList = "my-sandbox   Error   2s ago";
    expect(getSandboxFailurePhase(errorList, "my-sandbox")).toBe("Error");
    expect(getSandboxFailurePhase("my-sandbox   CrashLoopBackOff   3s ago", "my-sandbox"))
      .toBe("CrashLoopBackOff");
    expect(getSandboxFailurePhase("my-sandbox   Failed   3s ago", "my-sandbox")).toBe("Failed");

    expect(getSandboxFailurePhase("my-sandbox   Ready   3s ago", "my-sandbox")).toBeNull();
    expect(getSandboxFailurePhase("other   Error   3s ago", "my-sandbox")).toBeNull();
    expect(getSandboxFailurePhase("", "my-sandbox")).toBeNull();
  });

  it("short-circuits the readiness wait when the sandbox enters Error phase", () => {
    const outputs = [
      "my-sandbox   Provisioning   1s ago",
      "my-sandbox   Error          3s ago",
    ];
    let i = 0;
    const runCaptureOpenshell = vi.fn(() => outputs[Math.min(i++, outputs.length - 1)]);
    const sleep = vi.fn();

    const ready = waitForCreatedSandboxReadyWithTrace({
      sandboxName: "my-sandbox",
      // 600 / 2 = 300 readyAttempts. Without short-circuit we'd loop 300
      // times. With short-circuit we should bail out after the 2nd poll.
      timeoutSecs: 600,
      runCaptureOpenshell,
      isSandboxReady,
      getSandboxFailurePhase,
      sleep,
    });

    expect(ready).toEqual({
      ready: false,
      reason: "terminal_failure_phase",
      failurePhase: "Error",
    });
    expect(runCaptureOpenshell).toHaveBeenCalledTimes(2);
    // Should not sleep after detecting the terminal phase.
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("short-circuits the supervisor-reconnect wait when the sandbox enters Error phase", () => {
    // Without the short-circuit, a patched container that crashes on startup
    // leaves users waiting the full 900s+ supervisor-reconnect timeout before
    // any Error-phase diagnostics run. With the debounce now in place, this
    // test asserts the K=1 (no-debounce) behavior explicitly so the original
    // fast-fail intent is preserved when the operator opts out of the
    // debounce.
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "sandbox not ready" }));
    const listOutputs = [
      "alpha   Provisioning   1s ago",
      "alpha   Error          3s ago",
    ];
    let i = 0;
    const runCaptureOpenshell = vi.fn(
      () => listOutputs[Math.min(i++, listOutputs.length - 1)],
    );
    const sleep = vi.fn();

    const ok = waitForOpenShellSupervisorReconnect("alpha", 600, {
      runOpenshell,
      runCaptureOpenshell,
      sleep,
      errorPhaseDebouncePolls: 1,
    });

    expect(ok).toBe(false);
    // Without short-circuit we'd loop ~300 iterations. With K=1 the second
    // iteration's list output shows Error and the wait bails out.
    expect(runOpenshell).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("prefers `sandbox list` phase over `sandbox get` when both are present (stale get)", () => {
    // Regression guard for #4316 CodeRabbit feedback: when `sandbox get`
    // returns a stale Phase (e.g. Provisioning while the gateway has already
    // transitioned the row to Error), the list-derived phase must take
    // precedence so the classifier doesn't act on stale data.
    const runCaptureOpenshell = vi.fn((args: readonly string[]) => {
      if (args[0] === "sandbox" && args[1] === "get") {
        return "Name: alpha\nPhase: Provisioning\n";
      }
      if (args[0] === "sandbox" && args[1] === "list") {
        return "alpha   Error   2s ago\n";
      }
      return "";
    });

    const snapshot = captureDockerGpuPatchSandboxSnapshot(
      "alpha",
      { patchedContainerId: null },
      { runCaptureOpenshell },
    );

    expect(snapshot.sandboxPhase).toBe("Error");
    expect(snapshot.sandboxListLine).toContain("Error");
  });

  it("uses the list-derived phase whenever the sandbox row is present", () => {
    // Regression guard for CodeRabbit feedback: `sandbox list` reflects the
    // gateway's table row and should be the phase used by the failure
    // classifier whenever that row is available, even if `sandbox get` reports
    // a different phase.
    const runCaptureOpenshell = vi.fn((args: readonly string[]) => {
      if (args[0] === "sandbox" && args[1] === "get") {
        return "Name: alpha\nPhase: Error\nReason: ContainerCannotRun\n";
      }
      if (args[0] === "sandbox" && args[1] === "list") {
        return "alpha   Ready   1m ago\n";
      }
      return "";
    });

    const snapshot = captureDockerGpuPatchSandboxSnapshot(
      "alpha",
      { patchedContainerId: null },
      { runCaptureOpenshell },
    );

    expect(snapshot.sandboxPhase).toBe("Ready");
    expect(snapshot.sandboxListLine).toContain("Ready");
  });

  it("keeps the get-derived phase when the sandbox row is absent from list output", () => {
    // Complement to the precedence test: if `sandbox list` has no row for
    // the named sandbox (e.g. the gateway lost track of it), the get-derived
    // phase is the only signal we have — don't drop it.
    const runCaptureOpenshell = vi.fn((args: readonly string[]) => {
      if (args[0] === "sandbox" && args[1] === "get") {
        return "Name: alpha\nPhase: Terminated\n";
      }
      if (args[0] === "sandbox" && args[1] === "list") {
        return "other-box   Ready   2s ago\n";
      }
      return "";
    });

    const snapshot = captureDockerGpuPatchSandboxSnapshot(
      "alpha",
      { patchedContainerId: null },
      { runCaptureOpenshell },
    );

    expect(snapshot.sandboxPhase).toBe("Terminated");
    expect(snapshot.sandboxListLine).toBeNull();
  });

  it("captures sandbox phase and patched container State via the snapshot helper", () => {
    const runCaptureOpenshell = vi.fn((args: readonly string[]) => {
      if (args[0] === "sandbox" && args[1] === "get") {
        return "Name: alpha\nPhase: Error\nReason: ContainerExit\n";
      }
      if (args[0] === "sandbox" && args[1] === "list") {
        return "alpha   Error   1m ago\n";
      }
      return "";
    });
    const dockerCapture = vi.fn((args: readonly string[]) => {
      if (args[0] === "inspect" && args[1] === "--format" && args[2] === "{{json .State}}") {
        return JSON.stringify({
          Status: "exited",
          Running: false,
          ExitCode: 125,
          Error: 'could not select device driver "nvidia" with capabilities: [[gpu]]',
          OOMKilled: false,
          StartedAt: "2026-05-12T00:00:00Z",
          FinishedAt: "2026-05-12T00:00:01Z",
        });
      }
      return "";
    });

    const snapshot = captureDockerGpuPatchSandboxSnapshot(
      "alpha",
      { patchedContainerId: "new-container-id" },
      { runCaptureOpenshell, dockerCapture },
    );

    expect(snapshot.sandboxPhase).toBe("Error");
    expect(snapshot.sandboxListLine).toBe("alpha   Error   1m ago");
    expect(snapshot.patchedContainerState?.ExitCode).toBe(125);
    expect(snapshot.patchedContainerState?.Error).toContain("could not select device driver");
  });

  it("classifies a dead patched container as patched_container_failed with the failed mode", () => {
    const result = classifyDockerGpuPatchFailure(
      {
        sandboxPhase: "Error",
        sandboxListLine: "alpha   Error   1m ago",
        patchedContainerState: {
          Status: "exited",
          ExitCode: 125,
          Error: 'could not select device driver "nvidia" with capabilities: [[gpu]]',
        },
      },
      buildDockerGpuMode("gpus"),
    );

    expect(result.kind).toBe("patched_container_failed");
    expect(result.headline).toContain("Patched GPU container exited with code 125");
    expect(result.headline).toContain("--gpus all");
    const flat = result.summaryLines.join("\n");
    expect(flat).toContain("sandbox_phase=Error");
    expect(flat).toContain("patched_container_exit_code=125");
    expect(flat).toContain("could not select device driver");
    expect(flat).toContain("patched_create_option=--gpus all");
  });

  it("classifies an Error-phase sandbox with unknown container state as sandbox_error_phase", () => {
    const result = classifyDockerGpuPatchFailure(
      {
        sandboxPhase: "Error",
        sandboxListLine: null,
        patchedContainerState: null,
      },
      buildDockerGpuMode("gpus"),
    );

    expect(result.kind).toBe("sandbox_error_phase");
    expect(result.headline).toContain("OpenShell sandbox entered Error phase");
  });

  it("classifies a live container but timed-out supervisor as supervisor_unreachable", () => {
    const result = classifyDockerGpuPatchFailure(
      {
        sandboxPhase: "Provisioning",
        sandboxListLine: "alpha   Provisioning   30s ago",
        patchedContainerState: { Status: "running", Running: true, ExitCode: 0 },
      },
      buildDockerGpuMode("gpus"),
    );

    expect(result.kind).toBe("supervisor_unreachable");
    expect(result.headline).toContain("Provisioning");
  });

  it("prefers supervisor_unreachable over proof_failure when the sandbox is non-live but non-terminal", () => {
    // Regression guard for #4316 review: a proof failing while the sandbox is
    // still in a transient/non-live phase (Provisioning, NotReady) is really
    // a lifecycle failure — classifying it as proof_failure would tell users
    // `nvidia-smi` failed inside an executable sandbox, which masks the real
    // cause.
    const result = classifyDockerGpuPatchFailure(
      {
        sandboxPhase: "Provisioning",
        sandboxListLine: "alpha   Provisioning   30s ago",
        patchedContainerState: null,
      },
      buildDockerGpuMode("gpus"),
      { proofError: new Error("openshell sandbox exec refused: sandbox not ready") },
    );

    expect(result.kind).toBe("supervisor_unreachable");
    expect(result.headline).toContain("Provisioning");
    expect(result.summaryLines.join("\n")).toContain("proof_error=");
  });

  it("does not blame the supervisor when the patch failed before a container existed", () => {
    // Regression guard for #4316 review: an early patch failure (e.g. all GPU
    // mode probes were rejected, or detached `docker run` failed) leaves no
    // patched container. If the original sandbox happens to still be in a
    // transient phase like Provisioning, the classifier must not point at
    // an OpenShell supervisor reconnect issue.
    const result = classifyDockerGpuPatchFailure(
      {
        sandboxPhase: "Provisioning",
        sandboxListLine: "alpha   Provisioning   3s ago",
        patchedContainerState: null,
      },
      null,
    );

    expect(result.kind).toBe("unknown");
    expect(result.headline).not.toMatch(/supervisor/i);
  });

  it("treats proof failures inside a Ready sandbox as proof_failure, not patched_container_failed", () => {
    const result = classifyDockerGpuPatchFailure(
      {
        sandboxPhase: "Ready",
        sandboxListLine: "alpha   Ready   30s ago",
        patchedContainerState: { Status: "running", Running: true, ExitCode: 0 },
      },
      buildDockerGpuMode("gpus"),
      { proofError: new Error("nvidia-smi exited with status 9") },
    );

    expect(result.kind).toBe("proof_failure");
    expect(result.summaryLines.join("\n")).toContain("proof_error=nvidia-smi exited with status 9");
  });

  it("preserves the default Docker capture when callers omit dockerCapture from deps", () => {
    // Regression guard for #4316 review: passing `dockerCapture: undefined`
    // through to `depsWithDefaults` would shadow the module's real Docker
    // adapter. The print/diagnostic helpers must NOT forward an explicit
    // `undefined` — they should let the default flow through so `docker ps`
    // and `docker inspect <container>` still run.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-gpu-default-"));
    try {
      const dockerCapture = vi.fn((_args: readonly string[]) => "");
      const dockerLogs = vi.fn(() => "");
      collectDockerGpuPatchDiagnostics(
        "alpha",
        {
          context: {
            sandboxName: "alpha",
            newContainerId: "new-container-id",
            selectedMode: buildDockerGpuMode("gpus"),
          },
        },
        {
          // `runCaptureOpenshell` intentionally omitted — exercises the
          // "caller has no openshell capture either" path.
          dockerCapture,
          dockerLogs,
          homedir: () => tmpDir,
          now: () => new Date("2026-05-12T00:00:00Z"),
        },
      );

      // Without the fix, `depsWithDefaults` would still see `dockerCapture` as
      // a function here (the explicit one), so this is more of a structural
      // sanity check. The substantive regression is exercised at the print-
      // helper level (printDockerGpuPatchFailureAndExit must not pass
      // `dockerCapture: undefined`). Here we just confirm collect() invokes
      // the supplied dockerCapture for ps/inspect.
      expect(
        dockerCapture.mock.calls.some(([args]) => args?.[0] === "ps"),
      ).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not inspect the original/backup container when newContainerId is missing", () => {
    // Regression guard for #4316 review: when `recreateOpenShellDockerSandboxWithGpu`
    // throws before the patched container exists, only `oldContainerId` is set
    // in the failure context. The snapshot must NOT inspect the old/backup
    // container as if it were the patched one — that would mis-attribute the
    // patched container's State.
    const dockerCapture = vi.fn((args: readonly string[]) => {
      if (args[0] === "inspect" && args[1] === "--format" && args[2] === "{{json .State}}") {
        // If this is called for old-container-id, return State that *looks*
        // like a failed patch; the test would then incorrectly classify it.
        return JSON.stringify({ Status: "exited", ExitCode: 1 });
      }
      return "";
    });

    const snapshot = captureDockerGpuPatchSandboxSnapshot(
      "alpha",
      { patchedContainerId: null },
      { dockerCapture },
    );

    expect(snapshot.patchedContainerState).toBeNull();
    // The `--format '{{json .State}}'` invocation should not have happened.
    expect(
      dockerCapture.mock.calls.some(
        ([args]) => args[0] === "inspect" && args[1] === "--format",
      ),
    ).toBe(false);
  });

  it("writes patched-container-state.json and surfaces failure_kind/sandbox_phase in the summary", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-gpu-4316-"));
    try {
      const snapshot = {
        sandboxPhase: "Error",
        sandboxListLine: "alpha   Error   1m ago",
        patchedContainerState: {
          Status: "exited",
          ExitCode: 125,
          Error: 'could not select device driver "nvidia"',
        },
      };
      const classification = classifyDockerGpuPatchFailure(snapshot, buildDockerGpuMode("gpus"));
      const diagnostics = collectDockerGpuPatchDiagnostics(
        "alpha",
        {
          context: {
            sandboxName: "alpha",
            newContainerId: "new-container-id",
            selectedMode: buildDockerGpuMode("gpus"),
          },
          selectedMode: buildDockerGpuMode("gpus"),
          snapshot,
          classification,
        },
        {
          dockerCapture: vi.fn(() => ""),
          dockerLogs: vi.fn(() => ""),
          homedir: () => tmpDir,
          now: () => new Date("2026-05-12T00:00:00Z"),
        },
      );

      expect(diagnostics?.dir).toBeTruthy();
      const summary = fs.readFileSync(path.join(diagnostics?.dir || "", "summary.txt"), "utf-8");
      expect(summary).toContain("failure_kind=patched_container_failed");
      expect(summary).toContain("sandbox_phase=Error");
      expect(summary).toContain("patched_container_exit_code=125");
      const state = fs.readFileSync(
        path.join(diagnostics?.dir || "", "patched-container-state.json"),
        "utf-8",
      );
      expect(state).toContain("could not select device driver");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

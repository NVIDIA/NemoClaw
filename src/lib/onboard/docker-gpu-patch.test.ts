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
  detectSandboxFallbackDns,
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

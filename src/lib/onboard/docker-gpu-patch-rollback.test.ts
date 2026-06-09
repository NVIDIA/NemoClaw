// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  type DockerContainerInspect,
  recreateOpenShellDockerSandboxWithGpu,
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

describe("recreateOpenShellDockerSandboxWithGpu rollback path", () => {
  it("rolls back to the backup container when supervisor reconnect fails", () => {
    const dockerCapture = vi.fn((args: readonly string[]) => {
      if (args[0] === "ps") return "old-container-id\n";
      if (args[0] === "inspect") return JSON.stringify([inspectFixture()]);
      if (args[0] === "info") return "";
      return "";
    });
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "probe-id\n" }));
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));
    const dockerRename = vi.fn((_old: string, _next: string) => ({ status: 0 }));
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn((_name: string) => ({ status: 0 }));
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "supervisor unreachable" }));
    const runCaptureOpenshell = vi.fn(() => "");

    expect(() =>
      recreateOpenShellDockerSandboxWithGpu(
        { sandboxName: "alpha", timeoutSecs: 1 },
        {
          dockerCapture,
          dockerRun,
          dockerRunDetached,
          dockerRename,
          dockerStop,
          dockerStart,
          dockerRm,
          runOpenshell,
          runCaptureOpenshell,
          sleep: vi.fn(),
          now: () => new Date("2026-05-12T00:00:00Z"),
          errorPhaseDebouncePolls: 1,
        },
      ),
    ).toThrow(/pre-patch sandbox restored/);

    const restoreRename = dockerRename.mock.calls.find(
      (call) => String(call[0]).includes("nemoclaw-gpu-backup") && call[1] === "openshell-alpha",
    );
    expect(restoreRename).toBeDefined();
    expect(dockerStart).toHaveBeenCalledWith(
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(
      dockerRm.mock.calls.some((call) => String(call[0]).includes("nemoclaw-gpu-backup")),
    ).toBe(false);
  });

  it("reports rollback failure when restoring the backup container fails", () => {
    const dockerCapture = vi.fn((args: readonly string[]) => {
      if (args[0] === "ps") return "old-container-id\n";
      if (args[0] === "inspect") return JSON.stringify([inspectFixture()]);
      if (args[0] === "info") return "";
      return "";
    });
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "probe-id\n" }));
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));
    const dockerRename = vi.fn((oldName: string) => {
      if (String(oldName).includes("nemoclaw-gpu-backup")) {
        return { status: 1, stderr: "no such container" };
      }
      return { status: 0 };
    });
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn(() => ({ status: 0 }));
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "supervisor unreachable" }));
    const runCaptureOpenshell = vi.fn(() => "");

    expect(() =>
      recreateOpenShellDockerSandboxWithGpu(
        { sandboxName: "alpha", timeoutSecs: 1 },
        {
          dockerCapture,
          dockerRun,
          dockerRunDetached,
          dockerRename,
          dockerStop,
          dockerStart,
          dockerRm,
          runOpenshell,
          runCaptureOpenshell,
          sleep: vi.fn(),
          now: () => new Date("2026-05-12T00:00:00Z"),
          errorPhaseDebouncePolls: 1,
        },
      ),
    ).toThrow(/rollback failed; pre-patch sandbox was NOT restored/);

    expect(dockerStart).not.toHaveBeenCalled();
  });

  it("reports rollback failure when restarting the backup container fails", () => {
    const dockerCapture = vi.fn((args: readonly string[]) => {
      if (args[0] === "ps") return "old-container-id\n";
      if (args[0] === "inspect") return JSON.stringify([inspectFixture()]);
      if (args[0] === "info") return "";
      return "";
    });
    const dockerRun = vi.fn(() => ({ status: 0, stdout: "probe-id\n" }));
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));
    const dockerRename = vi.fn((_old: string, _next: string) => ({ status: 0 }));
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 1, stderr: "container start failed" }));
    const dockerRm = vi.fn((_name: string) => ({ status: 0 }));
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "supervisor unreachable" }));
    const runCaptureOpenshell = vi.fn(() => "");

    expect(() =>
      recreateOpenShellDockerSandboxWithGpu(
        { sandboxName: "alpha", timeoutSecs: 1 },
        {
          dockerCapture,
          dockerRun,
          dockerRunDetached,
          dockerRename,
          dockerStop,
          dockerStart,
          dockerRm,
          runOpenshell,
          runCaptureOpenshell,
          sleep: vi.fn(),
          now: () => new Date("2026-05-12T00:00:00Z"),
          errorPhaseDebouncePolls: 1,
        },
      ),
    ).toThrow(/rollback failed; pre-patch sandbox was NOT restored/);

    expect(dockerStart).toHaveBeenCalledWith(
      "openshell-alpha",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(
      dockerRm.mock.calls.some((call) => String(call[0]).includes("nemoclaw-gpu-backup")),
    ).toBe(false);
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { DockerContainerInspect } from "./docker-gpu-patch";
import { recreateOpenShellDockerSandboxWithStartupCommand } from "./docker-startup-command-patch";

function inspectFixture(): DockerContainerInspect {
  return {
    Id: "old-container-id",
    Name: "/openshell-alpha",
    Config: {
      Image: "openshell/sandbox:abc",
      Env: ["OPENSHELL_SANDBOX_COMMAND=sleep infinity", "NVIDIA_VISIBLE_DEVICES=void"],
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": "alpha",
      },
      Entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
      Cmd: [],
      User: "0",
      WorkingDir: "/workspace",
    },
    HostConfig: {
      NetworkMode: "openshell-docker",
      RestartPolicy: { Name: "unless-stopped" },
      CapAdd: [],
      SecurityOpt: [],
    },
  };
}

describe("Docker startup-command patch", () => {
  it("persists the startup command without adding GPU-only container privileges", () => {
    const dockerCaptureOutput: Record<string, string> = {
      ps: "old-container-id\n",
      inspect: JSON.stringify([inspectFixture()]),
    };
    const dockerCapture = vi.fn(
      (args: readonly string[]) => dockerCaptureOutput[args[0] ?? ""] ?? "",
    );
    const dockerRunDetached = vi.fn((_args: readonly string[]) => ({
      status: 0,
      stdout: "new-container-id\n",
    }));

    const result = recreateOpenShellDockerSandboxWithStartupCommand(
      {
        sandboxName: "alpha",
        timeoutSecs: 1,
        waitForSupervisor: false,
        openshellSandboxCommand: ["env", "CHAT_UI_URL=http://127.0.0.1:8642", "nemoclaw-start"],
      },
      {
        dockerCapture,
        dockerRunDetached,
        dockerRename: vi.fn(() => ({ status: 0 })),
        dockerStop: vi.fn(() => ({ status: 0 })),
        sleep: vi.fn(),
        now: () => new Date("2026-07-10T00:00:00Z"),
      },
    );

    expect(result.mode.kind).toBe("startup-command");
    const cloneArgs = dockerRunDetached.mock.calls[0]?.[0] ?? [];
    expect(cloneArgs).toEqual(
      expect.arrayContaining([
        "--env",
        "OPENSHELL_SANDBOX_COMMAND=env CHAT_UI_URL=http://127.0.0.1:8642 nemoclaw-start",
      ]),
    );
    expect(cloneArgs).not.toContain("--gpus");
    expect(cloneArgs).toEqual(expect.arrayContaining(["--env", "NVIDIA_VISIBLE_DEVICES=void"]));
    expect(cloneArgs).not.toEqual(expect.arrayContaining(["--cap-add", "SYS_PTRACE"]));
    expect(cloneArgs).not.toEqual(
      expect.arrayContaining(["--security-opt", "apparmor=unconfined"]),
    );
  });

  it("rejects an empty restart-persistence command before Docker mutation", () => {
    expect(() =>
      recreateOpenShellDockerSandboxWithStartupCommand({
        sandboxName: "alpha",
        openshellSandboxCommand: [],
      }),
    ).toThrow("OpenShell sandbox startup command is required for restart persistence");
  });

  it("rejects shell metacharacters before Docker mutation", () => {
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerRename = vi.fn(() => ({ status: 0 }));
    const dockerRunDetached = vi.fn(() => ({ status: 0, stdout: "new-container-id\n" }));

    expect(() =>
      recreateOpenShellDockerSandboxWithStartupCommand(
        {
          sandboxName: "alpha",
          openshellSandboxCommand: ["env", "VALUE=$(id)", "nemoclaw-start"],
        },
        {
          dockerCapture: vi.fn((args: readonly string[]) =>
            args[0] === "ps"
              ? "old-container-id\n"
              : args[0] === "inspect"
                ? JSON.stringify([inspectFixture()])
                : "",
          ),
          dockerRunDetached,
          dockerRename,
          dockerStop,
        },
      ),
    ).toThrow("OpenShell sandbox startup command tokens contain unsupported shell metacharacters");
    expect(dockerStop).not.toHaveBeenCalled();
    expect(dockerRename).not.toHaveBeenCalled();
    expect(dockerRunDetached).not.toHaveBeenCalled();
  });

  it("restores the original sandbox when startup-command recreation fails", () => {
    const dockerRunDetached = vi.fn(() => ({ status: 1, stderr: "boom" }));

    expect(() =>
      recreateOpenShellDockerSandboxWithStartupCommand(
        {
          sandboxName: "alpha",
          openshellSandboxCommand: ["env", "nemoclaw-start"],
        },
        {
          dockerCapture: vi.fn((args: readonly string[]) =>
            args[0] === "ps"
              ? "old-container-id\n"
              : args[0] === "inspect"
                ? JSON.stringify([inspectFixture()])
                : "",
          ),
          dockerRunDetached,
          dockerRename: vi.fn(() => ({ status: 0 })),
          dockerRm: vi.fn(() => ({ status: 0 })),
          dockerStart: vi.fn(() => ({ status: 0 })),
          dockerStop: vi.fn(() => ({ status: 0 })),
          now: () => new Date("2026-07-10T00:00:00Z"),
        },
      ),
    ).toThrow(/Could not start recreated sandbox container: boom; pre-patch sandbox restored/);
  });
});

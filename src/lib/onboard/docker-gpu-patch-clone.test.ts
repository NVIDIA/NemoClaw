// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createDockerGpuInspectFixture as inspectFixture } from "./__test-helpers__/docker-gpu-patch-fixtures";
import {
  buildDockerGpuCloneRunArgs,
  buildDockerGpuCloneRunOptions,
  buildDockerGpuMode,
  getDockerGpuPatchNetworkMode,
} from "./docker-gpu-patch";
import { shouldOmitOpenShellOciImageUser } from "./docker-gpu-patch-clone";

const NEMOCLAW_STARTUP_ARGV = ["env", "/usr/local/bin/nemoclaw-start"] as const;

function openShellOciWorkspaceInspect() {
  const inspect = inspectFixture();
  Object.assign(inspect.Config!, {
    User: "0",
    WorkingDir: "/",
    Entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
    Cmd: ["--workdir", "/sandbox"],
    Env: [
      ...inspect.Config!.Env!,
      "OPENSHELL_OCI_IMAGE_USER=sandbox",
      "OPENSHELL_SANDBOX_UID=",
      "OPENSHELL_SANDBOX_GID=",
      "OPENSHELL_OCI_IMAGE_USER_LOOKALIKE=preserved",
    ],
  });
  return inspect;
}

describe("Docker GPU clone envelope", () => {
  it("omits only OpenShell's OCI-user marker at the exact NemoClaw workspace boundary (#8662)", () => {
    const inspect = openShellOciWorkspaceInspect();
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("startup-command"), {
      openshellSandboxCommand: NEMOCLAW_STARTUP_ARGV,
    });

    expect(shouldOmitOpenShellOciImageUser(inspect, NEMOCLAW_STARTUP_ARGV)).toBe(true);
    expect(args).not.toEqual(expect.arrayContaining(["--env", "OPENSHELL_OCI_IMAGE_USER=sandbox"]));
    expect(args).toEqual(
      expect.arrayContaining([
        "--env",
        "OPENSHELL_SANDBOX_UID=",
        "--env",
        "OPENSHELL_SANDBOX_GID=",
        "--env",
        "OPENSHELL_OCI_IMAGE_USER_LOOKALIKE=preserved",
      ]),
    );
  });

  it("preserves the pre-0.0.99 environment when OCI identity metadata is absent (#8662)", () => {
    const inspect = openShellOciWorkspaceInspect();
    inspect.Config!.Env = inspect.Config!.Env!.filter(
      (entry) =>
        !entry.startsWith("OPENSHELL_OCI_IMAGE_USER=") &&
        !entry.startsWith("OPENSHELL_SANDBOX_UID=") &&
        !entry.startsWith("OPENSHELL_SANDBOX_GID="),
    );

    expect(shouldOmitOpenShellOciImageUser(inspect, NEMOCLAW_STARTUP_ARGV)).toBe(false);
  });

  it("preserves the exact workspace compatibility metadata across another recreation (#8662)", () => {
    const inspect = openShellOciWorkspaceInspect();
    inspect.Config!.Env = inspect.Config!.Env!.filter(
      (entry) => !entry.startsWith("OPENSHELL_OCI_IMAGE_USER="),
    );

    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("startup-command"), {
      openshellSandboxCommand: NEMOCLAW_STARTUP_ARGV,
    });

    expect(shouldOmitOpenShellOciImageUser(inspect, NEMOCLAW_STARTUP_ARGV)).toBe(false);
    expect(args).toEqual(
      expect.arrayContaining([
        "--env",
        "OPENSHELL_SANDBOX_UID=",
        "--env",
        "OPENSHELL_SANDBOX_GID=",
      ]),
    );
    expect(args).not.toEqual(expect.arrayContaining(["--env", "OPENSHELL_OCI_IMAGE_USER=sandbox"]));
  });

  it.each([
    {
      name: "missing sandbox GID",
      mutate: (environment: string[]) =>
        environment.filter((entry) => entry !== "OPENSHELL_SANDBOX_GID="),
    },
    {
      name: "non-empty sandbox UID",
      mutate: (environment: string[]) =>
        environment.map((entry) =>
          entry === "OPENSHELL_SANDBOX_UID=" ? "OPENSHELL_SANDBOX_UID=998" : entry,
        ),
    },
    {
      name: "empty OCI user",
      mutate: (environment: string[]) =>
        environment.map((entry) =>
          entry === "OPENSHELL_OCI_IMAGE_USER=sandbox" ? "OPENSHELL_OCI_IMAGE_USER=" : entry,
        ),
    },
    {
      name: "OCI user without an assignment",
      mutate: (environment: string[]) =>
        environment.map((entry) =>
          entry === "OPENSHELL_OCI_IMAGE_USER=sandbox" ? "OPENSHELL_OCI_IMAGE_USER" : entry,
        ),
    },
    {
      name: "duplicate OCI user",
      mutate: (environment: string[]) => [...environment, "OPENSHELL_OCI_IMAGE_USER=sandbox"],
    },
    {
      name: "already-applied metadata without a sandbox GID",
      mutate: (environment: string[]) =>
        environment.filter(
          (entry) =>
            !entry.startsWith("OPENSHELL_OCI_IMAGE_USER=") && entry !== "OPENSHELL_SANDBOX_GID=",
        ),
    },
    {
      name: "already-applied metadata with a non-empty sandbox UID",
      mutate: (environment: string[]) =>
        environment
          .filter((entry) => !entry.startsWith("OPENSHELL_OCI_IMAGE_USER="))
          .map((entry) =>
            entry === "OPENSHELL_SANDBOX_UID=" ? "OPENSHELL_SANDBOX_UID=998" : entry,
          ),
    },
    {
      name: "already-applied metadata with a duplicate sandbox UID",
      mutate: (environment: string[]) => [
        ...environment.filter((entry) => !entry.startsWith("OPENSHELL_OCI_IMAGE_USER=")),
        "OPENSHELL_SANDBOX_UID=",
      ],
    },
  ])("rejects $name in OpenShell's protected identity metadata (#8662)", ({ mutate }) => {
    const inspect = openShellOciWorkspaceInspect();
    inspect.Config!.Env = mutate(inspect.Config!.Env!);

    expect(() =>
      buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("startup-command"), {
        openshellSandboxCommand: NEMOCLAW_STARTUP_ARGV,
      }),
    ).toThrow("workspace identity metadata is not the reviewed Docker compatibility contract");
  });

  it("preserves OCI-user metadata outside the exact NemoClaw workspace boundary (#8662)", () => {
    const inspect = openShellOciWorkspaceInspect();
    inspect.Config!.WorkingDir = "/sandbox";
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("startup-command"), {
      openshellSandboxCommand: NEMOCLAW_STARTUP_ARGV,
    });

    expect(shouldOmitOpenShellOciImageUser(inspect, NEMOCLAW_STARTUP_ARGV)).toBe(false);
    expect(args).toEqual(expect.arrayContaining(["--env", "OPENSHELL_OCI_IMAGE_USER=sandbox"]));
  });

  it("builds clone args that preserve OpenShell labels, mounts, and runtime settings", () => {
    const inspect = inspectFixture();
    inspect.HostConfig!.Annotations = { "io.container.manager": "libpod" };
    inspect.HostConfig!.Mounts!.push({
      Type: "image",
      Source: "ghcr.io/nvidia/openshell/sandbox:v0.0.106",
      Target: "/opt/openshell/bin",
      ReadOnly: true,
    });
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"));

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
        "--annotation",
        "io.container.manager=libpod",
        "--label",
        "openshell.ai/managed-by=openshell",
        "--label",
        "openshell.ai/sandbox-name=alpha",
        "--volume",
        "/host:/container:rw",
        "--mount",
        "type=tmpfs,dst=/tmp/nemoclaw-exact-main-driver-config,tmpfs-size=16777216,tmpfs-mode=1777",
        "--mount",
        "type=image,src=ghcr.io/nvidia/openshell/sandbox:v0.0.106,dst=/opt/openshell/bin",
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

  it("preserves OpenShell structured volume options", () => {
    const inspect = inspectFixture();
    inspect.HostConfig!.Mounts!.push({
      Type: "volume",
      Source: "sandbox-cache",
      Target: "/sandbox/cache",
      ReadOnly: true,
      VolumeOptions: { NoCopy: true, Subpath: "project" },
    });

    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("startup-command"));

    expect(args).toEqual(
      expect.arrayContaining([
        "--mount",
        "type=volume,src=sandbox-cache,dst=/sandbox/cache,readonly,volume-nocopy,volume-subpath=project",
      ]),
    );
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

  it("preserves inspected ulimits and overrides DCode's exact required limits", () => {
    const inspect = inspectFixture();
    inspect.HostConfig!.Ulimits = [
      { Name: "core", Soft: 0, Hard: -1 },
      { Name: "RLIMIT_NOFILE", Soft: 1024, Hard: 1024 },
    ];

    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("startup-command"), {
      requiredUlimits: [
        { name: "nproc", soft: 512, hard: 512 },
        { name: "nofile", soft: 65_536, hard: 65_536 },
      ],
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "--ulimit",
        "core=0:-1",
        "--ulimit",
        "nofile=65536:65536",
        "--ulimit",
        "nproc=512:512",
      ]),
    );
    expect(args).not.toContain("RLIMIT_NOFILE=1024:1024");
    expect(args).not.toContain("nofile=1024:1024");
  });

  it("does not replay client attachment state into detached recreation", () => {
    const inspect = inspectFixture();
    Object.assign(inspect.Config!, {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    });

    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("startup-command"));

    expect(args).not.toContain("--attach");
  });

  it.each([2048, -1])("preserves the exact Docker PID limit %i", (pidsLimit) => {
    const inspect = inspectFixture();
    inspect.HostConfig!.PidsLimit = pidsLimit;

    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("startup-command"));

    expect(args).toEqual(expect.arrayContaining(["--pids-limit", String(pidsLimit)]));
  });

  it("uses exact managed-bootstrap container, entrypoint, and command overrides", () => {
    const inspect = inspectFixture();
    Object.assign(inspect.Config!, {
      ExposedPorts: { "2222/tcp": {} },
      Healthcheck: {
        Test: ["CMD-SHELL", "test -S /run/openshell/ssh.sock"],
        Interval: 10_000_000_000,
        Timeout: 2_000_000_000,
        StartPeriod: 5_000_000_000,
        Retries: 10,
      },
      StopTimeout: 45,
    });
    Object.assign(inspect.HostConfig!, {
      Annotations: { "io.container.manager": "libpod" },
      NetworkMode: "bridge",
      OomScoreAdj: 0,
      PortBindings: {
        "2222/tcp": [{ HostIp: "0.0.0.0", HostPort: "33513" }],
      },
    });
    const args = buildDockerGpuCloneRunArgs(
      inspect,
      buildDockerGpuMode("startup-command"),
      {
        containerName: "openshell-alpha-bootstrap-stage",
        containerEntrypoint: "/usr/local/bin/nemoclaw-managed-bootstrap",
        containerCommand: ["--request", "/run/nemoclaw/bootstrap-request.json"],
        preserveManagedLaunchSpec: true,
      },
    );

    expect(args.slice(0, 2)).toEqual(["--name", "openshell-alpha-bootstrap-stage"]);
    expect(args).toEqual(
      expect.arrayContaining(["--entrypoint", "/usr/local/bin/nemoclaw-managed-bootstrap"]),
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--expose",
        "2222/tcp",
        "--publish",
        "0.0.0.0:33513:2222/tcp",
        "--health-cmd",
        "test -S /run/openshell/ssh.sock",
        "--health-interval",
        "10000000000ns",
        "--health-timeout",
        "2000000000ns",
        "--health-start-period",
        "5000000000ns",
        "--health-retries",
        "10",
        "--stop-timeout",
        "45",
        "--oom-score-adj",
        "500",
        "--network",
        "openshell-docker",
      ]),
    );
    expect(args.slice(args.indexOf("openshell/sandbox:abc"))).toEqual([
      "openshell/sandbox:abc",
      "--request",
      "/run/nemoclaw/bootstrap-request.json",
    ]);
  });

  it.each([
    "",
    "-starts-with-dash",
    "contains/slash",
    "a".repeat(254),
  ])("rejects invalid managed-bootstrap container name %j", (containerName) => {
    expect(() =>
      buildDockerGpuCloneRunArgs(inspectFixture(), buildDockerGpuMode("startup-command"), {
        containerName,
      }),
    ).toThrow("Docker clone container name is invalid.");
  });

  it("adds SYS_PTRACE to the GPU clone when the baseline container lacks it", () => {
    const inspect = inspectFixture();
    inspect.HostConfig!.CapAdd = ["SYS_ADMIN", "NET_ADMIN"];
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"));

    expect(args).toEqual(expect.arrayContaining(["--cap-add", "SYS_PTRACE"]));
    expect(args).toEqual(expect.arrayContaining(["--cap-add", "SYS_ADMIN"]));
    expect(args).toEqual(expect.arrayContaining(["--cap-add", "NET_ADMIN"]));
  });

  it("does not duplicate SYS_PTRACE when the baseline container already has it", () => {
    const inspect = inspectFixture();
    inspect.HostConfig!.CapAdd = ["SYS_ADMIN", "SYS_PTRACE"];
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("gpus"));

    expect(args.filter((arg) => arg === "SYS_PTRACE").length).toBe(1);
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

  it.each([
    { name: "missing", endpoint: null },
    { name: "unrewritable", endpoint: "http://gateway.example.test:8080/" },
  ])("fails closed when host networking is requested with a $name OpenShell endpoint (#6110)", ({
    endpoint,
  }) => {
    const inspect = inspectFixture();
    inspect.Config!.Env = [
      ...inspect.Config!.Env!.filter((entry) => !entry.startsWith("OPENSHELL_ENDPOINT=")),
      ...(endpoint === null ? [] : [`OPENSHELL_ENDPOINT=${endpoint}`]),
    ];

    expect(() =>
      buildDockerGpuCloneRunOptions(inspect, {
        NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "host",
      }),
    ).toThrow(/NEMOCLAW_DOCKER_GPU_PATCH_NETWORK=host requires .*OPENSHELL_ENDPOINT/i);
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
});

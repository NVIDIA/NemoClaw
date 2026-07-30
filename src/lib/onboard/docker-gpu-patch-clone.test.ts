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

describe("Docker GPU clone envelope", () => {
  it("builds clone args that preserve OpenShell labels, mounts, and runtime settings", () => {
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
        "--mount",
        "type=tmpfs,dst=/tmp/nemoclaw-exact-main-driver-config,tmpfs-size=16777216,tmpfs-mode=1777",
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

  it("persists the image-owned hold without replacing the original supervisor entrypoint", () => {
    const inspect = inspectFixture();
    inspect.Config!.Entrypoint = ["/opt/openshell/bin/openshell-sandbox", "--gateway-mode"];
    inspect.Config!.Cmd = ["serve", "--foreground"];
    const immutableImage = inspect.Image as string;
    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("startup-command"), {
      image: immutableImage,
      openshellSandboxCommand: [
        "env",
        "/usr/local/bin/nemoclaw-managed-startup-hold",
        "--agent",
        "hermes",
        "--profile-fingerprint",
        "a".repeat(64),
      ],
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "--env",
        `OPENSHELL_SANDBOX_COMMAND=env /usr/local/bin/nemoclaw-managed-startup-hold --agent hermes --profile-fingerprint ${"a".repeat(64)}`,
        "--entrypoint",
        "/opt/openshell/bin/openshell-sandbox",
      ]),
    );
    const imageIndex = args.indexOf(immutableImage);
    expect(imageIndex).toBeGreaterThan(0);
    expect(args.slice(imageIndex)).toEqual([immutableImage]);
    expect(args).not.toContain("openshell/sandbox:abc");
  });

  it("preserves inspected ulimits and overrides DCode's exact required limits", () => {
    const inspect = inspectFixture();
    inspect.HostConfig!.Ulimits = [
      { Name: "core", Soft: 0, Hard: -1 },
      { Name: "nofile", Soft: 1024, Hard: 1024 },
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
    expect(args).not.toContain("nofile=1024:1024");
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

  it("preserves the explicit OCI launch fields required by bootstrap recreation", () => {
    const inspect = inspectFixture();
    inspect.Config!.Domainname = "sandbox.internal";
    inspect.Config!.ExposedPorts = { "8080/tcp": {} };
    inspect.Config!.Healthcheck = {
      Test: ["CMD-SHELL", "test -f /run/ready"],
      Interval: 1_000_000_000,
      Timeout: 2_000_000_000,
      StartPeriod: 3_000_000_000,
      StartInterval: 500_000_000,
      Retries: 4,
    };
    inspect.Config!.StopSignal = "SIGTERM";
    inspect.Config!.StopTimeout = 30;
    Object.assign(inspect.HostConfig!, {
      PortBindings: {
        "8080/tcp": [{ HostIp: "::1", HostPort: "18080" }],
      },
      Devices: [
        {
          PathOnHost: "/dev/fuse",
          PathInContainer: "/dev/fuse",
          CgroupPermissions: "rwm",
        },
      ],
      DeviceCgroupRules: ["c 10:229 rwm"],
      Tmpfs: { "/run/private": "rw,noexec,nosuid,size=65536k" },
      ReadonlyRootfs: true,
      Sysctls: { "net.ipv4.ip_unprivileged_port_start": "0" },
      CgroupParent: "openshell.slice",
      CgroupnsMode: "private",
      UsernsMode: "host",
      UTSMode: "private",
      LogConfig: { Type: "local", Config: { "max-size": "10m" } },
      DnsOptions: ["ndots:1"],
    });

    const args = buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("startup-command"));

    expect(args).toEqual(
      expect.arrayContaining([
        "--domainname",
        "sandbox.internal",
        "--expose",
        "8080/tcp",
        "--publish",
        "[::1]:18080:8080/tcp",
        "--health-cmd",
        "test -f /run/ready",
        "--health-interval",
        "1000000000ns",
        "--health-timeout",
        "2000000000ns",
        "--health-start-period",
        "3000000000ns",
        "--health-start-interval",
        "500000000ns",
        "--health-retries",
        "4",
        "--stop-signal",
        "SIGTERM",
        "--stop-timeout",
        "30",
        "--device",
        "/dev/fuse:/dev/fuse:rwm",
        "--device-cgroup-rule",
        "c 10:229 rwm",
        "--tmpfs",
        "/run/private:rw,noexec,nosuid,size=65536k",
        "--read-only",
        "--sysctl",
        "net.ipv4.ip_unprivileged_port_start=0",
        "--cgroup-parent",
        "openshell.slice",
        "--cgroupns",
        "private",
        "--userns",
        "host",
        "--uts",
        "private",
        "--log-driver",
        "local",
        "--log-opt",
        "max-size=10m",
        "--dns-option",
        "ndots:1",
      ]),
    );
  });

  it.each([
    {
      name: "an ephemeral published port",
      mutate: (inspect: ReturnType<typeof inspectFixture>) => {
        inspect.HostConfig!.PortBindings = {
          "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
        };
      },
      error: /exact assigned host port/u,
    },
    {
      name: "an ambiguous IPv6 scope",
      mutate: (inspect: ReturnType<typeof inspectFixture>) => {
        inspect.HostConfig!.PortBindings = {
          "8080/tcp": [{ HostIp: "fe80::1%lo0", HostPort: "18080" }],
        };
      },
      error: /invalid or ambiguous/u,
    },
    {
      name: "a non-CDI device request",
      mutate: (inspect: ReturnType<typeof inspectFixture>) => {
        inspect.HostConfig!.DeviceRequests = [
          {
            Driver: "nvidia",
            Count: -1,
            DeviceIDs: null,
            Capabilities: [["gpu"]],
            Options: null,
          },
        ];
      },
      error: /cannot be reproduced exactly/u,
    },
  ])("fails closed rather than dropping $name", ({ mutate, error }) => {
    const inspect = inspectFixture();
    mutate(inspect);
    expect(() =>
      buildDockerGpuCloneRunArgs(inspect, buildDockerGpuMode("startup-command")),
    ).toThrow(error);
  });
});

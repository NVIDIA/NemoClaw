// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createDockerGpuInspectFixture } from "../__test-helpers__/docker-gpu-patch-fixtures";
import {
  normalizeDockerManagedBootstrapLaunchSpec,
  parseDockerManagedBootstrapLaunchSpec,
} from "./docker-spec";

describe("managed bootstrap Docker launch spec", () => {
  it("hashes reproducible launch state while excluding runtime ID, phase, IP, and gateway", () => {
    const first = createDockerGpuInspectFixture();
    first.Id = "a".repeat(64);
    first.Mounts = [
      {
        Type: "image",
        Source: "ghcr.io/nvidia/openshell/sandbox:v0.0.106",
        Destination: "/opt/openshell/bin",
        RW: false,
      },
    ];
    first.HostConfig!.Binds = [
      ...first.HostConfig!.Binds!,
      "/run/podman/old/merge:/opt/openshell/bin:lowerdir=/run/podman/old/lower,private",
    ];
    first.HostConfig!.PidMode = "private";
    first.HostConfig!.PidsLimit = 2048;
    first.HostConfig!.CpuPeriod = 100_000;
    first.HostConfig!.CpuQuota = 250_000;
    first.HostConfig!.NetworkMode = "bridge";
    first.HostConfig!.Annotations = { "io.container.manager": "libpod" };
    first.HostConfig!.OomScoreAdj = 0;
    first.HostConfig!.Tmpfs = {
      "/run/netns": "rw,nosuid,nodev,rprivate,tmpcopyup",
    };
    first.NetworkSettings!.Networks!["openshell-docker"]!.Aliases = [
      first.Id.slice(0, 12),
      "openshell-alpha",
    ];
    const second = structuredClone(first);
    second.Id = "b".repeat(64);
    second.HostConfig!.Binds = second.HostConfig!.Binds!.map((bind) =>
      bind.includes("/opt/openshell/bin")
        ? "/run/podman/new/merge:/opt/openshell/bin:lowerdir=/run/podman/new/lower,private"
        : bind,
    );
    Object.assign(second, { State: { Running: false, Dead: true } });
    second.HostConfig!.Annotations = {
      ...second.HostConfig!.Annotations,
      "io.podman.annotations.pids-limit": "2048",
    };
    second.HostConfig!.Tmpfs = {};
    second.HostConfig!.OomScoreAdj = 500;
    second.NetworkSettings!.Networks!["openshell-docker"]!.IPAddress = "172.18.0.99";
    second.NetworkSettings!.Networks!["openshell-docker"]!.Gateway = "172.18.0.254";
    second.NetworkSettings!.Networks!["openshell-docker"]!.Aliases = [
      second.Id.slice(0, 12),
      "openshell-alpha",
      "openshell-alpha",
    ];

    const expected = normalizeDockerManagedBootstrapLaunchSpec(first);
    const observed = normalizeDockerManagedBootstrapLaunchSpec(second);

    expect(observed.hash).toBe(expected.hash);
    expect(observed.canonicalJson).toBe(expected.canonicalJson);
    expect(expected.spec.inspect.HostConfig?.Binds).not.toContainEqual(
      expect.stringContaining("/opt/openshell/bin"),
    );
    expect(expected.spec.inspect.HostConfig?.Mounts).toContainEqual({
      Type: "image",
      Source: "ghcr.io/nvidia/openshell/sandbox:v0.0.106",
      Target: "/opt/openshell/bin",
      ReadOnly: true,
    });
    expect(expected.spec.inspect.HostConfig?.PidMode).toBe("");
    expect(expected.spec.inspect.HostConfig?.CpuPeriod).toBe(0);
    expect(expected.spec.inspect.HostConfig?.CpuQuota).toBe(0);
    expect(expected.spec.inspect.HostConfig?.NetworkMode).toBe("openshell-docker");
    expect(expected.spec.inspect.HostConfig?.Tmpfs).toEqual({});
    expect(expected.spec.inspect.NetworkSettings?.Networks?.["openshell-docker"]?.Aliases).toEqual([
      "openshell-alpha",
    ]);
    expect(parseDockerManagedBootstrapLaunchSpec(expected.canonicalJson)).toEqual(expected.spec);
  });

  it("changes the hash when a reproducible launch field changes", () => {
    const first = createDockerGpuInspectFixture();
    const second = structuredClone(first);
    Object.assign(second.Config!, { StopTimeout: 45 });
    const annotated = structuredClone(first);
    annotated.HostConfig!.Annotations = { "io.container.manager": "libpod" };

    expect(normalizeDockerManagedBootstrapLaunchSpec(second).hash).not.toBe(
      normalizeDockerManagedBootstrapLaunchSpec(first).hash,
    );
    expect(normalizeDockerManagedBootstrapLaunchSpec(annotated).hash).not.toBe(
      normalizeDockerManagedBootstrapLaunchSpec(first).hash,
    );
  });

  it("hash-binds Docker-derived console and protected-path defaults", () => {
    const first = createDockerGpuInspectFixture();
    Object.assign(first.HostConfig!, {
      ConsoleSize: [0, 0],
      MaskedPaths: ["/proc/kcore", "/sys/firmware"],
      ReadonlyPaths: ["/proc/sys", "/proc/sysrq-trigger"],
    });
    const reordered = structuredClone(first);
    reordered.HostConfig!.MaskedPaths = ["/sys/firmware", "/proc/kcore"];
    reordered.HostConfig!.ReadonlyPaths = ["/proc/sysrq-trigger", "/proc/sys"];
    const changed = structuredClone(first);
    changed.HostConfig!.MaskedPaths = ["/proc/kcore"];

    const expected = normalizeDockerManagedBootstrapLaunchSpec(first);
    const sameSet = normalizeDockerManagedBootstrapLaunchSpec(reordered);
    const observed = normalizeDockerManagedBootstrapLaunchSpec(changed);

    expect(expected.spec.inspect.HostConfig).toMatchObject({
      ConsoleSize: [0, 0],
      MaskedPaths: ["/proc/kcore", "/sys/firmware"],
      ReadonlyPaths: ["/proc/sys", "/proc/sysrq-trigger"],
    });
    expect(sameSet.hash).toBe(expected.hash);
    expect(observed.hash).not.toBe(expected.hash);
  });

  it("excludes Docker client attachment metadata while preserving durable stdin state", () => {
    const first = createDockerGpuInspectFixture();
    Object.assign(first.Config!, {
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      OpenStdin: false,
    });
    const second = structuredClone(first);
    Object.assign(second.Config!, {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    });
    const changed = structuredClone(first);
    Object.assign(changed.Config!, { OpenStdin: true });

    const expected = normalizeDockerManagedBootstrapLaunchSpec(first);
    const observed = normalizeDockerManagedBootstrapLaunchSpec(second);

    expect(expected.spec.inspect.Config).not.toHaveProperty("AttachStdin");
    expect(expected.spec.inspect.Config).not.toHaveProperty("AttachStdout");
    expect(expected.spec.inspect.Config).not.toHaveProperty("AttachStderr");
    expect(observed.hash).toBe(expected.hash);
    expect(normalizeDockerManagedBootstrapLaunchSpec(changed).hash).not.toBe(expected.hash);
  });

  it("canonicalizes absent Docker port bindings without hiding active bindings", () => {
    const apiInspect = createDockerGpuInspectFixture();
    Object.assign(apiInspect.HostConfig!, { PortBindings: null });
    const cliInspect = structuredClone(apiInspect);
    Object.assign(cliInspect.HostConfig!, { PortBindings: {} });
    const active = structuredClone(apiInspect);
    Object.assign(active.HostConfig!, {
      PortBindings: {
        "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "18080" }],
      },
    });

    const expected = normalizeDockerManagedBootstrapLaunchSpec(apiInspect);
    const observed = normalizeDockerManagedBootstrapLaunchSpec(cliInspect);

    expect(expected.spec.inspect.HostConfig).toMatchObject({
      PortBindings: {},
    });
    expect(observed.hash).toBe(expected.hash);
    expect(normalizeDockerManagedBootstrapLaunchSpec(active).hash).not.toBe(expected.hash);
  });

  it("canonicalizes explicitly reported Docker-default tmpfs options", () => {
    const explicitDefaults = createDockerGpuInspectFixture();
    explicitDefaults.HostConfig!.Mounts = [
      {
        Type: "tmpfs",
        Target: "/run/nemoclaw-dcode-mcp",
        TmpfsOptions: {
          SizeBytes: 1_048_576,
          Mode: 0o1777,
          Options: [["noexec"]],
        },
      },
    ];
    const omittedDefaults = structuredClone(explicitDefaults);
    delete omittedDefaults.HostConfig!.Mounts![0]!.TmpfsOptions!.Options;

    const expected = normalizeDockerManagedBootstrapLaunchSpec(explicitDefaults);
    const observed = normalizeDockerManagedBootstrapLaunchSpec(omittedDefaults);

    expect(expected.spec.inspect.HostConfig?.Mounts?.[0]?.TmpfsOptions).toEqual({
      SizeBytes: 1_048_576,
      Mode: 0o1777,
    });
    expect(observed.hash).toBe(expected.hash);
  });

  it("keeps non-default tmpfs options hash-bound", () => {
    const expected = createDockerGpuInspectFixture();
    expected.HostConfig!.Mounts = [
      {
        Type: "tmpfs",
        Target: "/run/nemoclaw-dcode-mcp",
        TmpfsOptions: { Options: [["exec"]] },
      },
    ];
    const observed = structuredClone(expected);
    delete observed.HostConfig!.Mounts![0]!.TmpfsOptions!.Options;

    expect(normalizeDockerManagedBootstrapLaunchSpec(observed).hash).not.toBe(
      normalizeDockerManagedBootstrapLaunchSpec(expected).hash,
    );
  });

  it("canonicalizes Docker API and CLI host-list representations", () => {
    const apiInspect = createDockerGpuInspectFixture();
    Object.assign(apiInspect.HostConfig!, {
      Binds: ["/host/a:/sandbox/a:ro", "/host/b:/sandbox/b:ro"],
      BlkioDeviceReadBps: null,
      BlkioDeviceReadIOps: null,
      BlkioDeviceWriteBps: null,
      BlkioDeviceWriteIOps: null,
      BlkioWeightDevice: null,
      CapAdd: ["NET_ADMIN", "SYS_ADMIN"],
      CapDrop: ["NET_RAW"],
      Devices: null,
      DnsOptions: null,
      DnsSearch: null,
      OomKillDisable: null,
      Ulimits: null,
    });
    const cliInspect = structuredClone(apiInspect);
    Object.assign(cliInspect.Config!, {
      ArgsEscaped: false,
      MacAddress: "",
      OnBuild: null,
      Shell: null,
      Volumes: null,
    });
    Object.assign(cliInspect.HostConfig!, {
      Binds: ["/host/b:/sandbox/b:ro", "/host/a:/sandbox/a:ro"],
      BlkioDeviceReadBps: [],
      BlkioDeviceReadIOps: [],
      BlkioDeviceWriteBps: [],
      BlkioDeviceWriteIOps: [],
      BlkioWeightDevice: [],
      CapAdd: ["CAP_SYS_ADMIN", "CAP_NET_ADMIN"],
      CapDrop: ["CAP_NET_RAW"],
      Devices: [],
      DnsOptions: [],
      DnsSearch: [],
      OomKillDisable: false,
      MaskedPaths: ["/sys/firmware", "/proc/kcore"],
      ReadonlyPaths: ["/proc/sysrq-trigger", "/proc/sys"],
      Ulimits: [],
    });
    Object.assign(apiInspect.HostConfig!, {
      MaskedPaths: ["/proc/kcore", "/sys/firmware"],
      ReadonlyPaths: ["/proc/sys", "/proc/sysrq-trigger"],
    });

    const expected = normalizeDockerManagedBootstrapLaunchSpec(apiInspect);
    const observed = normalizeDockerManagedBootstrapLaunchSpec(cliInspect);

    expect(observed.canonicalJson).toBe(expected.canonicalJson);
    expect(observed.hash).toBe(expected.hash);
  });

  it("orders durable launch keys by code unit across host locale settings", () => {
    const inspect = createDockerGpuInspectFixture();
    inspect.Config!.Labels = {
      "com.nvidia.foo": "lower",
      "com.nvidia.Foo": "upper",
      "com.nvidia-foo": "punctuation",
    };

    const canonical = normalizeDockerManagedBootstrapLaunchSpec(inspect).canonicalJson;

    expect(canonical.indexOf('"com.nvidia-foo"')).toBeLessThan(
      canonical.indexOf('"com.nvidia.Foo"'),
    );
    expect(canonical.indexOf('"com.nvidia.Foo"')).toBeLessThan(
      canonical.indexOf('"com.nvidia.foo"'),
    );
  });

  it("detaches and deeply freezes canonical launch state at the hashed boundary", () => {
    const inspect = createDockerGpuInspectFixture();
    const normalized = normalizeDockerManagedBootstrapLaunchSpec(inspect);
    const { canonicalJson, hash } = normalized;
    const config = normalized.spec.inspect.Config as Record<string, unknown>;
    const hostConfig = normalized.spec.inspect.HostConfig as Record<string, unknown>;
    const network = normalized.spec.inspect.NetworkSettings!.Networks!["openshell-docker"]!;

    expect(() => Object.assign(config, { StopTimeout: 999 })).toThrow(TypeError);
    expect(() => Object.assign(hostConfig, { Runtime: "mutated" })).toThrow(TypeError);
    expect(() => network.Aliases!.push("mutated")).toThrow(TypeError);

    Object.assign(inspect.Config!, { StopTimeout: 45 });
    Object.assign(inspect.HostConfig!, { Runtime: "mutated" });
    inspect.NetworkSettings!.Networks!["openshell-docker"]!.Aliases!.push("mutated");

    expect(normalized.spec.inspect.Config).not.toHaveProperty("StopTimeout");
    expect(normalized.spec.inspect.HostConfig).not.toHaveProperty("Runtime");
    expect(network.Aliases).toEqual(["openshell-alpha"]);
    expect(normalized.canonicalJson).toBe(`${JSON.stringify(normalized.spec)}\n`);
    expect(normalized.canonicalJson).toBe(canonicalJson);
    expect(normalized.hash).toBe(hash);
    expect(normalizeDockerManagedBootstrapLaunchSpec(inspect).hash).not.toBe(hash);
  });

  it.each([
    {
      name: "anonymous Config.Volumes whose data source cannot be proven",
      mutate: (inspect: ReturnType<typeof createDockerGpuInspectFixture>) => {
        Object.assign(inspect.Config!, { Volumes: { "/var/lib/state": {} } });
      },
      error: /config fields it cannot reproduce exactly: Volumes\./u,
    },
    {
      name: "multiple attached networks",
      mutate: (inspect: ReturnType<typeof createDockerGpuInspectFixture>) => {
        inspect.NetworkSettings!.Networks!.secondary = {
          Aliases: ["alpha-secondary"],
        };
      },
      error: /multiple attached networks/u,
    },
    {
      name: "an unknown HostConfig field",
      mutate: (inspect: ReturnType<typeof createDockerGpuInspectFixture>) => {
        (inspect.HostConfig as Record<string, unknown>).FutureRuntimeField = true;
      },
      error: /unsupported fields: FutureRuntimeField/u,
    },
  ])("fails closed for $name", ({ mutate, error }) => {
    const inspect = createDockerGpuInspectFixture();
    mutate(inspect);
    expect(() => normalizeDockerManagedBootstrapLaunchSpec(inspect)).toThrow(error);
  });
});

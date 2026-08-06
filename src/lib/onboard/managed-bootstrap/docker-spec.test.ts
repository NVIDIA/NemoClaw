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
    const second = structuredClone(first);
    second.Id = "another-runtime-id";
    Object.assign(second, { State: { Running: false, Dead: true } });
    second.NetworkSettings!.Networks!["openshell-docker"]!.IPAddress = "172.18.0.99";
    second.NetworkSettings!.Networks!["openshell-docker"]!.Gateway = "172.18.0.254";

    const expected = normalizeDockerManagedBootstrapLaunchSpec(first);
    const observed = normalizeDockerManagedBootstrapLaunchSpec(second);

    expect(observed.hash).toBe(expected.hash);
    expect(observed.canonicalJson).toBe(expected.canonicalJson);
    expect(parseDockerManagedBootstrapLaunchSpec(expected.canonicalJson)).toEqual(expected.spec);
  });

  it("changes the hash when a reproducible launch field changes", () => {
    const first = createDockerGpuInspectFixture();
    const second = structuredClone(first);
    Object.assign(second.Config!, { StopTimeout: 45 });

    expect(normalizeDockerManagedBootstrapLaunchSpec(second).hash).not.toBe(
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

  it("hash-binds reproducible Docker attach streams", () => {
    const first = createDockerGpuInspectFixture();
    Object.assign(first.Config!, { AttachStdout: true, AttachStderr: true });
    const second = structuredClone(first);
    Object.assign(second.Config!, { AttachStderr: false });

    const expected = normalizeDockerManagedBootstrapLaunchSpec(first);
    const observed = normalizeDockerManagedBootstrapLaunchSpec(second);

    expect(expected.spec.inspect.Config).toMatchObject({
      AttachStdout: true,
      AttachStderr: true,
    });
    expect(observed.hash).not.toBe(expected.hash);
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

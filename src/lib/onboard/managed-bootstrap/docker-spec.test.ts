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
        inspect.NetworkSettings!.Networks!.secondary = { Aliases: ["alpha-secondary"] };
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

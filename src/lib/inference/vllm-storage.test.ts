// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findUnwritableTreePath,
  formatStorageBytes,
  imageStorageRequirementBytes,
  measureDirectorySizeBytes,
  modelStorageRequirementBytes,
  probeDockerStorage,
  probeHostStorage,
  resolveDockerStorageLocations,
} from "./vllm-storage";

const GIB = 1024n ** 3n;

function nativeDockerInfo(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ClientInfo: { Context: "default" },
    DockerRootDir: "/var/lib/docker",
    Driver: "overlay2",
    DriverStatus: [],
    OSType: "linux",
    SecurityOptions: [],
    ...overrides,
  });
}

const nativeHost = {
  dockerContext: undefined,
  dockerHost: undefined,
  platform: "linux" as NodeJS.Platform,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("managed vLLM image-storage requirements", () => {
  it("reserves compressed, unpacked, and staging space for an image pull (#6757)", () => {
    expect(imageStorageRequirementBytes(1_000_000_000)).toBe(3_000_000_000n + 3n * GIB);
    expect(() => imageStorageRequirementBytes(0)).toThrow(
      "vLLM image download size must be a positive finite byte count",
    );
  });

  it("reserves the pinned snapshot plus staging space for a model download", () => {
    expect(modelStorageRequirementBytes(352_381_245_521)).toBe(352_381_245_521n + 3n * GIB);
    expect(() => modelStorageRequirementBytes(0)).toThrow(
      "vLLM model download size must be a positive finite byte count",
    );
  });

  it("formats available and required bytes as rounded GiB values", () => {
    expect(formatStorageBytes(2n * GIB)).toBe("2 GiB");
    expect(formatStorageBytes((23n * GIB) / 10n)).toBe("2.3 GiB");
  });
});

describe("host cache-storage detection", () => {
  it("finds an unwritable root-created cache directory", () => {
    expect(
      findUnwritableTreePath("/home/user/.cache/huggingface", {
        canWrite: (target) => target !== "/home/user/.cache/huggingface",
        list: () => [],
      }),
    ).toBe("/home/user/.cache/huggingface");
  });

  it("finds root-owned descendants before a host-UID download", () => {
    const entries = new Map([
      [
        "/cache",
        [
          { kind: "directory" as const, name: "hub" },
          { kind: "file" as const, name: "version.txt" },
        ],
      ],
      ["/cache/hub", [{ kind: "file" as const, name: "root-owned-blob" }]],
    ]);
    const checked: string[] = [];

    expect(
      findUnwritableTreePath("/cache", {
        canWrite: (target) => {
          checked.push(target);
          return target !== "/cache/hub/root-owned-blob";
        },
        list: (target) => entries.get(target) ?? [],
      }),
    ).toBe("/cache/hub/root-owned-blob");
    expect(checked).toEqual(expect.arrayContaining(["/cache", "/cache/version.txt", "/cache/hub"]));
  });

  it("accepts a writable cache tree", () => {
    expect(
      findUnwritableTreePath("/cache", {
        canWrite: () => true,
        list: () => [],
      }),
    ).toBeNull();
  });

  it("counts complete and partial snapshot files without following directory symlinks", () => {
    const entries = new Map([
      [
        "/cache/snapshot",
        [
          { kind: "file" as const, name: "config.json" },
          { kind: "directory" as const, name: "weights" },
          { kind: "symlink" as const, name: "tokenizer.json" },
          { kind: "symlink" as const, name: "directory-link" },
        ],
      ],
      ["/cache/snapshot/weights", [{ kind: "symlink" as const, name: "model-00001.safetensors" }]],
    ]);
    const sizes = new Map([
      ["/cache/snapshot/config.json", 100n],
      ["/cache/snapshot/tokenizer.json", 200n],
      ["/cache/snapshot/weights/model-00001.safetensors", 1_000n],
      ["/cache/snapshot/directory-link", null],
    ]);

    expect(
      measureDirectorySizeBytes("/cache/snapshot", {
        exists: () => true,
        list: (target) => entries.get(target) ?? [],
        statFileSize: (target) => sizes.get(target) ?? null,
      }),
    ).toBe(1_300n);
  });

  it("treats a missing or unreadable snapshot as uncached", () => {
    expect(
      measureDirectorySizeBytes("/cache/missing", {
        exists: () => false,
      }),
    ).toBe(0n);
    expect(
      measureDirectorySizeBytes("/cache/interrupted", {
        exists: () => true,
        list: () => {
          throw new Error("broken link");
        },
      }),
    ).toBe(0n);
  });

  it("measures the filesystem containing an existing cache directory", () => {
    const statfs = vi.fn(() => ({ bavail: 400n, bsize: GIB }));

    expect(
      probeHostStorage("/home/user/.cache/huggingface", "Hugging Face cache", {
        exists: () => true,
        statfs,
      }),
    ).toEqual({
      ok: true,
      capacity: {
        availableBytes: 400n * GIB,
        path: "/home/user/.cache/huggingface",
        source: "Hugging Face cache",
      },
    });
    expect(statfs).toHaveBeenCalledWith("/home/user/.cache/huggingface");
  });

  it("measures the nearest existing ancestor before a first cache download", () => {
    const statfs = vi.fn(() => ({ bavail: 500n, bsize: GIB }));

    expect(
      probeHostStorage("/home/user/.cache/huggingface", "Hugging Face cache", {
        exists: (target) => target === "/home/user",
        statfs,
      }),
    ).toEqual({
      ok: true,
      capacity: {
        availableBytes: 500n * GIB,
        path: "/home/user/.cache/huggingface",
        source: "Hugging Face cache",
      },
    });
    expect(statfs).toHaveBeenCalledWith("/home/user");
  });

  it("reports an inconclusive host probe without creating the cache path", () => {
    expect(
      probeHostStorage("/mnt/models/huggingface", "Hugging Face cache", {
        exists: (target) => target === "/mnt",
        statfs: () => {
          throw new Error("mount unavailable");
        },
      }),
    ).toEqual({
      ok: false,
      reason: "could not inspect /mnt: mount unavailable",
      path: "/mnt/models/huggingface",
      source: "Hugging Face cache",
    });
  });
});

describe("Docker image-storage detection", () => {
  it("measures DockerRootDir for the classic image store (#6757)", () => {
    const statfs = vi.fn(() => ({ bavail: 7n, bsize: GIB }));

    expect(
      probeDockerStorage({
        ...nativeHost,
        dockerInfo: () => nativeDockerInfo(),
        statfs,
      }),
    ).toEqual({
      ok: true,
      capacity: {
        availableBytes: 7n * GIB,
        path: "/var/lib/docker",
        source: "Docker root directory",
      },
    });
    expect(statfs).toHaveBeenCalledWith("/var/lib/docker");
  });

  it("checks both the configured containerd root and Docker pull staging (#6757)", () => {
    const statfs = vi.fn((target: string) => ({
      bavail: target === "/var/lib/docker" ? 2n : 40n,
      bsize: GIB,
    }));

    expect(
      probeDockerStorage({
        ...nativeHost,
        dockerInfo: () =>
          nativeDockerInfo({
            Driver: "overlayfs",
            DriverStatus: [["driver-type", "io.containerd.snapshotter.v1"]],
          }),
        exists: (target) => target === "/etc/containerd/config.toml",
        readFile: () => 'root = "/mnt/containerd"',
        statfs,
      }),
    ).toEqual({
      ok: true,
      capacity: {
        availableBytes: 2n * GIB,
        path: "/var/lib/docker",
        source: "Docker pull staging",
      },
    });
    expect(statfs).toHaveBeenCalledWith("/mnt/containerd");
    expect(statfs).toHaveBeenCalledWith("/var/lib/docker");
  });

  it("uses the documented containerd root when no config file exists (#6757)", () => {
    expect(
      resolveDockerStorageLocations(
        nativeDockerInfo({
          Driver: "overlayfs",
          DriverStatus: [["driver-type", "io.containerd.snapshotter.v1"]],
        }),
        { ...nativeHost, exists: () => false },
      ),
    ).toEqual({
      ok: true,
      locations: [
        { path: "/var/lib/containerd", source: "containerd image store" },
        { path: "/var/lib/docker", source: "Docker pull staging" },
      ],
    });
  });

  it.each([
    "/var/run/docker.sock",
    "unix:///var/run/docker.sock",
    "/run/docker.sock",
    "unix:///run/docker.sock",
  ])("measures storage through the local Docker socket %s (#6858)", (dockerHost) => {
    const statfs = vi.fn(() => ({ bavail: 9n, bsize: GIB }));

    expect(
      probeDockerStorage({
        ...nativeHost,
        dockerHost,
        dockerInfo: () => nativeDockerInfo(),
        statfs,
      }),
    ).toEqual({
      ok: true,
      capacity: {
        availableBytes: 9n * GIB,
        path: "/var/lib/docker",
        source: "Docker root directory",
      },
    });
    expect(statfs).toHaveBeenCalledWith("/var/lib/docker");
  });

  it("returns an inconclusive result for remote Docker endpoints (#6757)", () => {
    expect(
      resolveDockerStorageLocations(nativeDockerInfo(), {
        ...nativeHost,
        dockerHost: "ssh://builder.example.test",
      }),
    ).toEqual({
      ok: false,
      reason: "Docker uses a remote endpoint (ssh://builder.example.test)",
    });
  });

  it("honors a named DOCKER_CONTEXT over DOCKER_HOST (#6757)", () => {
    expect(
      resolveDockerStorageLocations(nativeDockerInfo(), {
        ...nativeHost,
        dockerContext: "remote-builder",
        dockerHost: "unix:///run/docker.sock",
      }),
    ).toEqual({
      ok: false,
      reason:
        "Docker uses a named context (remote-builder) whose host filesystem cannot be inspected",
    });
  });

  it("honors an explicit default DOCKER_CONTEXT over a remote DOCKER_HOST (#6757)", () => {
    expect(
      resolveDockerStorageLocations(nativeDockerInfo(), {
        ...nativeHost,
        dockerContext: "default",
        dockerHost: "ssh://builder.example.test",
      }),
    ).toEqual({
      ok: true,
      locations: [{ path: "/var/lib/docker", source: "Docker root directory" }],
    });
  });

  it("returns an inconclusive result for a named Docker context (#6757)", () => {
    expect(
      resolveDockerStorageLocations(
        nativeDockerInfo({ ClientInfo: { Context: "remote-builder" } }),
        nativeHost,
      ),
    ).toEqual({
      ok: false,
      reason:
        "Docker uses a named context (remote-builder) whose host filesystem cannot be inspected",
    });
  });

  it("returns an inconclusive result outside a native Linux engine (#6757)", () => {
    expect(
      resolveDockerStorageLocations(nativeDockerInfo(), {
        ...nativeHost,
        platform: "darwin",
      }),
    ).toEqual({ ok: false, reason: "Docker runs behind a darwin host boundary" });
    expect(
      resolveDockerStorageLocations(nativeDockerInfo({ OSType: "windows" }), nativeHost),
    ).toEqual({ ok: false, reason: "Docker is not using a Linux engine" });
  });

  it("returns an inconclusive result for an ambiguous image-storage driver (#6757)", () => {
    expect(
      resolveDockerStorageLocations(
        nativeDockerInfo({
          Driver: "overlayfs",
          DriverStatus: [["note", "io.containerd.snapshotter.v1"]],
        }),
        nativeHost,
      ),
    ).toEqual({
      ok: false,
      reason: "docker reported ambiguous image-storage driver overlayfs",
    });
  });

  it("does not guess a containerd root when configuration can override it (#6757)", () => {
    const containerdInfo = nativeDockerInfo({
      Driver: "overlayfs",
      DriverStatus: [["driver-type", "io.containerd.snapshotter.v1"]],
    });

    expect(
      resolveDockerStorageLocations(containerdInfo, {
        ...nativeHost,
        exists: (target) => target === "/etc/containerd/config.toml",
        readFile: () => 'root = "/mnt/containerd"\nimports = ["/etc/containerd/conf.d/*.toml"]',
      }),
    ).toEqual({
      ok: false,
      reason: "containerd config imports other files that can override its image-store root",
    });
    expect(
      resolveDockerStorageLocations(containerdInfo, {
        ...nativeHost,
        exists: (target) => target === "/etc/containerd/config.toml",
        readFile: () => {
          throw new Error("permission denied");
        },
      }),
    ).toEqual({
      ok: false,
      reason: "could not read /etc/containerd/config.toml: permission denied",
    });
  });

  it("returns an inconclusive result for rootless containerd (#6757)", () => {
    expect(
      resolveDockerStorageLocations(
        nativeDockerInfo({
          Driver: "overlayfs",
          DriverStatus: [["driver-type", "io.containerd.snapshotter.v1"]],
          SecurityOptions: ["name=rootless"],
        }),
        nativeHost,
      ),
    ).toEqual({
      ok: false,
      reason:
        "rootless Docker detected; managed vLLM cannot inspect the containerd image-store location",
    });
  });

  it("surfaces filesystem inspection failures without reporting low capacity (#6757)", () => {
    expect(
      probeDockerStorage({
        ...nativeHost,
        dockerInfo: () => nativeDockerInfo(),
        statfs: () => {
          throw new Error("permission denied");
        },
      }),
    ).toEqual({
      ok: false,
      path: "/var/lib/docker",
      reason: "could not inspect /var/lib/docker: permission denied",
      source: "Docker root directory",
    });
  });

  it("reads the Docker selection when each capacity probe starts (#6757)", () => {
    vi.stubEnv("DOCKER_CONTEXT", "remote-builder");
    vi.stubEnv("DOCKER_HOST", "");

    expect(
      probeDockerStorage({
        dockerInfo: () => nativeDockerInfo(),
        platform: "linux",
      }),
    ).toEqual({
      ok: false,
      reason:
        "Docker uses a named context (remote-builder) whose host filesystem cannot be inspected",
    });
  });
});

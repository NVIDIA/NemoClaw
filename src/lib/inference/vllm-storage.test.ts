// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dockerSocketPeerSharesMountNamespace,
  formatStorageBytes,
  imageStorageRequirementBytes,
  modelStorageRequirementBytes,
  probeDockerBindIdentity,
  probeDockerHostLocality,
  probeDockerStorage,
  probeModelCacheStorage,
  resolveDockerStorageLocations,
} from "./vllm-storage";

const GIB = 1024n ** 3n;
const tempDirs: string[] = [];

function nativeDockerInfo(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ClientInfo: { Context: "default" },
    DockerRootDir: "/var/lib/docker",
    Driver: "overlay2",
    DriverStatus: [],
    Name: "dgx-station",
    OperatingSystem: "Ubuntu 24.04",
    OSType: "linux",
    SecurityOptions: [],
    ...overrides,
  });
}

const nativeHost = {
  clientContainerized: false,
  dockerContext: undefined,
  dockerHost: undefined,
  osRelease: "6.8.0-generic",
  platform: "linux" as NodeJS.Platform,
  dockerSocketPeerSharesMountNamespace: () => true,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
});

describe("managed vLLM storage requirements", () => {
  it("reserves compressed, unpacked, and staging space for an image pull (#6757)", () => {
    expect(imageStorageRequirementBytes(1_000_000_000)).toBe(3_000_000_000n + 3n * GIB);
  });

  it("requires the full model size plus temporary-file headroom (#6757)", () => {
    expect(modelStorageRequirementBytes(Number(10n * GIB))).toBe(12n * GIB);
  });

  it("formats available and required bytes as rounded GiB values", () => {
    expect(formatStorageBytes(2n * GIB)).toBe("2 GiB");
    expect(formatStorageBytes((23n * GIB) / 10n)).toBe("2.3 GiB");
  });
});

describe("Docker image-storage detection", () => {
  it("uses DockerRootDir for the classic image store (#6757)", () => {
    expect(resolveDockerStorageLocations(nativeDockerInfo(), nativeHost)).toEqual({
      ok: true,
      locations: [{ path: "/var/lib/docker", source: "Docker root directory" }],
    });
  });

  it("checks both the configured containerd root and Docker pull staging (#6757)", () => {
    const statfs = vi.fn((target: string) => ({
      bavail: target === "/var/lib/docker" ? 2n : 40n,
      bsize: GIB,
    }));
    const result = probeDockerStorage({
      ...nativeHost,
      dockerInfo: () =>
        nativeDockerInfo({
          Driver: "overlayfs",
          DriverStatus: [["driver-type", "io.containerd.snapshotter.v1"]],
        }),
      exists: (target) => target === "/etc/containerd/config.toml",
      readFile: () => 'root = "/mnt/containerd"',
      statfs,
    });

    expect(result).toEqual({
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
    const result = resolveDockerStorageLocations(
      nativeDockerInfo({
        Driver: "overlayfs",
        DriverStatus: [["driver-type", "io.containerd.snapshotter.v1"]],
      }),
      { ...nativeHost, exists: () => false },
    );

    expect(result).toEqual({
      ok: true,
      locations: [
        { path: "/var/lib/containerd", source: "containerd image store" },
        { path: "/var/lib/docker", source: "Docker pull staging" },
      ],
    });
  });

  it("fails closed for overlayfs without the exact containerd marker (#6757)", () => {
    const result = resolveDockerStorageLocations(
      nativeDockerInfo({
        Driver: "overlayfs",
        DriverStatus: [["note", "io.containerd.snapshotter.v1"]],
      }),
      nativeHost,
    );

    expect(result).toEqual({
      ok: false,
      reason: "docker reported ambiguous image-storage driver overlayfs",
    });
  });

  it("fails closed when containerd imports can override the configured root (#6757)", () => {
    const result = resolveDockerStorageLocations(
      nativeDockerInfo({
        Driver: "overlayfs",
        DriverStatus: [["driver-type", "io.containerd.snapshotter.v1"]],
      }),
      {
        ...nativeHost,
        exists: (target) => target === "/etc/containerd/config.toml",
        readFile: () => 'root = "/mnt/containerd"\nimports = ["/etc/containerd/conf.d/*.toml"]',
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: "containerd config imports other files that can override its image-store root",
    });
  });

  it("fails closed with an actionable reason for rootless containerd (#6757)", () => {
    const result = resolveDockerStorageLocations(
      nativeDockerInfo({
        Driver: "overlayfs",
        DriverStatus: [["driver-type", "io.containerd.snapshotter.v1"]],
        SecurityOptions: ["name=rootless"],
      }),
      nativeHost,
    );

    expect(result).toEqual({
      ok: false,
      reason:
        "rootless Docker detected; managed vLLM cannot verify the containerd image-store location",
    });
  });

  it("returns an inconclusive result for remote Docker contexts (#6757)", () => {
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

  it("honors DOCKER_HOST precedence over DOCKER_CONTEXT (#6757)", () => {
    expect(
      resolveDockerStorageLocations(nativeDockerInfo(), {
        ...nativeHost,
        dockerContext: "default",
        dockerHost: "ssh://builder.example.test",
      }),
    ).toEqual({
      ok: false,
      reason: "Docker uses a remote endpoint (ssh://builder.example.test)",
    });
  });

  it("ignores a named DOCKER_CONTEXT when DOCKER_HOST selects a local socket (#6757)", () => {
    expect(
      resolveDockerStorageLocations(nativeDockerInfo(), {
        ...nativeHost,
        dockerContext: "remote-builder",
        dockerHost: "unix:///var/run/docker.sock",
      }),
    ).toEqual({
      ok: true,
      locations: [{ path: "/var/lib/docker", source: "Docker root directory" }],
    });
  });

  it("fails closed for a named Docker context whose filesystem is not local (#6757)", () => {
    expect(
      resolveDockerStorageLocations(
        nativeDockerInfo({ ClientInfo: { Context: "remote-builder" } }),
        nativeHost,
      ),
    ).toEqual({
      ok: false,
      reason:
        "Docker uses a named context (remote-builder) whose host filesystem cannot be verified",
    });
  });

  it.each([
    {
      boundary: "non-Linux host",
      expected: "Docker runs behind a darwin host boundary",
      info: nativeDockerInfo(),
      overrides: { ...nativeHost, platform: "darwin" as NodeJS.Platform },
    },
    {
      boundary: "WSL kernel",
      expected: "Docker runs behind a WSL host boundary",
      info: nativeDockerInfo(),
      overrides: { ...nativeHost, osRelease: "5.15.153.1-microsoft-standard-WSL2" },
    },
    {
      boundary: "Docker Desktop VM",
      expected: "Docker runs inside a VM or compatibility layer",
      info: nativeDockerInfo({ OperatingSystem: "Docker Desktop" }),
      overrides: nativeHost,
    },
    {
      boundary: "Colima VM",
      expected: "Docker runs inside a VM or compatibility layer",
      info: nativeDockerInfo({ OperatingSystem: "Colima" }),
      overrides: nativeHost,
    },
    {
      boundary: "Podman compatibility layer",
      expected: "Docker runs inside a VM or compatibility layer",
      info: nativeDockerInfo({ OperatingSystem: "Podman Engine" }),
      overrides: nativeHost,
    },
  ])("fails closed across a $boundary (#6757)", ({ expected, info, overrides }) => {
    expect(resolveDockerStorageLocations(info, overrides)).toEqual({
      ok: false,
      reason: expected,
    });
  });

  it("checks Docker host locality without requiring image-store capacity (#6757)", () => {
    expect(
      probeDockerHostLocality({
        ...nativeHost,
        dockerInfo: () => nativeDockerInfo({ Driver: "unrecognized" }),
      }),
    ).toEqual({ ok: true });

    expect(
      probeDockerHostLocality({
        ...nativeHost,
        dockerHost: "ssh://builder.example.test",
        dockerInfo: () => nativeDockerInfo({ Driver: "unrecognized" }),
      }),
    ).toEqual({
      ok: false,
      reason: "Docker uses a remote endpoint (ssh://builder.example.test)",
    });
  });

  it("fails closed for a non-default Unix socket that can forward a remote daemon (#6757)", () => {
    vi.stubEnv("DOCKER_HOST", "unix:///tmp/forwarded-remote.sock");
    vi.stubEnv("DOCKER_CONTEXT", "default");

    expect(
      probeDockerHostLocality({
        clientContainerized: false,
        dockerInfo: () => nativeDockerInfo(),
        osRelease: nativeHost.osRelease,
        platform: nativeHost.platform,
        dockerSocketPeerSharesMountNamespace: () => true,
      }),
    ).toEqual({
      ok: false,
      reason:
        "Docker uses a non-default socket (unix:///tmp/forwarded-remote.sock) whose daemon host filesystem cannot be verified",
    });
  });

  it("fails closed when the default Docker socket is mounted into a client container (#6757)", () => {
    vi.stubEnv("DOCKER_HOST", "unix:///var/run/docker.sock");
    vi.stubEnv("DOCKER_CONTEXT", "default");
    vi.spyOn(fs, "existsSync").mockImplementation((target) => target === "/.dockerenv");

    expect(
      probeDockerHostLocality({
        dockerInfo: () => nativeDockerInfo(),
        osRelease: nativeHost.osRelease,
        platform: nativeHost.platform,
      }),
    ).toEqual({
      ok: false,
      reason:
        "Docker client runs inside a container, so daemon bind-mount storage cannot be verified",
    });
  });

  it("classifies the Docker socket peer mount namespace without trusting procfs PID 1", () => {
    const capture = vi.fn(() => "shared\n");

    expect(dockerSocketPeerSharesMountNamespace("/var/run/docker.sock", capture, "linux")).toBe(
      true,
    );
    expect(capture).toHaveBeenCalledWith(
      expect.arrayContaining(["python3", "-I", "-c", "/var/run/docker.sock"]),
      { ignoreError: true, timeout: 5_000 },
    );
    capture.mockReturnValueOnce("different\n");
    expect(dockerSocketPeerSharesMountNamespace("/var/run/docker.sock", capture, "linux")).toBe(
      false,
    );
    capture.mockReturnValueOnce("unknown\n");
    expect(
      dockerSocketPeerSharesMountNamespace("/var/run/docker.sock", capture, "linux"),
    ).toBeNull();
  });

  it("fails closed when the Docker socket peer has a different mount namespace (#6757)", () => {
    expect(
      probeDockerHostLocality({
        ...nativeHost,
        dockerHost: "unix:///var/run/docker.sock",
        dockerInfo: () => nativeDockerInfo(),
        dockerSocketPeerSharesMountNamespace: () => false,
      }),
    ).toEqual({
      ok: false,
      reason:
        "Docker client and socket peer use different mount namespaces, so daemon filesystem identity cannot be verified",
    });
  });

  it("fails closed before statfs when a nested PID namespace hides the socket peer (#6757)", () => {
    const statfs = vi.fn(() => ({ bavail: 1_000n, bsize: GIB }));

    expect(
      probeDockerStorage({
        ...nativeHost,
        dockerHost: "unix:///var/run/docker.sock",
        dockerInfo: () => nativeDockerInfo(),
        dockerSocketPeerSharesMountNamespace: () => null,
        statfs,
      }),
    ).toEqual({
      ok: false,
      reason: "Docker socket peer PID or mount namespace could not be verified",
    });
    expect(statfs).not.toHaveBeenCalled();
  });

  it("reads the Docker selection when each storage probe starts (#6757)", () => {
    vi.stubEnv("DOCKER_CONTEXT", "remote-builder");
    vi.stubEnv("DOCKER_HOST", "");

    expect(
      probeDockerStorage({
        clientContainerized: false,
        dockerInfo: () => nativeDockerInfo(),
        osRelease: nativeHost.osRelease,
        platform: nativeHost.platform,
        dockerSocketPeerSharesMountNamespace: () => true,
      }),
    ).toEqual({
      ok: false,
      reason:
        "Docker uses a named context (remote-builder) whose host filesystem cannot be verified",
    });
  });

  it("does not fall back to DockerRootDir when containerd config is unreadable (#6757)", () => {
    const result = resolveDockerStorageLocations(
      nativeDockerInfo({
        Driver: "overlayfs",
        DriverStatus: [["driver-type", "io.containerd.snapshotter.v1"]],
      }),
      {
        ...nativeHost,
        exists: (target) => target === "/etc/containerd/config.toml",
        readFile: () => {
          throw new Error("permission denied");
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: "could not read /etc/containerd/config.toml: permission denied",
    });
  });
});

describe("Hugging Face model-cache storage", () => {
  it("proves Docker bind identity with a bounded read-only sentinel round trip (#6757)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vllm-bind-identity-"));
    tempDirs.push(root);
    const cacheDir = path.join(root, ".cache", "huggingface");
    const dockerReadBind = vi.fn((_image: string, sourcePath: string) => {
      const fd = fs.openSync(sourcePath, "r");
      try {
        expect(fs.fstatSync(fd).mode & 0o777).toBe(0o600);
        const token = fs.readFileSync(fd, "utf8");
        expect(sourcePath).not.toContain(token.slice("nemoclaw-storage-token:".length));
        return token;
      } finally {
        fs.closeSync(fd);
      }
    });

    expect(
      probeDockerBindIdentity(cacheDir, "example.test/vllm@sha256:pinned", {
        ...nativeHost,
        dockerInfo: () => nativeDockerInfo(),
        dockerReadBind,
      }),
    ).toEqual({ ok: true });
    expect(dockerReadBind).toHaveBeenCalledWith(
      "example.test/vllm@sha256:pinned",
      expect.stringMatching(/\.nemoclaw-storage-probe-/),
    );
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("fails closed when namespace-local PID 1 hides a private mount namespace (#6757)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vllm-bind-identity-"));
    tempDirs.push(root);

    expect(
      probeDockerBindIdentity(
        path.join(root, ".cache", "huggingface"),
        "example.test/vllm@sha256:pinned",
        {
          ...nativeHost,
          clientContainerized: false,
          dockerHost: "unix:///var/run/docker.sock",
          dockerInfo: () => nativeDockerInfo(),
          dockerReadBind: () => "",
        },
      ),
    ).toEqual({
      ok: false,
      reason:
        "Docker daemon could not read the client storage sentinel; bind-mount filesystem identity cannot be verified",
    });
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("checks the nearest existing filesystem before creating the cache directory (#6757)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vllm-storage-"));
    tempDirs.push(root);
    const cacheDir = path.join(root, ".cache", "huggingface");
    const statfs = vi.fn(() => ({ bavail: 7n, bsize: GIB }));

    expect(probeModelCacheStorage(cacheDir, { statfs })).toEqual({
      ok: true,
      capacity: {
        availableBytes: 7n * GIB,
        path: root,
        source: "model cache filesystem",
      },
    });
    expect(statfs).toHaveBeenCalledWith(root);
  });
});

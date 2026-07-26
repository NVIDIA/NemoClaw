// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
// Import source directly so tests cannot pass against a stale build.
import { assessHost } from "./preflight";

// Regression: NemoClaw #7320. On Apple Silicon macOS a Docker CLI routed to
// Podman's docker-compat socket reaches the forced Docker-driver gateway and
// exits EADDRNOTAVAIL binding Podman's VM-only bridge IP (10.89.1.1, from
// Podman's DefaultAddressPools base 10.89.0.0/16). Podman's docker-compat
// `/info` mimics Docker (no "podman" marker: ServerVersion "5.6.2",
// OperatingSystem "fedora", plus "docker" strings like DockerRootDir), so
// `docker info` alone misclassifies it as `docker`. `docker version` still
// names the "Podman Engine" component, which reclassifies it as unsupported so
// the preflight gate rejects it before any gateway launch.
//
// Fixtures below are trimmed from live captures on an Apple Silicon macOS host
// running `podman machine` behind `/var/run/docker.sock`.
const PODMAN_COMPAT_DOCKER_INFO = JSON.stringify({
  ServerVersion: "5.6.2",
  OperatingSystem: "fedora",
  OSType: "linux",
  Architecture: "arm64",
  Name: "localhost.localdomain",
  DefaultRuntime: "crun",
  ProductLicense: "Apache-2.0",
  DockerRootDir: "/var/lib/containers/storage",
  DefaultAddressPools: [{ Base: "10.89.0.0/16", Size: 24 }],
  ClientInfo: { Platform: { Name: "Docker Engine - Community" }, Context: "default" },
});
const PODMAN_COMPAT_DOCKER_VERSION = JSON.stringify({
  Client: { Platform: { Name: "Docker Engine - Community" }, Version: "29.3.1" },
  Server: {
    Platform: { Name: "linux/arm64/fedora-42" },
    Version: "5.6.2",
    Components: [
      { Name: "Podman Engine", Version: "5.6.2" },
      { Name: "Conmon", Version: "conmon version 2.1.13" },
      { Name: "OCI Runtime (crun)", Version: "crun version 1.23.1" },
    ],
  },
});

describe("assessHost Podman docker-compat detection (#7320)", () => {
  it("reclassifies Podman behind the Docker compatibility socket as unsupported", () => {
    const result = assessHost({
      platform: "darwin",
      env: {},
      dockerInfoOutput: PODMAN_COMPAT_DOCKER_INFO,
      dockerVersionOutput: PODMAN_COMPAT_DOCKER_VERSION,
      commandExistsImpl: (name: string) => name === "docker",
    });

    expect(result.dockerReachable).toBe(true);
    expect(result.runtime).toBe("podman");
    expect(result.isUnsupportedRuntime).toBe(true);
  });

  it("reclassifies Podman from docker info ProductLicense when the version probe is empty", () => {
    const result = assessHost({
      platform: "darwin",
      env: {},
      dockerInfoOutput: PODMAN_COMPAT_DOCKER_INFO,
      dockerVersionOutput: "",
      commandExistsImpl: (name: string) => name === "docker",
    });

    expect(result.dockerReachable).toBe(true);
    expect(result.runtime).toBe("podman");
    expect(result.isUnsupportedRuntime).toBe(true);
  });

  it("keeps real Docker classified as supported (no Podman false positive)", () => {
    const realDockerInfo = JSON.stringify({
      ServerVersion: "29.6.2",
      OperatingSystem: "Ubuntu 24.04.3 LTS",
      OSType: "linux",
      Architecture: "x86_64",
      DefaultRuntime: "runc",
      DockerRootDir: "/var/lib/docker",
      DefaultAddressPools: [{ Base: "192.168.240.0/20", Size: 24 }],
      ClientInfo: { Platform: { Name: "Docker Engine - Community" } },
    });
    const realDockerVersion = JSON.stringify({
      Client: { Platform: { Name: "Docker Engine - Community" } },
      Server: {
        Platform: { Name: "Docker Engine - Community" },
        Version: "29.6.2",
        Components: [
          { Name: "Engine", Version: "29.6.2" },
          { Name: "containerd", Version: "v2.2.6" },
          { Name: "runc", Version: "1.3.6" },
          { Name: "docker-init", Version: "0.19.0" },
        ],
      },
    });
    const result = assessHost({
      platform: "darwin",
      env: {},
      dockerInfoOutput: realDockerInfo,
      dockerVersionOutput: realDockerVersion,
      commandExistsImpl: (name: string) => name === "docker",
    });

    expect(result.dockerReachable).toBe(true);
    expect(result.runtime).toBe("docker");
    expect(result.isUnsupportedRuntime).toBe(false);
  });
});

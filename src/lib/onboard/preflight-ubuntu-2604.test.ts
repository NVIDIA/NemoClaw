// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { assessHost } from "./preflight";

describe("Ubuntu 26.04 preflight tracking", () => {
  it("tracks Ubuntu 26.04 Docker 29 as a generic Linux fixture without support promotion (#3245)", () => {
    const commandResponses = new Map<string, string>([
      ['sh -c command -v "$1" -- apt-get', "/usr/bin/apt-get"],
      ['sh -c command -v "$1" -- systemctl', "/usr/bin/systemctl"],
      ["systemctl is-active docker", "active"],
      ["systemctl is-enabled docker", "enabled"],
    ]);

    const result = assessHost({
      platform: "linux",
      env: {},
      release: "6.17.0-10-generic",
      readFileImpl: () => "Linux version 6.17.0-10-generic (buildd@lcy02-amd64)",
      dockerInfoOutput: JSON.stringify({
        ServerVersion: "29.3.1",
        OperatingSystem: "Ubuntu 26.04 LTS",
        Driver: "overlayfs",
        DriverStatus: [["driver-type", "io.containerd.snapshotter.v1"]],
        CgroupVersion: "2",
      }),
      commandExistsImpl: (name: string) =>
        name === "docker" || name === "apt-get" || name === "systemctl",
      runCaptureImpl: (command: readonly string[]) => commandResponses.get(command.join(" ")) ?? "",
    });

    expect(result.runtime).toBe("docker");
    expect(result.packageManager).toBe("apt");
    expect(result.dockerInfoSummary).toBe("29.3.1 · Ubuntu 26.04 LTS");
    expect(result.dockerCgroupVersion).toBe("v2");
    expect(result.dockerStorageDriver).toBe("overlayfs");
    expect(result.dockerUsesContainerdSnapshotter).toBe(true);
    expect(result.hasNestedOverlayConflict).toBe(true);
    expect(result.requiresHostCgroupnsFix).toBe(false);
  });
});

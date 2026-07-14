// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { assessHost } from "./preflight";

describe("Ubuntu 26.04 preflight compatibility (#3245)", () => {
  it("keeps Docker and cgroup v2 on the supported Linux path", () => {
    const result = assessHost({
      platform: "linux",
      env: {},
      release: "6.14.0-15-generic",
      dockerInfoOutput: JSON.stringify({
        ServerVersion: "29.3.1",
        OperatingSystem: "Ubuntu 26.04 LTS",
        CgroupVersion: "2",
      }),
      readFileImpl: () => '{"default-cgroupns-mode":"private"}',
      commandExistsImpl: (name: string) =>
        name === "docker" || name === "apt-get" || name === "systemctl",
      runCaptureImpl: (command: readonly string[]) =>
        ({
          'sh -c command -v "$1" -- apt-get': "/usr/bin/apt-get",
          'sh -c command -v "$1" -- systemctl': "/usr/bin/systemctl",
          "systemctl is-active docker": "active",
          "systemctl is-enabled docker": "enabled",
        })[command.join(" ")] ?? "",
    });

    expect(result).toMatchObject({
      dockerInfoSummary: "29.3.1 · Ubuntu 26.04 LTS",
      runtime: "docker",
      packageManager: "apt",
      dockerCgroupVersion: "v2",
      requiresHostCgroupnsFix: false,
    });
  });
});

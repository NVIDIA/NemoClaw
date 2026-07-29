// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { assessHost } from "./preflight";

describe("host runtime probe selection", () => {
  it("does not discover or invoke Docker when a qualified non-Docker runtime owns compute", () => {
    const calls: string[][] = [];
    const result = assessHost({
      platform: "linux",
      env: {},
      skipDockerProbe: true,
      dockerInfoOutput: JSON.stringify({
        ServerVersion: "29.3.1",
        OperatingSystem: "Docker Engine",
      }),
      commandExistsImpl: () => false,
      gpuProbeImpl: () => false,
      runCaptureImpl: (command) => {
        calls.push([...command]);
        return "";
      },
    });

    expect(result.dockerInstalled).toBe(false);
    expect(result.dockerReachable).toBe(false);
    expect(result.runtime).toBe("unknown");
    expect(calls.some((command) => command[0] === "docker")).toBe(false);
  });
});

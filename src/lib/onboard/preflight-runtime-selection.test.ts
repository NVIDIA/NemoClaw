// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { assessHost } from "./preflight";

describe("host assessment runtime selection", () => {
  it("collects host facts without probing Docker when Podman is selected", () => {
    const captured: string[][] = [];
    let conflictProbes = 0;
    const result = assessHost({
      platform: "linux",
      env: { NEMOCLAW_GATEWAY_RUNTIME: "podman" },
      commandExistsImpl: (name) => ["docker", "node", "openshell"].includes(name),
      gpuProbeImpl: () => false,
      readFileImpl: () => "",
      readdirImpl: () => [],
      runCaptureImpl: (command) => {
        captured.push([...command]);
        return "";
      },
      observeDockerAuthorityConflictImpl: () => {
        conflictProbes++;
        return null;
      },
    });
    expect(captured.filter(([command]) => command === "docker")).toEqual([]);
    expect(conflictProbes).toBe(0);
    expect(result.nodeInstalled).toBe(true);
    expect(result.openshellInstalled).toBe(true);
    expect(result.dockerInstalled).toBe(true);
    expect(result.dockerReachable).toBe(false);
  });
});

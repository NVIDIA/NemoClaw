// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { assessHost } from "./preflight";

const dockerInfoCommand = ["docker", "info", "--format", "{{json .}}"] as const;
const dockerVersionCommand = ["docker", "version", "--format", "{{json .}}"] as const;
const reachableInfoOutput = JSON.stringify({
  ServerVersion: "29.2.1",
  OperatingSystem: "Docker Engine",
});

function commonAssessmentOptions() {
  return {
    platform: "linux" as const,
    commandExistsImpl: (name: string) => name === "docker",
    runCaptureImpl: () => "",
    readFileImpl: () => "",
    readdirImpl: () => [],
    gpuProbeImpl: () => false,
  };
}

describe("Docker preflight timeouts", () => {
  it("bounds Docker info before reporting an unreachable daemon (#10367)", () => {
    const calls: Array<{
      command: readonly string[];
      ignoreError: boolean | undefined;
      timeout: number | undefined;
    }> = [];
    const result = assessHost({
      ...commonAssessmentOptions(),
      env: {},
      runCaptureImpl: (command, options) => {
        calls.push({ command, ignoreError: options?.ignoreError, timeout: options?.timeout });
        return "";
      },
    });

    expect(calls.filter(({ command }) => command[0] === "docker")).toEqual([
      { command: dockerInfoCommand, ignoreError: true, timeout: 15_000 },
    ]);
    expect(result.dockerReachable).toBe(false);
  });

  it("bounds Docker version after Docker info succeeds (#10367)", () => {
    const calls: Array<{
      command: readonly string[];
      ignoreError: boolean | undefined;
      timeout: number | undefined;
    }> = [];
    const outputs = new Map([[dockerInfoCommand.join("\0"), reachableInfoOutput]]);
    const result = assessHost({
      ...commonAssessmentOptions(),
      env: {},
      runCaptureImpl: (command, options) => {
        calls.push({ command, ignoreError: options?.ignoreError, timeout: options?.timeout });
        return outputs.get(command.join("\0")) ?? "";
      },
    });

    expect(calls.filter(({ command }) => command[0] === "docker")).toEqual([
      { command: dockerInfoCommand, ignoreError: true, timeout: 15_000 },
      { command: dockerVersionCommand, ignoreError: true, timeout: 15_000 },
    ]);
    expect(result.dockerReachable).toBe(true);
  });
});

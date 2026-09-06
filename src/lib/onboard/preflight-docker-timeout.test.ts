// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { assessHost, planHostAdvisories } from "./preflight";

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
      timeout: number | undefined;
    }> = [];
    const result = assessHost({
      ...commonAssessmentOptions(),
      env: {},
      runCaptureExImpl: (command, options) => {
        calls.push({ command, timeout: options?.timeout });
        return { stdout: "", stderr: "", exitCode: null, timedOut: true };
      },
    });

    expect(calls.filter(({ command }) => command[0] === "docker")).toEqual([
      { command: dockerInfoCommand, timeout: 15_000 },
    ]);
    expect(result.dockerReachable).toBe(false);
    expect(result.dockerProbeIssue).toBe("info_timeout");
    const advisories = planHostAdvisories(result);
    expect(advisories.map(({ id }) => id)).toContain("docker_probe_inconclusive");
    expect(advisories.find(({ id }) => id === "docker_probe_inconclusive")?.reason).toContain(
      "did not answer `docker info` within 15 seconds",
    );
    expect(advisories.map(({ id }) => id)).not.toContain("start_docker");
    expect(advisories.map(({ id }) => id)).not.toContain("docker_group_permission");
  });

  it("bounds Docker version after Docker info succeeds (#10367)", () => {
    const calls: Array<{
      command: readonly string[];
      timeout: number | undefined;
    }> = [];
    const results = new Map([
      [
        dockerInfoCommand.join("\0"),
        { stdout: reachableInfoOutput, stderr: "", exitCode: 0, timedOut: false },
      ],
    ]);
    const result = assessHost({
      ...commonAssessmentOptions(),
      env: {},
      runCaptureExImpl: (command, options) => {
        calls.push({ command, timeout: options?.timeout });
        return (
          results.get(command.join("\0")) ?? {
            stdout: "",
            stderr: "",
            exitCode: null,
            timedOut: true,
          }
        );
      },
    });

    expect(calls.filter(({ command }) => command[0] === "docker")).toEqual([
      { command: dockerInfoCommand, timeout: 15_000 },
      { command: dockerVersionCommand, timeout: 15_000 },
    ]);
    expect(result.dockerReachable).toBe(true);
    expect(result.dockerProbeIssue).toBe("version_timeout");
    expect(
      planHostAdvisories(result).find(({ id }) => id === "docker_probe_inconclusive")?.reason,
    ).toContain("did not answer `docker version` within 15 seconds");
  });

  it("reports an unavailable Docker info process as inconclusive", () => {
    const result = assessHost({
      ...commonAssessmentOptions(),
      env: {},
      runCaptureExImpl: () => {
        throw new Error("spawn failed");
      },
    });

    expect(result.dockerReachable).toBe(false);
    expect(result.dockerProbeIssue).toBe("info_unavailable");
    const advisoryIds = planHostAdvisories(result).map(({ id }) => id);
    expect(advisoryIds).toContain("docker_probe_inconclusive");
    expect(advisoryIds).not.toContain("start_docker");
    expect(advisoryIds).not.toContain("docker_group_permission");
  });

  it("reports an unavailable Docker version process as inconclusive", () => {
    const result = assessHost({
      ...commonAssessmentOptions(),
      env: {},
      runCaptureExImpl: (command) =>
        command[1] === "info"
          ? { stdout: reachableInfoOutput, stderr: "", exitCode: 0, timedOut: false }
          : { stdout: "", stderr: "", exitCode: null, timedOut: false },
    });

    expect(result.dockerReachable).toBe(true);
    expect(result.dockerProbeIssue).toBe("version_unavailable");
    expect(planHostAdvisories(result).map(({ id }) => id)).toContain("docker_probe_inconclusive");
  });
});

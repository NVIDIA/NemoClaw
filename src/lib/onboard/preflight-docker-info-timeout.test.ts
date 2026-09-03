// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { assessHost, planHostAdvisories } from "./preflight";
import { printRemediationActions } from "./remediation";

describe("assessHost docker info timeout (#10645)", () => {
  it("flags a bounded docker info timeout instead of a docker-group remediation", () => {
    const probeCalls: Array<{
      command: readonly string[];
      options?: { timeout?: number };
    }> = [];
    const assessment = assessHost({
      platform: "linux",
      env: { DOCKER_HOST: "unix:///var/run/docker.sock" },
      commandExistsImpl: (name: string) => name === "docker" || name === "systemctl",
      runCaptureExImpl: (command, options) => {
        probeCalls.push({ command, options });
        return { stdout: "", exitCode: null, timedOut: true };
      },
      runCaptureImpl: (command: readonly string[]) =>
        command.includes("is-active") ? "active" : "",
    });

    expect(probeCalls).toEqual([
      {
        command: ["docker", "info", "--format", "{{json .}}"],
        options: { timeout: 3_000 },
      },
    ]);
    expect(assessment.dockerInfoTimedOut).toBe(true);
    expect(assessment.dockerReachable).toBe(false);

    const ids = planHostAdvisories(assessment).map((action) => action.id);
    expect(ids).toContain("docker_info_timeout");
    expect(ids).not.toContain("docker_group_permission");
    expect(ids).not.toContain("start_docker");
  });

  it("names the configured Docker authority in the timeout remediation", () => {
    const assessment = assessHost({
      platform: "linux",
      env: { DOCKER_HOST: "unix:///var/run/docker.sock" },
      dockerInfoTimedOut: true,
      dockerInfoOutput: "",
      commandExistsImpl: (name: string) => name === "docker" || name === "systemctl",
      runCaptureImpl: (command: readonly string[]) =>
        command.includes("is-active") ? "active" : "",
    });

    const lines: string[] = [];
    const err = console.error;
    console.error = (line: string) => {
      lines.push(line);
    };
    try {
      printRemediationActions(planHostAdvisories(assessment));
    } finally {
      console.error = err;
    }

    expect(lines.join("\n")).toContain("docker_info_timeout");
    expect(lines.join("\n")).toContain("printf 'DOCKER_HOST=%s\\n' 'unix:///var/run/docker.sock'");
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { assessHost, planHostRemediation } from "./preflight";

// Regression: NemoClaw #7731. This invalid TCP endpoint makes `docker info`
// fail, but the local docker.service is still active. Preflight used to emit
// the docker-group remediation. The host assessment now flags the invalid
// DOCKER_HOST so onboarding names it instead.
describe("assessHost invalid DOCKER_HOST (#7731)", () => {
  it("flags an invalid DOCKER_HOST so onboarding names the endpoint, not a docker-group fix", () => {
    const assessment = assessHost({
      platform: "linux",
      env: { DOCKER_HOST: "tcp://203.0.113.10:2375" },
      dockerInfoOutput: "",
      commandExistsImpl: (name: string) => name === "docker" || name === "systemctl",
      runCaptureImpl: (command: readonly string[]) =>
        command.includes("is-active") ? "active" : "",
    });

    expect(assessment.dockerHostInvalid).toBe(true);
    expect(assessment.dockerReachable).toBe(false);
    expect(assessment.dockerServiceActive).toBe(true);

    const ids = planHostRemediation(assessment).map((action) => action.id);
    expect(ids).toContain("invalid_docker_host");
    expect(ids).not.toContain("docker_group_permission");
  });

  it("treats a supported absolute unix:// DOCKER_HOST as valid", () => {
    const assessment = assessHost({
      platform: "linux",
      env: { DOCKER_HOST: "unix:///var/run/docker.sock" },
      dockerInfoOutput: "",
      commandExistsImpl: (name: string) => name === "docker" || name === "systemctl",
      runCaptureImpl: (command: readonly string[]) =>
        command.includes("is-active") ? "active" : "",
    });

    expect(assessment.dockerHostInvalid).toBe(false);
  });

  it("treats an unset DOCKER_HOST as valid", () => {
    const assessment = assessHost({
      platform: "linux",
      env: {},
      dockerInfoOutput: "",
      commandExistsImpl: (name: string) => name === "docker" || name === "systemctl",
      runCaptureImpl: (command: readonly string[]) =>
        command.includes("is-active") ? "active" : "",
    });

    expect(assessment.dockerHostInvalid).toBe(false);
  });
});

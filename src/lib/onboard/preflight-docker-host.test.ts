// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { assessHost, planHostAdvisories } from "./preflight";
import { printRemediationActions } from "./remediation";

// Regression: NemoClaw #7731. This invalid TCP endpoint makes `docker info`
// fail, but the local docker.service is still active. Preflight used to emit
// the docker-group remediation. The host assessment now flags the invalid
// DOCKER_HOST so onboarding names it instead.
describe("assessHost invalid DOCKER_HOST (#7731)", () => {
  describe("printRemediationActions", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("prints the advisory identifier after the remediation title", () => {
      const assessment = assessHost({
        platform: "linux",
        env: { DOCKER_HOST: "tcp://203.0.113.10:2375" },
        dockerInfoOutput: "",
        commandExistsImpl: (name: string) => name === "docker" || name === "systemctl",
        runCaptureImpl: (command: readonly string[]) =>
          command.includes("is-active") ? "active" : "",
      });

      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      printRemediationActions(planHostAdvisories(assessment));
      const output = err.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");

      expect(output).toContain("Fix the DOCKER_HOST endpoint (invalid_docker_host):");
      expect(output).toContain("unset DOCKER_HOST");
      expect(output).toContain("unix:///var/run/docker.sock");
      expect(output).not.toContain("docker_group_permission");
      expect(output).not.toContain("start_docker");
    });
  });

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

    const ids = planHostAdvisories(assessment).map((action) => action.id);
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

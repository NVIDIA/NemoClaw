// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import * as platform from "../platform";
import type { DockerAuthorityConflict } from "../platform";
import { assessHost, planHostAdvisories } from "./preflight";

// Regression: NemoClaw #10622. The default Docker authority is unreachable
// and the socket fallback meets both a Podman and a Docker engine. Detection
// deliberately selects neither (#8816, #10253). Preflight used to emit only
// the docker-group remediation, whose fix is wrong for this cause. The host
// assessment now carries the conflict so onboarding names both engines.
const CONFLICT: DockerAuthorityConflict = {
  candidates: [
    { socketPath: "/run/user/1000/podman/podman.sock", identity: "podman" },
    { socketPath: "/var/run/docker.sock", identity: "docker" },
  ],
};

const REACHABLE_DOCKER_INFO = JSON.stringify({
  ServerVersion: "29.6.2",
  OperatingSystem: "Ubuntu 24.04.3 LTS",
  OSType: "linux",
  Architecture: "x86_64",
  DefaultRuntime: "runc",
  CgroupVersion: "2",
  Driver: "overlay2",
});

function commandExistsImpl(name: string): boolean {
  return name === "docker" || name === "systemctl";
}

function runCaptureImpl(command: readonly string[]): string {
  return command.includes("is-active") ? "active" : "";
}

describe("assessHost Docker authority conflict (#10622)", () => {
  it("carries the conflict so onboarding names both engines, not a docker-group fix", () => {
    const observe = vi.fn(() => CONFLICT);
    const assessment = assessHost({
      platform: "linux",
      env: {},
      dockerInfoOutput: "",
      commandExistsImpl,
      runCaptureImpl,
      observeDockerAuthorityConflictImpl: observe,
    });

    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith({ env: {}, platform: "linux" });
    expect(assessment.dockerReachable).toBe(false);
    expect(assessment.dockerServiceActive).toBe(true);
    expect(assessment.dockerAuthorityConflict).toEqual(CONFLICT);

    const ids = planHostAdvisories(assessment).map((action) => action.id);
    expect(ids).toContain("docker_authority_conflict");
    expect(ids).not.toContain("docker_group_permission");
    expect(ids).not.toContain("start_docker");
  });

  it("does not observe the conflict when DOCKER_HOST is set", () => {
    const observe = vi.fn(() => CONFLICT);
    const assessment = assessHost({
      platform: "linux",
      env: { DOCKER_HOST: "unix:///var/run/docker.sock" },
      dockerInfoOutput: "",
      commandExistsImpl,
      runCaptureImpl,
      observeDockerAuthorityConflictImpl: observe,
    });

    expect(observe).not.toHaveBeenCalled();
    expect(assessment.dockerAuthorityConflict).toBeUndefined();
    expect(planHostAdvisories(assessment).map((action) => action.id)).not.toContain(
      "docker_authority_conflict",
    );
  });

  it("does not observe the conflict when the daemon is reachable", () => {
    const observe = vi.fn(() => CONFLICT);
    const assessment = assessHost({
      platform: "linux",
      env: {},
      dockerInfoOutput: REACHABLE_DOCKER_INFO,
      dockerVersionOutput: "",
      commandExistsImpl,
      runCaptureImpl,
      observeDockerAuthorityConflictImpl: observe,
    });

    expect(assessment.dockerReachable).toBe(true);
    expect(observe).not.toHaveBeenCalled();
    expect(assessment.dockerAuthorityConflict).toBeUndefined();
  });

  it("leaves the field unset when the observer reports no conflict", () => {
    const observe = vi.fn(() => null);
    const assessment = assessHost({
      platform: "linux",
      env: {},
      dockerInfoOutput: "",
      commandExistsImpl,
      runCaptureImpl,
      observeDockerAuthorityConflictImpl: observe,
    });

    expect(observe).toHaveBeenCalledTimes(1);
    expect(assessment.dockerAuthorityConflict).toBeUndefined();
    expect(planHostAdvisories(assessment).map((action) => action.id)).toContain(
      "docker_group_permission",
    );
  });

  it("does not probe this host's sockets when the caller injects Docker evidence", () => {
    const observe = vi.spyOn(platform, "observeDockerAuthorityConflict").mockReturnValue(CONFLICT);
    const assessment = assessHost({
      platform: "linux",
      env: {},
      dockerInfoOutput: "",
      commandExistsImpl,
      runCaptureImpl,
    });

    expect(observe).not.toHaveBeenCalled();
    expect(assessment.dockerAuthorityConflict).toBeUndefined();
    expect(planHostAdvisories(assessment).map((action) => action.id)).toContain(
      "docker_group_permission",
    );
  });

  it("does not observe the conflict when the Docker probe times out", () => {
    const observe = vi.fn(() => CONFLICT);
    const assessment = assessHost({
      platform: "linux",
      env: {},
      commandExistsImpl,
      runCaptureImpl,
      runCaptureExImpl: () => ({ stdout: "", stderr: "", exitCode: null, timedOut: true }),
      observeDockerAuthorityConflictImpl: observe,
    });

    expect(assessment.dockerProbeIssue).toBe("info_timeout");
    expect(observe).not.toHaveBeenCalled();
    expect(assessment.dockerAuthorityConflict).toBeUndefined();
    expect(planHostAdvisories(assessment).map((action) => action.id)).not.toContain(
      "docker_authority_conflict",
    );
  });

  it("does not observe the conflict when Docker is not installed", () => {
    const observe = vi.fn(() => CONFLICT);
    const assessment = assessHost({
      platform: "linux",
      env: {},
      dockerInfoOutput: "",
      commandExistsImpl: (name: string) => name === "systemctl",
      runCaptureImpl,
      observeDockerAuthorityConflictImpl: observe,
    });

    expect(observe).not.toHaveBeenCalled();
    expect(assessment.dockerAuthorityConflict).toBeUndefined();
    expect(planHostAdvisories(assessment).map((action) => action.id)).toContain("install_docker");
  });
});

describe("local Docker authority observation (#10622)", () => {
  function localHostOptions() {
    // Exercise the default process transport without contacting the host's Docker service.
    const bin = mkdtempSync(join(tmpdir(), "nemoclaw-authority-"));
    onTestFinished(() => rmSync(bin, { recursive: true, force: true }));
    writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    writeFileSync(join(bin, "systemctl"), "#!/bin/sh\necho active\n", { mode: 0o700 });
    symlinkSync("/bin/sh", join(bin, "sh"));
    vi.stubEnv("PATH", bin);
    vi.stubEnv("DOCKER_HOST", undefined);
    return {
      platform: "linux" as const,
      env: {},
      commandExistsImpl,
      resolveOpenshellImpl: () => null,
      gpuProbeImpl: () => false,
      readFileImpl: () => "",
      readdirImpl: () => [],
      release: "",
      procVersion: "",
    };
  }

  it("uses the default observer and refreshes conflict evidence on the next assessment", () => {
    const opts = localHostOptions();
    const observe = vi
      .spyOn(platform, "observeDockerAuthorityConflict")
      .mockReturnValueOnce(CONFLICT)
      .mockReturnValueOnce(null);
    const first = assessHost(opts);
    expect(first.dockerProbeIssue).toBeUndefined();
    expect(first.dockerAuthorityConflict).toEqual(CONFLICT);
    expect(observe).toHaveBeenNthCalledWith(1, { env: opts.env, platform: opts.platform });
    const firstIds = planHostAdvisories(first).map((action) => action.id);
    expect(firstIds).toContain("docker_authority_conflict");
    expect(firstIds).not.toContain("docker_group_permission");
    expect(firstIds).not.toContain("start_docker");

    const second = assessHost(opts);
    expect(second.dockerAuthorityConflict).toBeUndefined();
    expect(planHostAdvisories(second).map((action) => action.id)).not.toContain(
      "docker_authority_conflict",
    );
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["Docker evidence", { dockerInfoOutput: "" }],
    ["a command transport", { runCaptureImpl: () => "" }],
    [
      "an extended command transport",
      {
        runCaptureExImpl: () => ({ stdout: "", stderr: "", exitCode: 1, timedOut: false }),
      },
    ],
  ])("does not observe local sockets when the caller injects %s", (_case, injected) => {
    const opts = localHostOptions();
    const observe = vi.spyOn(platform, "observeDockerAuthorityConflict").mockReturnValue(CONFLICT);
    const assessment = assessHost({ ...opts, ...injected });
    expect(assessment.dockerAuthorityConflict).toBeUndefined();
    expect(observe).not.toHaveBeenCalled();
  });
});

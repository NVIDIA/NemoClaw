// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { HostAssessment } from "../../../onboard/preflight";
import { runAdvisories } from "../../runner";
import { DOCKER_HOST_ADVISORY_CHECKS } from "./docker";

function host(overrides: Partial<HostAssessment> = {}): HostAssessment {
  return {
    platform: "linux",
    isWsl: false,
    runtime: "unknown",
    packageManager: "apt",
    systemctlAvailable: true,
    dockerServiceActive: false,
    dockerServiceEnabled: true,
    dockerInstalled: true,
    dockerRunning: false,
    dockerReachable: false,
    nodeInstalled: true,
    openshellInstalled: true,
    dockerCgroupVersion: "unknown",
    dockerDefaultCgroupnsMode: "unknown",
    isContainerRuntimeUnderProvisioned: false,
    hasNestedOverlayConflict: false,
    requiresHostCgroupnsFix: false,
    isUnsupportedRuntime: false,
    isHeadlessLikely: false,
    hasNvidiaGpu: false,
    dockerCdiSpecDirs: [],
    cdiNvidiaGpuSpecMissing: false,
    nvidiaContainerToolkitInstalled: true,
    notes: [],
    ...overrides,
  };
}

describe("Docker host advisories (#3213)", () => {
  it.each([
    { context: host({ dockerInstalled: false }), expectedId: "install_docker" },
    { context: host({ dockerServiceActive: true }), expectedId: "docker_group_permission" },
    { context: host(), expectedId: "start_docker" },
    { context: host({ isWsl: true }), expectedId: "enable_docker_desktop_wsl_integration" },
  ])("preserves the $expectedId Docker reachability action", ({ context, expectedId }) => {
    const result = runAdvisories(DOCKER_HOST_ADVISORY_CHECKS, context, {
      phase: "preflight.host",
    });
    expect(result.advisories.map((advisory) => advisory.id)).toEqual([expectedId]);
  });

  it("reports a docker info timeout instead of a docker-group remediation (#10645)", () => {
    const result = runAdvisories(
      DOCKER_HOST_ADVISORY_CHECKS,
      host({ dockerServiceActive: true, dockerInfoTimedOut: true }),
      { phase: "preflight.host" },
    );

    expect(result.advisories.map((advisory) => advisory.id)).toEqual(["docker_info_timeout"]);
  });

  it("reports an invalid DOCKER_HOST instead of a docker-group remediation (#7731)", () => {
    const result = runAdvisories(
      DOCKER_HOST_ADVISORY_CHECKS,
      host({ dockerServiceActive: true, dockerHostInvalid: true }),
      { phase: "preflight.host" },
    );

    expect(result.advisories.map((advisory) => advisory.id)).toEqual(["invalid_docker_host"]);
  });

  it("reports an invalid DOCKER_HOST even when the endpoint is reachable (#7731)", () => {
    const result = runAdvisories(
      DOCKER_HOST_ADVISORY_CHECKS,
      host({ dockerReachable: true, dockerHostInvalid: true }),
      { phase: "preflight.host" },
    );

    expect(result.advisories.map((advisory) => advisory.id)).toEqual(["invalid_docker_host"]);
  });

  it("reports an invalid DOCKER_HOST in WSL before runtime reachability guidance (#7411)", () => {
    const result = runAdvisories(
      DOCKER_HOST_ADVISORY_CHECKS,
      host({ isWsl: true, dockerHostInvalid: true }),
      { phase: "preflight.host" },
    );

    expect(result.advisories.map((advisory) => advisory.id)).toEqual(["invalid_docker_host"]);
  });

  it("warns about a Docker Desktop credential store in a headless session (#9457)", () => {
    const result = runAdvisories(
      DOCKER_HOST_ADVISORY_CHECKS,
      host({
        runtime: "docker-desktop",
        dockerReachable: true,
        dockerCredsStore: "desktop",
        isHeadlessLikely: true,
      }),
      { phase: "preflight.host" },
    );

    expect(result.advisories.map((advisory) => advisory.id)).toEqual([
      "docker_desktop_credential_store_headless",
    ]);
    expect(result.advisories[0]?.severity).toBe("warning");
  });

  it("trusts the helper probe over session markers on WSL (#9457)", () => {
    const result = runAdvisories(
      DOCKER_HOST_ADVISORY_CHECKS,
      host({
        isWsl: true,
        runtime: "docker-desktop",
        dockerReachable: true,
        dockerCredsStore: "desktop.exe",
        dockerCredentialHelperUnresponsive: true,
        isHeadlessLikely: false,
      }),
      { phase: "preflight.host" },
    );

    expect(result.advisories.map((advisory) => advisory.id)).toEqual([
      "docker_desktop_credential_store_headless",
    ]);
    expect(result.advisories[0]?.reason).toContain("did not answer a read-only probe");
  });

  it("stays silent on WSL when the helper answers, even without session markers (#9457)", () => {
    const result = runAdvisories(
      DOCKER_HOST_ADVISORY_CHECKS,
      host({
        isWsl: true,
        runtime: "docker-desktop",
        dockerReachable: true,
        dockerCredsStore: "desktop.exe",
        dockerCredentialHelperUnresponsive: false,
        isHeadlessLikely: true,
      }),
      { phase: "preflight.host" },
    );

    expect(result.advisories.map((advisory) => advisory.id)).toEqual([]);
  });

  it("stays silent on Docker Engine with a copied Docker Desktop credential store (#9457)", () => {
    const result = runAdvisories(
      DOCKER_HOST_ADVISORY_CHECKS,
      host({
        runtime: "docker",
        dockerReachable: true,
        dockerCredsStore: "desktop",
        isHeadlessLikely: true,
      }),
      { phase: "preflight.host" },
    );

    expect(result.advisories.map((advisory) => advisory.id)).toEqual([]);
  });

  it("re-evaluates Docker state on resume", () => {
    const context = host({ dockerInstalled: false });
    const cachedResults = new Map([["install_docker", null]]);

    const result = runAdvisories(DOCKER_HOST_ADVISORY_CHECKS, context, {
      phase: "preflight.host",
      resuming: true,
      cachedResults,
    });

    expect(result.executedCheckIds).toEqual([
      "enable_docker_desktop_wsl_integration",
      "install_docker",
      "invalid_docker_host",
      "docker_info_timeout",
      "docker_group_permission",
      "start_docker",
      "docker_desktop_credential_store_headless",
    ]);
    expect(result.reusedCheckIds).toEqual([]);
    expect(result.advisories.map((advisory) => advisory.id)).toEqual(["install_docker"]);
  });
});

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

  const CONFLICT: HostAssessment["dockerAuthorityConflict"] = {
    candidates: [
      { socketPath: "/run/user/1000/podman/podman.sock", identity: "podman" },
      { socketPath: "/var/run/docker.sock", identity: "docker" },
    ],
  };

  it("names the authority conflict instead of a docker-group or start-docker fix (#10622)", () => {
    const result = runAdvisories(
      DOCKER_HOST_ADVISORY_CHECKS,
      host({ dockerServiceActive: true, dockerAuthorityConflict: CONFLICT }),
      { phase: "preflight.host" },
    );

    expect(result.advisories.map((advisory) => advisory.id)).toEqual(["docker_authority_conflict"]);
    const advisory = result.advisories[0];
    expect(advisory).toMatchObject({
      severity: "blocking",
      kind: "manual",
      title: "Choose the Docker authority",
    });
    expect(advisory?.reason).toContain("podman at /run/user/1000/podman/podman.sock");
    expect(advisory?.reason).toContain("docker at /var/run/docker.sock");
    expect(advisory?.reason).toContain("did not choose between them");
    expect(advisory?.reason).toContain("did not diagnose why");
    expect(advisory?.commands).toEqual([
      "export DOCKER_HOST='unix:///var/run/docker.sock'",
      "nemoclaw onboard",
    ]);
  });

  it.each(["linux", "darwin", "win32"] as const)(
    "offers native Podman guidance only for Linux when the platform is %s (#10622)",
    (platform) => {
      const result = runAdvisories(
        DOCKER_HOST_ADVISORY_CHECKS,
        host({ platform, dockerAuthorityConflict: CONFLICT }),
        { phase: "preflight.host" },
      );
      const reason = result.advisories[0]?.reason ?? "";
      expect(reason.includes("NEMOCLAW_GATEWAY_RUNTIME=podman")).toBe(platform === "linux");
      expect(reason.includes("qualified Linux host")).toBe(platform === "linux");
      expect(reason.includes("platform-support#deployment-paths")).toBe(platform === "linux");
    },
  );

  it("quotes a socket path that contains a space (#10622)", () => {
    const result = runAdvisories(
      DOCKER_HOST_ADVISORY_CHECKS,
      host({
        platform: "darwin",
        packageManager: "brew",
        dockerServiceActive: null,
        dockerAuthorityConflict: {
          candidates: [
            { socketPath: "/Users/Jane Doe/.docker/run/docker.sock", identity: "docker" },
            {
              socketPath: "/Users/Jane Doe/.local/share/containers/podman/machine/podman.sock",
              identity: "podman",
            },
          ],
        },
      }),
      { phase: "preflight.host" },
    );

    expect(result.advisories[0]?.commands?.[0]).toBe(
      "export DOCKER_HOST='unix:///Users/Jane Doe/.docker/run/docker.sock'",
    );
  });

  it.each([
    ["an inactive Linux docker.service", host({ dockerAuthorityConflict: CONFLICT })],
    [
      "a null service state on macOS",
      host({
        platform: "darwin",
        packageManager: "brew",
        dockerServiceActive: null,
        dockerAuthorityConflict: CONFLICT,
      }),
    ],
    ["a WSL distro", host({ isWsl: true, dockerAuthorityConflict: CONFLICT })],
  ])("keeps the conflict as the only Docker advisory with %s (#10622)", (_case, context) => {
    const result = runAdvisories(DOCKER_HOST_ADVISORY_CHECKS, context, {
      phase: "preflight.host",
    });

    expect(result.advisories.map((advisory) => advisory.id)).toEqual(["docker_authority_conflict"]);
  });

  it.each([
    [
      "the daemon is reachable",
      host({ dockerReachable: true, dockerRunning: true, dockerAuthorityConflict: CONFLICT }),
      [],
    ],
    [
      "Docker is not installed",
      host({ dockerInstalled: false, dockerAuthorityConflict: CONFLICT }),
      ["install_docker"],
    ],
    [
      "DOCKER_HOST is invalid",
      host({
        dockerHostInvalid: true,
        dockerServiceActive: true,
        dockerAuthorityConflict: CONFLICT,
      }),
      ["invalid_docker_host"],
    ],
  ])("does not report a conflict when %s (#10622)", (_case, context, expectedIds) => {
    const result = runAdvisories(DOCKER_HOST_ADVISORY_CHECKS, context, {
      phase: "preflight.host",
    });

    expect(result.advisories.map((advisory) => advisory.id)).toEqual(expectedIds);
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
      "docker_probe_inconclusive",
      "docker_authority_conflict",
      "docker_group_permission",
      "start_docker",
      "docker_desktop_credential_store_headless",
    ]);
    expect(result.reusedCheckIds).toEqual([]);
    expect(result.advisories.map((advisory) => advisory.id)).toEqual(["install_docker"]);
  });
});

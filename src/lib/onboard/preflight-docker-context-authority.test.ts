// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { detectDockerHost, observeDockerAuthorityConflict } from "../platform";
import { assessHost, planHostAdvisories } from "./preflight";

// Regression: NemoClaw #11719. DOCKER_CONTEXT selects the Docker daemon just as
// DOCKER_HOST does. Authority detection used to probe the ambient context, see
// it refuse, and redirect to a discovered fallback socket -- so `host probe`
// certified a daemon the operator never selected while `onboard` refused on the
// one they did.
const PODMAN_SOCKET = "/run/user/1000/podman/podman.sock";
const DOCKER_SOCKET = "/var/run/docker.sock";
const DEAD_CONTEXT_SOCKET = "unix:///run/user/1000/no-such.sock";

const REACHABLE_DOCKER_INFO = JSON.stringify({
  ServerVersion: "29.8.0",
  OperatingSystem: "Ubuntu 24.04.4 LTS",
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

/** A host where both engines answer and the selected context does not. */
function twoEngineHost(env: NodeJS.ProcessEnv, contextHost: string | null) {
  const sockets = new Set([PODMAN_SOCKET, DOCKER_SOCKET]);
  const probeDockerHost = vi.fn((dockerHost?: string) =>
    dockerHost === undefined
      ? { reachable: false, identity: "unknown" as const }
      : {
          reachable: true,
          identity: dockerHost.includes("podman") ? ("podman" as const) : ("docker" as const),
        },
  );
  const resolveDockerContextHost = vi.fn(() => contextHost);
  return {
    probeDockerHost,
    resolveDockerContextHost,
    opts: {
      env,
      platform: "linux" as const,
      uid: 1000,
      existsSync: (candidate: string) => sockets.has(candidate),
      probeDockerHost,
      resolveDockerContextHost,
    },
  };
}

describe("Docker context authority selection (#11719)", () => {
  it("records the endpoint a selected context names instead of a fallback socket", () => {
    const { opts, probeDockerHost } = twoEngineHost(
      { DOCKER_CONTEXT: "qa-unreachable" },
      DEAD_CONTEXT_SOCKET,
    );

    expect(detectDockerHost(opts)).toEqual({
      dockerHost: DEAD_CONTEXT_SOCKET,
      source: "context",
      socketPath: null,
    });
    // The fallback sockets are never probed: the operator already chose.
    expect(probeDockerHost).not.toHaveBeenCalled();
  });

  it("keeps the host default when the selected context does not resolve", () => {
    const { opts, probeDockerHost } = twoEngineHost({ DOCKER_CONTEXT: "qa-missing" }, null);

    expect(detectDockerHost(opts)).toBeNull();
    expect(probeDockerHost).not.toHaveBeenCalled();
  });

  it.each(["tcp://192.0.2.10:2375", "ssh://builder@192.0.2.10", "relative.sock"])(
    "never records an endpoint onboarding cannot use: %s",
    (contextHost) => {
      const { opts } = twoEngineHost({ DOCKER_CONTEXT: "qa-remote" }, contextHost);

      expect(detectDockerHost(opts)).toBeNull();
    },
  );

  it("lets DOCKER_CONTEXT override DOCKER_HOST, as the Docker CLI does", () => {
    const { opts, resolveDockerContextHost } = twoEngineHost(
      { DOCKER_HOST: `unix://${DOCKER_SOCKET}`, DOCKER_CONTEXT: "qa-unreachable" },
      DEAD_CONTEXT_SOCKET,
    );

    expect(detectDockerHost(opts)).toEqual({
      dockerHost: DEAD_CONTEXT_SOCKET,
      source: "context",
      socketPath: null,
    });
    expect(resolveDockerContextHost).toHaveBeenCalledWith("qa-unreachable");
  });

  it.each(["", "   "])("treats a blank context selector as no selection: %j", (value) => {
    const { opts, probeDockerHost, resolveDockerContextHost } = twoEngineHost(
      { DOCKER_CONTEXT: value },
      DEAD_CONTEXT_SOCKET,
    );

    // A blank value selects nothing for the Docker CLI either, so the fallback
    // scan that serves a host with no authority still runs -- and on this host
    // it meets both engines.
    expect(observeDockerAuthorityConflict(opts)).not.toBeNull();
    expect(resolveDockerContextHost).not.toHaveBeenCalled();
    expect(probeDockerHost).toHaveBeenCalled();
  });

  it("reports no engine conflict while a context owns the selection", () => {
    // Two engines answer, which is the shape that produces the conflict when no
    // context is selected. A selected context is not a host without an
    // authority, so naming both engines would be the wrong diagnosis.
    const selected = twoEngineHost({ DOCKER_CONTEXT: "qa-unreachable" }, DEAD_CONTEXT_SOCKET);
    expect(observeDockerAuthorityConflict(selected.opts)).toBeNull();

    const unselected = twoEngineHost({}, null);
    expect(observeDockerAuthorityConflict(unselected.opts)).toEqual({
      candidates: [
        { socketPath: DOCKER_SOCKET, identity: "docker" },
        { socketPath: PODMAN_SOCKET, identity: "podman" },
      ],
    });
  });
});

describe("assessHost Docker context endpoint (#11719)", () => {
  it("refuses to classify a host whose context selector it could not reduce", () => {
    const assessment = assessHost({
      platform: "linux",
      release: "6.8.0-generic",
      procVersion: "Linux version 6.8.0-generic",
      env: { DOCKER_CONTEXT: "qa-remote" },
      commandExistsImpl,
      runCaptureImpl,
    });

    expect(assessment.dockerContextInvalid).toBe("qa-remote");
    expect(assessment.dockerHostInvalid).toBe(true);
    // A blocked endpoint is never contacted, so no daemon evidence is claimed.
    expect(assessment.dockerReachable).toBe(false);

    const advisories = planHostAdvisories(assessment);
    const invalid = advisories.find((action) => action.id === "invalid_docker_host");
    expect(invalid?.title).toBe("Fix the DOCKER_CONTEXT endpoint");
    expect(invalid?.reason).toContain("DOCKER_CONTEXT selects the Docker context 'qa-remote'");
    expect(invalid?.commands).toContain("unset DOCKER_CONTEXT   # use Docker's default context");
    // The docker-group and start-Docker fixes are wrong for this cause.
    const ids = advisories.map((action) => action.id);
    expect(ids).not.toContain("docker_group_permission");
    expect(ids).not.toContain("start_docker");
  });

  it("does not reproduce an invalid selector name in terminal output", () => {
    const unsafeContext = "qa\u001b[31m'; rm -rf ~";
    const assessment = assessHost({
      platform: "linux",
      release: "6.8.0-generic",
      procVersion: "Linux version 6.8.0-generic",
      env: { DOCKER_CONTEXT: unsafeContext },
      commandExistsImpl,
      runCaptureImpl,
    });

    const invalid = planHostAdvisories(assessment).find(
      (action) => action.id === "invalid_docker_host",
    );
    const rendered = [invalid?.title, invalid?.reason, ...(invalid?.commands ?? [])].join("\n");
    expect(invalid?.reason).toContain("selects an invalid Docker context name");
    expect(rendered).not.toContain(unsafeContext);
    expect(rendered).not.toContain("\u001b");
    expect(invalid?.commands?.some((command) => command.startsWith("docker context inspect"))).toBe(
      false,
    );
  });

  it("does not reproduce an oversized selector name in terminal output", () => {
    const oversizedContext = `qa-${"x".repeat(300)}`;
    const assessment = assessHost({
      platform: "linux",
      release: "6.8.0-generic",
      procVersion: "Linux version 6.8.0-generic",
      env: { DOCKER_CONTEXT: oversizedContext },
      commandExistsImpl,
      runCaptureImpl,
    });

    const invalid = planHostAdvisories(assessment).find(
      (action) => action.id === "invalid_docker_host",
    );
    const rendered = [invalid?.title, invalid?.reason, ...(invalid?.commands ?? [])].join("\n");
    expect(rendered).not.toContain(oversizedContext);
  });

  it("reports an unresolved DOCKER_CONTEXT even when DOCKER_HOST is set", () => {
    const assessment = assessHost({
      platform: "linux",
      release: "6.8.0-generic",
      procVersion: "Linux version 6.8.0-generic",
      env: { DOCKER_HOST: "tcp://192.0.2.10:2375", DOCKER_CONTEXT: "qa-remote" },
      commandExistsImpl,
      runCaptureImpl,
    });

    expect(assessment.dockerContextInvalid).toBe("qa-remote");
    expect(assessment.dockerHostInvalid).toBe(true);
    const invalid = planHostAdvisories(assessment).find(
      (action) => action.id === "invalid_docker_host",
    );
    expect(invalid?.title).toBe("Fix the DOCKER_CONTEXT endpoint");
  });

  it("rejects a control-bearing endpoint without reproducing the control byte", () => {
    const escapeByte = "\u001b";
    const assessment = assessHost({
      platform: "linux",
      release: "6.8.0-generic",
      procVersion: "Linux version 6.8.0-generic",
      env: { DOCKER_HOST: `unix:///tmp/${escapeByte}[31mdocker.sock` },
      commandExistsImpl,
      runCaptureImpl,
    });

    expect(assessment.dockerHostInvalid).toBe(true);
    expect(assessment.dockerEndpointSocketMissing).toBeUndefined();
    const invalid = planHostAdvisories(assessment).find(
      (action) => action.id === "invalid_docker_host",
    );
    expect(invalid?.title).toBe("Fix the DOCKER_HOST endpoint");
    expect(JSON.stringify(invalid)).not.toContain(escapeByte);
  });

  it("names the missing socket instead of a root-level group grant", () => {
    const assessment = assessHost({
      platform: "linux",
      release: "6.8.0-generic",
      procVersion: "Linux version 6.8.0-generic",
      env: { DOCKER_HOST: DEAD_CONTEXT_SOCKET },
      dockerInfoOutput: "",
      commandExistsImpl,
      runCaptureImpl,
      statSyncImpl: () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    });

    expect(assessment.dockerEndpointSocketMissing).toBe(DEAD_CONTEXT_SOCKET);
    expect(assessment.dockerServiceActive).toBe(true);

    const advisories = planHostAdvisories(assessment);
    const missing = advisories.find((action) => action.id === "docker_endpoint_socket_missing");
    expect(missing?.reason).toContain(`${DEAD_CONTEXT_SOCKET} has no Unix socket at that path`);
    expect(missing?.commands).toContain(
      "unset DOCKER_HOST DOCKER_CONTEXT   # use Docker's default endpoint",
    );
    // Neither wrong cause is offered: no group grants access to an absent path,
    // and starting the default daemon creates a different socket.
    const ids = advisories.map((action) => action.id);
    expect(ids).not.toContain("docker_group_permission");
    expect(ids).not.toContain("start_docker");
  });

  it("keeps the docker-group remedy when the selected socket exists", () => {
    const assessment = assessHost({
      platform: "linux",
      release: "6.8.0-generic",
      procVersion: "Linux version 6.8.0-generic",
      env: { DOCKER_HOST: `unix://${DOCKER_SOCKET}` },
      dockerInfoOutput: "",
      commandExistsImpl,
      runCaptureImpl,
      statSyncImpl: () => ({ isSocket: () => true }),
    });

    expect(assessment.dockerEndpointSocketMissing).toBeUndefined();
    expect(planHostAdvisories(assessment).map((action) => action.id)).toContain(
      "docker_group_permission",
    );
  });

  it("treats a non-socket at the selected path as no endpoint", () => {
    // A regular file or directory at the chosen path is exactly as unreachable
    // as nothing at all, so existence alone must not restore the group remedy.
    const assessment = assessHost({
      platform: "linux",
      release: "6.8.0-generic",
      procVersion: "Linux version 6.8.0-generic",
      env: { DOCKER_HOST: "unix:///tmp/not-a-socket" },
      dockerInfoOutput: "",
      commandExistsImpl,
      runCaptureImpl,
      statSyncImpl: () => ({ isSocket: () => false }),
    });

    expect(assessment.dockerEndpointSocketMissing).toBe("unix:///tmp/not-a-socket");
    const ids = planHostAdvisories(assessment).map((action) => action.id);
    expect(ids).toContain("docker_endpoint_socket_missing");
    expect(ids).not.toContain("docker_group_permission");
  });

  it("leaves the default endpoint to the stopped-daemon remedy", () => {
    // A missing default socket is exactly the case start_docker exists for, so
    // the absent-socket advisory must not take it over.
    const assessment = assessHost({
      platform: "linux",
      release: "6.8.0-generic",
      procVersion: "Linux version 6.8.0-generic",
      env: {},
      dockerInfoOutput: "",
      commandExistsImpl,
      runCaptureImpl: () => "",
      observeDockerAuthorityConflictImpl: () => null,
    });

    expect(assessment.dockerEndpointSocketMissing).toBeUndefined();
    const ids = planHostAdvisories(assessment).map((action) => action.id);
    expect(ids).toContain("start_docker");
    expect(ids).not.toContain("docker_endpoint_socket_missing");
  });

  it("does not report a socket as missing when access prevents inspection", () => {
    const assessment = assessHost({
      platform: "linux",
      release: "6.8.0-generic",
      procVersion: "Linux version 6.8.0-generic",
      env: { DOCKER_HOST: `unix://${DOCKER_SOCKET}` },
      dockerInfoOutput: "",
      commandExistsImpl,
      runCaptureImpl,
      statSyncImpl: () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });

    expect(assessment.dockerEndpointSocketMissing).toBeUndefined();
    const ids = planHostAdvisories(assessment).map((action) => action.id);
    expect(ids).not.toContain("docker_endpoint_socket_missing");
    expect(ids).toContain("docker_group_permission");
  });

  it("classifies a reduced context endpoint exactly like the DOCKER_HOST it became", () => {
    // Authority detection reduces a supported local socket to DOCKER_HOST before
    // assessment runs, so the context selector is gone by this point.
    const assessment = assessHost({
      platform: "linux",
      release: "6.8.0-generic",
      procVersion: "Linux version 6.8.0-generic",
      env: { DOCKER_HOST: `unix://${DOCKER_SOCKET}` },
      dockerInfoOutput: REACHABLE_DOCKER_INFO,
      dockerVersionOutput: "",
      commandExistsImpl,
      runCaptureImpl,
    });

    expect(assessment.dockerContextInvalid).toBeUndefined();
    expect(assessment.dockerHostInvalid).toBe(false);
    expect(assessment.dockerReachable).toBe(true);
  });
});

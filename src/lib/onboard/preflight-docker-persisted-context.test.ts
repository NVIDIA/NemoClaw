// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenshellSpawnSync } from "../adapters/openshell/client";
import {
  detectDockerHost,
  observeDockerAuthorityConflict,
  type DockerHostProbeResult,
} from "../platform";

const io = vi.hoisted(() => ({
  dockerSpawnSync: vi.fn(),
  realpathSync: vi.fn(),
  outputs: new Map<string, string>(),
  realpaths: new Map<string, string | Error>(),
}));

vi.mock("../adapters/docker/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker/exec")>()),
  dockerSpawnSync: io.dockerSpawnSync,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  io.realpathSync.mockImplementation((pathname: string) => {
    const resolved = io.realpaths.get(String(pathname));
    return resolved instanceof Error
      ? (() => {
          throw resolved;
        })()
      : (resolved ?? actual.realpathSync(pathname));
  });
  return { ...actual, realpathSync: io.realpathSync };
});

const COLIMA_SOCKET = "/Users/qa/.colima/default/docker.sock";
const COLIMA_HOST = `unix://${COLIMA_SOCKET}`;
const DEFAULT_SOCKET = "/var/run/docker.sock";
const PODMAN_SOCKET = "/Users/qa/.local/share/containers/podman/machine/podman.sock";
const CONTEXT_HOST_FORMAT = "{{.Endpoints.docker.Host}}";

function commandKey(args: readonly string[]): string {
  return args.join("\0");
}

function setContext(name: string, host: string): void {
  io.outputs.set(commandKey(["context", "show"]), `${name}\n`);
  io.outputs.set(commandKey(["context", "inspect", name, "--format", CONTEXT_HOST_FORMAT]), host);
}

function selectedContextOptions() {
  const probeDockerHost = vi.fn(() => ({ reachable: true, identity: "docker" as const }));
  const existsSync = vi.fn((pathname: string) => typeof io.realpaths.get(pathname) === "string");
  return {
    probeDockerHost,
    existsSync,
    options: {
      env: {},
      platform: "darwin" as const,
      home: "/Users/qa",
      probeDockerHost,
      existsSync,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  io.outputs.clear();
  io.realpaths.clear();
  io.realpaths.set(COLIMA_SOCKET, COLIMA_SOCKET);
  io.realpaths.set(
    DEFAULT_SOCKET,
    Object.assign(new Error("default socket is absent"), { code: "ENOENT" }),
  );
  io.dockerSpawnSync.mockImplementation((args: readonly string[]) => ({
    status: io.outputs.has(commandKey(args)) ? 0 : 1,
    stdout: io.outputs.get(commandKey(args)) ?? "",
    stderr: "",
    signal: null,
  }));
  setContext("colima", COLIMA_HOST);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("persisted Docker context authority", () => {
  it("exports the reachable Colima context when the default socket is absent (#12367)", () => {
    const { options, probeDockerHost } = selectedContextOptions();

    expect(detectDockerHost(options)).toEqual({
      dockerHost: COLIMA_HOST,
      source: "context",
      socketPath: null,
    });
    expect(probeDockerHost).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("passes the persisted context endpoint to OpenShell subprocesses", async () => {
    vi.stubEnv("DOCKER_HOST", undefined);
    vi.stubEnv("DOCKER_CONTEXT", undefined);
    vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", "docker");
    io.outputs.set(
      commandKey(["version", "--format", "{{json .}}"]),
      JSON.stringify({ Server: { Platform: { Name: "Docker Engine" } } }),
    );

    const { buildSubprocessEnv } = await import("../runner");

    expect(process.env.DOCKER_HOST).toBe(COLIMA_HOST);
    expect(buildSubprocessEnv().DOCKER_HOST).toBe(COLIMA_HOST);
    expect(buildSubprocessEnv().DOCKER_CONTEXT).toBeUndefined();

    const { runOpenshellCommand } = await import("../adapters/openshell/client");
    const spawnSyncImpl = vi.fn<OpenshellSpawnSync>(() => ({
      pid: 1,
      output: [],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    }));

    runOpenshellCommand("openshell", ["status"], { spawnSyncImpl });

    expect(spawnSyncImpl).toHaveBeenCalledExactlyOnceWith(
      "openshell",
      ["status"],
      expect.objectContaining({ env: expect.objectContaining({ DOCKER_HOST: COLIMA_HOST }) }),
    );
    expect(spawnSyncImpl.mock.calls[0]?.[2].env).not.toHaveProperty("DOCKER_CONTEXT");
  });

  it("keeps an explicit Docker host ahead of both context selectors", () => {
    const { options, probeDockerHost } = selectedContextOptions();

    expect(
      detectDockerHost({
        ...options,
        env: { DOCKER_HOST: "unix:///selected/docker.sock", DOCKER_CONTEXT: "chosen" },
      }),
    ).toEqual({ dockerHost: "unix:///selected/docker.sock", source: "env", socketPath: null });
    expect(probeDockerHost).not.toHaveBeenCalled();
    expect(io.dockerSpawnSync).not.toHaveBeenCalled();
  });

  it("keeps an explicit context ahead of the persisted context", () => {
    const { options, probeDockerHost } = selectedContextOptions();
    io.outputs.set(
      commandKey(["context", "inspect", "chosen", "--format", CONTEXT_HOST_FORMAT]),
      "unix:///selected/docker.sock",
    );

    expect(detectDockerHost({ ...options, env: { DOCKER_CONTEXT: "chosen" } })).toEqual({
      dockerHost: "unix:///selected/docker.sock",
      source: "context",
      socketPath: null,
    });
    expect(probeDockerHost).not.toHaveBeenCalled();
  });

  it("keeps an inconclusive ambient authority without selecting another socket", () => {
    const { options } = selectedContextOptions();
    const probeDockerHost = vi.fn(() => ({
      reachable: false,
      identity: "unknown" as const,
      inconclusive: true,
    }));

    expect(detectDockerHost({ ...options, probeDockerHost })).toBeNull();
    expect(probeDockerHost).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(io.dockerSpawnSync).not.toHaveBeenCalled();
  });

  it.each(["default", "", "invalid\ncontext"])(
    "keeps the ambient authority for an unusable persisted context %j",
    (name) => {
      setContext(name, COLIMA_HOST);
      expect(detectDockerHost(selectedContextOptions().options)).toBeNull();
    },
  );

  it("keeps the ambient authority when current context metadata is unavailable", () => {
    io.outputs.delete(commandKey(["context", "show"]));

    expect(detectDockerHost(selectedContextOptions().options)).toBeNull();
  });

  it("keeps the ambient authority when its persisted context endpoint is unavailable", () => {
    io.outputs.delete(
      commandKey(["context", "inspect", "colima", "--format", CONTEXT_HOST_FORMAT]),
    );

    expect(detectDockerHost(selectedContextOptions().options)).toBeNull();
  });

  it.each(["tcp://192.0.2.10:2375", "ssh://builder.example", "relative.sock"])(
    "does not export an unsupported persisted context endpoint %s",
    (host) => {
      setContext("colima", host);
      expect(detectDockerHost(selectedContextOptions().options)).toBeNull();
    },
  );

  it("keeps the default socket when the persisted context names that socket", () => {
    setContext("desktop-linux", `unix://${DEFAULT_SOCKET}`);

    expect(detectDockerHost(selectedContextOptions().options)).toBeNull();
  });

  it("keeps the default authority when both socket paths resolve to the same socket", () => {
    io.realpaths.set(COLIMA_SOCKET, "/private/run/docker.sock");
    io.realpaths.set(DEFAULT_SOCKET, "/private/run/docker.sock");

    expect(detectDockerHost(selectedContextOptions().options)).toBeNull();
  });

  it("retains engine-conflict refusal when the ambient daemon does not answer", () => {
    const { options } = selectedContextOptions();
    const observations = new Map<string, DockerHostProbeResult>([
      [COLIMA_HOST, { reachable: true, identity: "docker" as const }],
      [`unix://${PODMAN_SOCKET}`, { reachable: true, identity: "podman" as const }],
    ]);
    const probeDockerHost = vi.fn(
      (host: string | undefined) =>
        observations.get(host ?? "") ?? { reachable: false, identity: "unknown" as const },
    );

    expect(
      observeDockerAuthorityConflict({
        ...options,
        probeDockerHost,
        existsSync: (pathname) => [COLIMA_SOCKET, PODMAN_SOCKET].includes(pathname),
      }),
    ).toEqual({
      candidates: [
        { socketPath: COLIMA_SOCKET, identity: "docker" },
        { socketPath: PODMAN_SOCKET, identity: "podman" },
      ],
    });
  });
});

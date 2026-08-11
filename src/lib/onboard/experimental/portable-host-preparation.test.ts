// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { preparePortableExperimentalHost } from "./portable-host-preparation";

type SpawnResult = ReturnType<typeof spawnSync>;

function result(status = 0, stdout = ""): SpawnResult {
  return { status, stdout, stderr: "" } as SpawnResult;
}

describe("preparePortableExperimentalHost", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const tempDir of tempDirs) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("does nothing unless the portable profile is explicit", () => {
    const systemctl = vi.fn();
    const docker = vi.fn();
    const env: NodeJS.ProcessEnv = {};

    preparePortableExperimentalHost(env, { docker, systemctl });

    expect(env.DOCKER_HOST).toBeUndefined();
    expect(systemctl).not.toHaveBeenCalled();
    expect(docker).not.toHaveBeenCalled();
  });

  it("prepares the rootless socket and managed loopback registry deterministically", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const systemctl = vi.fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>(() =>
      result(),
    );
    const docker = vi
      .fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>()
      .mockReturnValueOnce(result()) // --version probe: docker-compatible CLI present
      .mockReturnValueOnce(result(1)) // inspect: registry not present yet
      .mockReturnValueOnce(result()); // run
    const podman = vi.fn(() => result(0, "/run/user/1001/custom/podman.sock\n"));
    const hardenSocketDirectory = vi.fn();
    const env: NodeJS.ProcessEnv = {
      CONTAINER_CONNECTION: "attacker",
      CONTAINER_HOST: "tcp://example.test:1234",
      CONTAINER_SSHKEY: "/tmp/attacker-key",
      NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
    };

    preparePortableExperimentalHost(env, {
      platform: "linux",
      home,
      uid: 1001,
      systemctl,
      podman,
      docker,
      hardenSocketDirectory,
    });

    expect(env).toMatchObject({
      CONTAINERS_CONF: path.join(home, ".config/nemoclaw/portable/containers.conf"),
      DOCKER_HOST: "unix:///run/user/1001/custom/podman.sock",
      NETAVARK_FW: "iptables",
    });
    expect(systemctl.mock.calls.map(([args]) => args)).toEqual([
      [
        "--user",
        "set-environment",
        "NETAVARK_FW=iptables",
        `CONTAINERS_CONF=${path.join(home, ".config/nemoclaw/portable/containers.conf")}`,
      ],
      ["--user", "try-restart", "podman.service"],
      ["--user", "enable", "--now", "podman.socket"],
    ]);
    expect(podman).toHaveBeenCalledWith(
      ["info", "--format", "{{.Host.RemoteSocket.Path}}"],
      expect.not.objectContaining({
        CONTAINER_CONNECTION: expect.anything(),
        CONTAINER_HOST: expect.anything(),
        CONTAINER_SSHKEY: expect.anything(),
      }),
    );
    for (const [, commandEnv] of docker.mock.calls) {
      expect(commandEnv).not.toHaveProperty("CONTAINER_CONNECTION");
      expect(commandEnv).not.toHaveProperty("CONTAINER_HOST");
      expect(commandEnv).not.toHaveProperty("CONTAINER_SSHKEY");
      expect(commandEnv.DOCKER_HOST).toBe("unix:///run/user/1001/custom/podman.sock");
    }
    expect(env.CONTAINER_HOST).toBe("tcp://example.test:1234");
    expect(hardenSocketDirectory).toHaveBeenCalledWith("/run/user/1001/custom/podman.sock", 1001);
    expect(docker.mock.calls[0]?.[0]).toEqual(["--version"]);
    expect(docker.mock.calls[2]?.[0]).toEqual([
      "run",
      "-d",
      "--name",
      "nemoclaw-portable-registry",
      "--label",
      "com.nvidia.nemoclaw.portable=1",
      "-p",
      "127.0.0.1:5000:5000",
      "--restart=always",
      "docker.io/library/registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373",
    ]);
    const registryConfig = path.join(
      home,
      ".config/containers/registries.conf.d/99-nemoclaw-portable.conf",
    );
    expect(fs.readFileSync(registryConfig, "utf-8")).toContain('location = "localhost:5000"');
    expect(fs.statSync(registryConfig).mode & 0o777).toBe(0o600);
    const containersConf = path.join(home, ".config/nemoclaw/portable/containers.conf");
    expect(fs.readFileSync(containersConf, "utf-8")).toContain(
      'default_rootless_network_cmd = "pasta"',
    );
    expect(fs.readFileSync(containersConf, "utf-8")).toContain('env = ["NETAVARK_FW=iptables"]');
    expect(fs.statSync(containersConf).mode & 0o777).toBe(0o600);
  });

  it("keeps the portable firewall driver in the Podman default search path (#8441)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const systemctl = vi.fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>(() =>
      result(),
    );
    const docker = vi
      .fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>()
      .mockReturnValueOnce(result()) // --version probe: docker-compatible CLI present
      .mockReturnValueOnce(result(1)) // inspect: registry not present yet
      .mockReturnValueOnce(result()); // run
    const podman = vi.fn(() => result(0, "/run/user/1001/podman/podman.sock\n"));

    preparePortableExperimentalHost(
      { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
      {
        platform: "linux",
        home,
        uid: 1001,
        systemctl,
        podman,
        docker,
        hardenSocketDirectory: vi.fn(),
      },
    );

    const dropIn = path.join(
      home,
      ".config/containers/containers.conf.d/99-nemoclaw-portable.conf",
    );
    expect(fs.readFileSync(dropIn, "utf-8")).toContain('firewall_driver = "iptables"');
    expect(fs.statSync(dropIn).mode & 0o777).toBe(0o600);
  });

  it("refuses to replace an unmanaged registry container", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const env: NodeJS.ProcessEnv = {
      NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
    };

    expect(() =>
      preparePortableExperimentalHost(env, {
        platform: "linux",
        home,
        uid: 1001,
        systemctl: () => result(),
        podman: () => result(0, "/run/user/1001/podman/podman.sock"),
        docker: () => result(0, "unexpected-owner"),
        hardenSocketDirectory: vi.fn(),
      }),
    ).toThrow(/unmanaged container/);
  });

  it("reports a bounded registry inspection failure before attempting startup", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const timeout = Object.assign(new Error("registry inspection timed out"), {
      code: "ETIMEDOUT",
    });
    const docker = vi.fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>(
      () =>
        ({
          error: timeout,
          output: [null, "", ""],
          pid: 1234,
          signal: "SIGKILL",
          status: null,
          stderr: "",
          stdout: "",
        }) as SpawnResult,
    );

    expect(() =>
      preparePortableExperimentalHost(
        { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
        {
          platform: "linux",
          home,
          uid: 1001,
          systemctl: () => result(),
          podman: () => result(0, "/run/user/1001/podman/podman.sock"),
          docker,
          hardenSocketDirectory: vi.fn(),
        },
      ),
    ).toThrow(/Inspecting the managed portable registry failed: registry inspection timed out/);
    // The --version probe tolerates a non-ENOENT error, then the inspect fails.
    expect(docker).toHaveBeenCalledTimes(2);
  });

  it("fails closed when Podman does not report an absolute local socket", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);

    expect(() =>
      preparePortableExperimentalHost(
        { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
        {
          platform: "linux",
          home,
          uid: 1001,
          systemctl: () => result(),
          podman: () => result(0, "tcp://127.0.0.1:1234"),
          docker: vi.fn(),
        },
      ),
    ).toThrow(/invalid socket path/);
  });

  it("names podman-docker and creates the registry only after a successful retry (#8453)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    // The `docker --version` probe returns a spawn ENOENT, i.e. no docker CLI.
    const docker = vi
      .fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>()
      .mockReturnValueOnce({
        error: Object.assign(new Error("spawnSync docker ENOENT"), { code: "ENOENT" }),
        output: [null, "", ""],
        pid: 0,
        signal: null,
        status: null,
        stderr: "",
        stdout: "",
      } as SpawnResult)
      .mockReturnValueOnce(result()) // retry probe: podman-docker is now present
      .mockReturnValueOnce(result(1)) // inspect: registry was not created by the failed attempt
      .mockReturnValueOnce(result()); // run
    const env: NodeJS.ProcessEnv = { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" };
    const deps = {
      platform: "linux" as const,
      home,
      uid: 1001,
      systemctl: () => result(),
      podman: () => result(0, "/run/user/1001/podman/podman.sock"),
      docker,
      hardenSocketDirectory: vi.fn(),
    };

    expect(() => preparePortableExperimentalHost(env, deps)).toThrow(/podman-docker/);
    // Fails on the CLI probe, before any registry inspect/run is attempted.
    expect(docker).toHaveBeenCalledTimes(1);
    expect(docker.mock.calls[0]?.[0]).toEqual(["--version"]);

    preparePortableExperimentalHost(env, deps);

    expect(docker.mock.calls.map(([args]) => args[0])).toEqual([
      "--version",
      "--version",
      "inspect",
      "run",
    ]);
  });
});

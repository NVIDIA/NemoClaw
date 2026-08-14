// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PodmanSocketAuthority } from "../../adapters/podman";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import { createPortableOnboardEnvironmentScope } from "../session-bootstrap";
import {
  portableHostPreparationInternals,
  preparePortableExperimentalHost,
} from "./portable-host-preparation";

type SpawnResult = ReturnType<typeof spawnSync>;

function result(status = 0, stdout = ""): SpawnResult {
  return { status, stdout, stderr: "" } as SpawnResult;
}

function runtimeAuthority(homeDir: string): CheckpointPortableRuntimeAuthority {
  return {
    schemaVersion: 1,
    kind: "podman",
    ownership: "current-user",
    uid: 1001,
    homeDir,
    configHome: path.join(homeDir, ".config"),
    runtimeDir: "/run/user/1001",
    socketPath: "/run/user/1001/podman/podman.sock",
  };
}

function socketAuthority(): PodmanSocketAuthority {
  return {
    directoryChain: [],
    device: "1",
    inode: "2",
    mode: String(0o140660),
    ownerUid: "1001",
    socketPath: "/run/user/1001/podman/podman.sock",
  };
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
      HOME: "/tmp/hostile-home",
      XDG_CONFIG_HOME: "/tmp/hostile-xdg-config",
      CONTAINER_CONNECTION: "attacker",
      CONTAINER_HOST: "tcp://example.test:1234",
      CONTAINER_SSHKEY: "/tmp/attacker-key",
      DOCKER_TLS: "1",
      DOCKER_TLS_VERIFY: "1",
      DOCKER_CERT_PATH: "/tmp/attacker-certs",
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
      validateConfigAuthority: vi.fn(),
    });

    expect(env).toMatchObject({
      CONTAINERS_CONF: path.join(home, ".config/nemoclaw/portable/containers.conf"),
      DOCKER_HOST: "unix:///run/user/1001/custom/podman.sock",
      NETAVARK_FW: "iptables",
    });
    expect(env.HOME).toBe("/tmp/hostile-home");
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/hostile-xdg-config");
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
      expect(commandEnv).not.toHaveProperty("DOCKER_TLS");
      expect(commandEnv).not.toHaveProperty("DOCKER_TLS_VERIFY");
      expect(commandEnv).not.toHaveProperty("DOCKER_CERT_PATH");
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
        validateConfigAuthority: vi.fn(),
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
        validateConfigAuthority: vi.fn(),
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
          validateConfigAuthority: vi.fn(),
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
          validateConfigAuthority: vi.fn(),
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
      validateConfigAuthority: vi.fn(),
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

  it("reuses a running managed registry (#9035)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const docker = vi
      .fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>()
      .mockReturnValueOnce(result())
      .mockReturnValueOnce(result(0, "1 true"));

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
        validateConfigAuthority: vi.fn(),
      },
    );

    expect(docker.mock.calls.map(([args]) => args[0])).toEqual(["--version", "inspect"]);
  });

  it("rejects a moved user home before config writes or socket activation", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    const movedHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-moved-"));
    tempDirs.push(home, movedHome);
    const systemctl = vi.fn(() => result());

    expect(() =>
      preparePortableExperimentalHost(
        { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
        {
          platform: "linux",
          home: movedHome,
          uid: 1001,
          systemctl,
          validateConfigAuthority: vi.fn(),
        },
        runtimeAuthority(home),
      ),
    ).toThrow(/does not match the current user or runtime kind/);
    expect(systemctl).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, ".config"))).toBe(false);
  });

  it("ignores hostile HOME and XDG authority selectors and restores them exactly (#9035)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const env: NodeJS.ProcessEnv = {
      HOME: "/tmp/hostile-home",
      XDG_CONFIG_HOME: "",
      NEMOCLAW_EXPERIMENTAL_PROFILE: "hostile-profile",
    };
    const before = { ...env };
    const scope = createPortableOnboardEnvironmentScope(env, null);
    const docker = vi
      .fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>()
      .mockReturnValueOnce(result())
      .mockReturnValueOnce(result(0, "1 true"));

    try {
      const prepared = preparePortableExperimentalHost(scope.env, {
        platform: "linux",
        home,
        uid: 1001,
        systemctl: () => result(),
        podman: () => result(0, "/run/user/1001/podman/podman.sock"),
        docker,
        hardenSocketDirectory: vi.fn(),
        validateConfigAuthority: vi.fn(),
      });
      expect(prepared?.authority.homeDir).toBe(home);
      expect(prepared?.authority.configHome).toBe(path.join(home, ".config"));
      expect(scope.env.HOME).toBe("/tmp/hostile-home");
      expect(scope.env.XDG_CONFIG_HOME).toBeUndefined();
      throw new Error("controlled failure");
    } catch (error) {
      expect(error).toMatchObject({ message: "controlled failure" });
    } finally {
      scope.restore();
    }

    expect(env).toEqual(before);
    expect(Object.prototype.hasOwnProperty.call(env, "XDG_CONFIG_HOME")).toBe(true);
    expect(env.XDG_CONFIG_HOME).toBe("");
  });

  it("rejects a stored alternate config root before any portable effect (#9035)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const systemctl = vi.fn(() => result());
    const validateConfigAuthority = vi.fn();
    const authority = {
      ...runtimeAuthority(home),
      configHome: path.join(home, "alternate-config"),
    };

    expect(() =>
      preparePortableExperimentalHost(
        {
          HOME: "/tmp/hostile-home",
          XDG_CONFIG_HOME: "/tmp/hostile-xdg-config",
          NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
        },
        {
          platform: "linux",
          home,
          uid: 1001,
          systemctl,
          validateConfigAuthority,
        },
        authority,
      ),
    ).toThrow(/configuration root does not match the current OS user home/);
    expect(validateConfigAuthority).not.toHaveBeenCalled();
    expect(systemctl).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, ".config"))).toBe(false);
  });

  it("rejects an unsafe pre-existing socket before config writes or activation", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const systemctl = vi.fn(() => result());
    const captureSocketAuthority = vi.fn(() => {
      throw new Error("Podman socket authority is owned by uid 2000; expected current uid 1001.");
    });

    expect(() =>
      preparePortableExperimentalHost(
        { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
        {
          platform: "linux",
          home,
          uid: 1001,
          systemctl,
          captureSocketAuthority,
          validateConfigAuthority: vi.fn(),
        },
        runtimeAuthority(home),
      ),
    ).toThrow(/owned by uid 2000/);
    expect(systemctl).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, ".config"))).toBe(false);
  });

  it("accepts reboot socket rotation and requalifies current Podman identity", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const missing = Object.assign(new Error("missing socket"), { code: "ENOENT" });
    const currentAuthority = socketAuthority();
    const captureSocketAuthority = vi
      .fn<(socketPath: string, uid: number) => PodmanSocketAuthority>()
      .mockImplementationOnce(() => {
        throw missing;
      })
      .mockReturnValueOnce(currentAuthority);
    const qualifyPodman = vi.fn();
    const assertSocketAuthority = vi.fn();
    const docker = vi
      .fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>()
      .mockReturnValueOnce(result())
      .mockReturnValueOnce(result(0, "1 true"));

    const prepared = preparePortableExperimentalHost(
      { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
      {
        platform: "linux",
        home,
        uid: 1001,
        systemctl: () => result(),
        podman: () => result(0, "/run/user/1001/podman/podman.sock"),
        docker,
        hardenSocketDirectory: vi.fn(),
        captureSocketAuthority,
        assertSocketAuthority,
        qualifyPodman,
        validateConfigAuthority: vi.fn(),
      },
      runtimeAuthority(home),
    );

    expect(prepared?.authority).toEqual(runtimeAuthority(home));
    expect(captureSocketAuthority).toHaveBeenCalledTimes(2);
    expect(qualifyPodman).toHaveBeenCalledWith(currentAuthority);
    expect(assertSocketAuthority).toHaveBeenCalledWith(currentAuthority);
  });

  it("rejects symlinked portable configuration authority (#9035)", () => {
    const home = fs.mkdtempSync(path.join(process.cwd(), "tmp-portable-authority-"));
    tempDirs.push(home);
    const runtimeDir = path.join(home, "runtime");
    const configTarget = path.join(home, "config-target");
    const configHome = path.join(home, "config-link");
    fs.mkdirSync(runtimeDir, { mode: 0o700 });
    fs.mkdirSync(configTarget, { mode: 0o700 });
    fs.symlinkSync(configTarget, configHome);

    expect(() =>
      portableHostPreparationInternals.validateOwnedConfigAuthority({
        homeDir: home,
        configHome,
        runtimeDir,
        socketPath: null,
        uid: process.getuid?.() ?? -1,
      }),
    ).toThrow(/not a real directory/);
  });

  it("rejects writable portable configuration authority (#9035)", () => {
    const home = fs.mkdtempSync(path.join(process.cwd(), "tmp-portable-authority-"));
    tempDirs.push(home);
    const configHome = path.join(home, "config");
    fs.mkdirSync(configHome, { mode: 0o770 });
    fs.chmodSync(configHome, 0o770);

    expect(() =>
      portableHostPreparationInternals.validateOwnedConfigAuthority({
        homeDir: home,
        configHome,
        runtimeDir: home,
        socketPath: null,
        uid: process.getuid?.() ?? -1,
      }),
    ).toThrow(/unsafe write permissions/);
  });
});

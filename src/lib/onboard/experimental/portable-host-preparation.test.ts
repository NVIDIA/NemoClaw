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
  cpuDelegationControllerPaths,
  inspectPortableCpuDelegation,
} from "./portable-cpu-delegation-preflight";
import {
  portableHostPreparationInternals,
  preparePortableExperimentalHost as preparePortableExperimentalHostUnchecked,
} from "./portable-host-preparation";

type SpawnResult = ReturnType<typeof spawnSync>;

function result(status = 0, stdout = ""): SpawnResult {
  return { status, stdout, stderr: "" } as SpawnResult;
}

function runtimeAuthority(
  homeDir: string,
  socketPath = "/run/user/1001/podman/podman.sock",
): CheckpointPortableRuntimeAuthority {
  return {
    schemaVersion: 1,
    kind: "podman",
    ownership: "current-user",
    uid: 1001,
    homeDir,
    configHome: path.join(homeDir, ".config"),
    runtimeDir: "/run/user/1001",
    socketPath,
  };
}

function socketAuthority(socketPath = "/run/user/1001/podman/podman.sock"): PodmanSocketAuthority {
  return {
    directoryChain: [],
    device: "1",
    inode: "2",
    mode: String(0o140660),
    ownerUid: "1001",
    socketPath,
  };
}

function successfulReadiness(home: string) {
  return {
    uid: 1001,
    home,
    hardenSocketDirectory: vi.fn(),
    captureSocketAuthority: (socketPath: string) => socketAuthority(socketPath),
    assertSocketAuthority: vi.fn(),
    podmanCapture: () => ({
      status: 0,
      stdout: JSON.stringify({ Server: { Version: "5.6.1" } }),
      stderr: "",
    }),
  };
}

function preparePortableExperimentalHost(
  env: NodeJS.ProcessEnv,
  deps: Parameters<typeof preparePortableExperimentalHostUnchecked>[1] = {},
  expectedAuthority?: CheckpointPortableRuntimeAuthority | null,
) {
  return preparePortableExperimentalHostUnchecked(
    env,
    {
      ...deps,
      // Tests run on hosts without the /sys/fs/cgroup hierarchy the portable
      // CPU-delegation preflight reads; default to a passing stub and inject
      // explicit results for the preflight wiring tests below.
      cpuDelegationPreflight:
        deps.cpuDelegationPreflight ?? (() => ({ ok: true, detail: "stubbed in tests" })),
      runtimeReadiness:
        deps.runtimeReadiness ??
        successfulReadiness(deps.home ?? expectedAuthority?.homeDir ?? os.userInfo().homedir),
    },
    expectedAuthority,
  );
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

  it("fails the portable preflight when the user hierarchy cannot enforce the CPU limit (#9188)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const systemctl = vi.fn<
      (args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs?: number) => SpawnResult
    >(() => result());
    const docker = vi.fn();
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
    };
    const cpuDelegationPreflight = () => ({
      ok: false,
      failure: "systemd-user-delegation-missing" as const,
      detail: "systemd did not delegate the cpu controller to the current user's manager.",
    });

    expect(() =>
      preparePortableExperimentalHost(env, {
        platform: "linux",
        home,
        uid: 1001,
        systemctl,
        docker,
        cpuDelegationPreflight,
      }),
    ).toThrow(/Portable CPU-delegation preflight failed/);

    // The gate must fire before any config write or service activation.
    expect(systemctl).not.toHaveBeenCalled();
    expect(docker).not.toHaveBeenCalled();
  });

  it("rejects malformed controller evidence before portable host effects (#9188)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const systemctl = vi.fn();
    const docker = vi.fn();
    const validateConfigAuthority = vi.fn();
    const paths = cpuDelegationControllerPaths(1001);
    const readControllerFileSync = vi.fn(() => Buffer.from("cpu memory\0Delegate=cpu"));

    expect(() =>
      preparePortableExperimentalHost(
        { HOME: home, NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
        {
          platform: "linux",
          home,
          uid: 1001,
          systemctl,
          docker,
          validateConfigAuthority,
          cpuDelegationPreflight: (deps) =>
            inspectPortableCpuDelegation({ ...deps, readControllerFileSync }),
        },
      ),
    ).toThrow(/controller evidence.*malformed/u);

    expect(validateConfigAuthority).not.toHaveBeenCalled();
    expect(readControllerFileSync).toHaveBeenCalledOnce();
    expect(readControllerFileSync).toHaveBeenCalledWith(paths.root, 4097);
    expect(systemctl).not.toHaveBeenCalled();
    expect(docker).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, ".config"))).toBe(false);
  });

  it("passes portable host preparation when the CPU-delegation preflight succeeds (#9188)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const systemctl = vi.fn<
      (args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs?: number) => SpawnResult
    >(() => result());
    const docker = vi
      .fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>()
      .mockReturnValueOnce(result()) // --version probe
      .mockReturnValueOnce(result(1)) // inspect: registry not present
      .mockReturnValueOnce(result()); // run
    const podman = vi.fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>(() =>
      result(0, "/run/user/1001/custom/podman.sock\n"),
    );
    const hardenSocketDirectory = vi.fn();
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
    };
    const cpuDelegationPreflight = () => ({ ok: true, detail: "cpu delegated" });

    const prepared = preparePortableExperimentalHost(env, {
      platform: "linux",
      home,
      uid: 1001,
      systemctl,
      podman,
      docker,
      hardenSocketDirectory,
      validateConfigAuthority: vi.fn(),
      cpuDelegationPreflight,
    });

    expect(prepared).not.toBeNull();
    expect(prepared?.authority.uid).toBe(1001);
  });

  it("prepares the rootless socket and managed loopback registry deterministically", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const systemctl = vi.fn<
      (args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs?: number) => SpawnResult
    >(() => result());
    const docker = vi
      .fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>()
      .mockReturnValueOnce(result()) // --version probe: docker-compatible CLI present
      .mockReturnValueOnce(result(1)) // inspect: registry not present yet
      .mockReturnValueOnce(result()); // run
    const podman = vi.fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>(() =>
      result(0, "/run/user/1001/custom/podman.sock\n"),
    );
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

    preparePortableExperimentalHost(
      env,
      {
        platform: "linux",
        home,
        uid: 1001,
        systemctl,
        podman,
        docker,
        hardenSocketDirectory,
        validateConfigAuthority: vi.fn(),
      },
      runtimeAuthority(home, "/run/user/1001/custom/podman.sock"),
    );

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
      ["--user", "is-active", "--quiet", "podman.service"],
    ]);
    expect(systemctl.mock.calls[2]?.[2]).toBe(10_000);
    expect(podman).not.toHaveBeenCalled();
    docker.mock.calls.forEach(([, commandEnv]) => {
      expect(commandEnv).not.toHaveProperty("CONTAINER_CONNECTION");
      expect(commandEnv).not.toHaveProperty("CONTAINER_HOST");
      expect(commandEnv).not.toHaveProperty("CONTAINER_SSHKEY");
      expect(commandEnv).not.toHaveProperty("DOCKER_TLS");
      expect(commandEnv).not.toHaveProperty("DOCKER_TLS_VERIFY");
      expect(commandEnv).not.toHaveProperty("DOCKER_CERT_PATH");
      expect(commandEnv.DOCKER_HOST).toBe("unix:///run/user/1001/custom/podman.sock");
    });
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

  it("forwards readiness deadlines to injected host command adapters (#9070)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const systemctl = vi.fn<
      (args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs?: number) => SpawnResult
    >(() => result());
    const podman = vi.fn((_args: readonly string[], _env: NodeJS.ProcessEnv, _timeoutMs?: number) =>
      result(0, JSON.stringify({ Server: { Version: "5.6.1" } })),
    );
    const docker = vi
      .fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>()
      .mockReturnValueOnce(result())
      .mockReturnValueOnce(result(1))
      .mockReturnValueOnce(result());

    preparePortableExperimentalHost(
      { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
      {
        platform: "linux",
        home,
        uid: 1001,
        systemctl,
        podman,
        docker,
        captureSocketAuthority: (socketPath) => socketAuthority(socketPath),
        validateConfigAuthority: vi.fn(),
        runtimeReadiness: {
          uid: 1001,
          home,
          now: () => 0,
          hardenSocketDirectory: vi.fn(),
          captureSocketAuthority: (socketPath) => socketAuthority(socketPath),
          assertSocketAuthority: vi.fn(),
        },
      },
      runtimeAuthority(home),
    );

    expect(systemctl.mock.calls[2]?.[2]).toBe(10_000);
    expect(podman.mock.calls[0]?.[2]).toBe(10_000);
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

  it("fails closed when the recorded authority is not an absolute local socket", () => {
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
          podman: vi.fn(),
          docker: vi.fn(),
          validateConfigAuthority: vi.fn(),
        },
        runtimeAuthority(home, "tcp://127.0.0.1:1234"),
      ),
    ).toThrow(/socket path/);
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

  it("rejects unsafe config authority before Podman discovery (#9083)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const systemctl = vi.fn(() => result());
    const podman = vi.fn(() => result(0, "/run/user/1001/podman/podman.sock"));
    const validateConfigAuthority = vi.fn(() => {
      throw new Error("Portable runtime configuration authority is unsafe.");
    });

    expect(() =>
      preparePortableExperimentalHost(
        { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
        {
          platform: "linux",
          home,
          uid: 1001,
          systemctl,
          podman,
          validateConfigAuthority,
        },
        runtimeAuthority(home),
      ),
    ).toThrow(/configuration authority is unsafe/);
    expect(validateConfigAuthority).toHaveBeenCalledOnce();
    expect(podman).not.toHaveBeenCalled();
    expect(systemctl).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, ".config"))).toBe(false);
  });

  it("keeps a missing recorded endpoint bound through activation (#9070)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const staleSocket = "/run/user/1001/stale/podman.sock";
    const currentSocket = "/run/user/1001/podman/podman.sock";
    const missing = Object.assign(new Error("missing socket"), { code: "ENOENT" });
    const systemctl = vi.fn(() => result());
    const podman = vi.fn(() => result(0, currentSocket));
    const docker = vi.fn(() => result());
    const hardenSocketDirectory = vi.fn();
    const qualifyPodman = vi.fn();
    const captureSocketAuthority = vi.fn(() => {
      throw missing;
    });
    const env: NodeJS.ProcessEnv = {
      NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
      CONTAINER_CONNECTION: "hostile-connection",
      CONTAINER_HOST: "tcp://example.test:1234",
      CONTAINER_SSHKEY: "/tmp/hostile-key",
    };

    expect(() =>
      preparePortableExperimentalHost(
        env,
        {
          platform: "linux",
          home,
          uid: 1001,
          systemctl,
          podman,
          docker,
          hardenSocketDirectory,
          captureSocketAuthority,
          qualifyPodman,
          validateConfigAuthority: vi.fn(),
        },
        runtimeAuthority(home, staleSocket),
      ),
    ).toThrow(/socket authority/);
    expect(captureSocketAuthority).toHaveBeenCalledWith(staleSocket, 1001);
    expect(podman).not.toHaveBeenCalled();
    expect(systemctl).toHaveBeenCalledTimes(3);
    expect(docker).not.toHaveBeenCalled();
    expect(hardenSocketDirectory).toHaveBeenCalledWith(staleSocket, 1001);
    expect(qualifyPodman).not.toHaveBeenCalled();
    expect(env.NETAVARK_FW).toBe("iptables");
    expect(env.CONTAINERS_CONF).toBe(path.join(home, ".config/nemoclaw/portable/containers.conf"));
    expect(fs.existsSync(path.join(home, ".config"))).toBe(true);
  });

  it("stops an authority outside the current-user runtime before portable effects (#9083)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const systemctl = vi.fn(() => result());
    const docker = vi.fn(() => result());
    const podman = vi.fn();

    expect(() =>
      preparePortableExperimentalHost(
        { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
        {
          platform: "linux",
          home,
          uid: 1001,
          systemctl,
          podman,
          docker,
          captureSocketAuthority: vi.fn(() => {
            throw Object.assign(new Error("missing socket"), { code: "ENOENT" });
          }),
          validateConfigAuthority: vi.fn(),
        },
        runtimeAuthority(home, "/run/user/2002/podman/podman.sock"),
      ),
    ).toThrow(/outside the current user runtime directory/);
    expect(systemctl).not.toHaveBeenCalled();
    expect(docker).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, ".config"))).toBe(false);
  });

  it("rejects an unavailable recorded endpoint after activation (#9070)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const expectedSocket = "/run/user/1001/custom/podman.sock";
    const systemctl = vi.fn(() => result());
    const podman = vi
      .fn<(args: readonly string[], env: NodeJS.ProcessEnv) => SpawnResult>()
      .mockReturnValueOnce(result(0, expectedSocket))
      .mockReturnValueOnce(result(0, "/run/user/1001/podman/podman.sock"));
    const docker = vi.fn(() => result());
    const hardenSocketDirectory = vi.fn();
    const qualifyPodman = vi.fn();

    expect(() =>
      preparePortableExperimentalHost(
        { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
        {
          platform: "linux",
          home,
          uid: 1001,
          systemctl,
          podman,
          docker,
          hardenSocketDirectory,
          qualifyPodman,
          captureSocketAuthority: vi.fn(() => {
            throw Object.assign(new Error("missing socket"), { code: "ENOENT" });
          }),
          validateConfigAuthority: vi.fn(),
        },
        runtimeAuthority(home, expectedSocket),
      ),
    ).toThrow(/socket authority/);
    expect(systemctl).toHaveBeenCalledTimes(3);
    expect(podman).not.toHaveBeenCalled();
    expect(hardenSocketDirectory).toHaveBeenCalledWith(expectedSocket, 1001);
    expect(qualifyPodman).not.toHaveBeenCalled();
    expect(docker).not.toHaveBeenCalled();
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

  it.each([
    ["canonical", "/run/user/1001/podman/podman.sock"],
    ["custom", "/run/user/1001/custom/podman.sock"],
  ])(
    "accepts reboot socket rotation for a %s endpoint and requalifies Podman (#9083)",
    (_, socketPath) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
      tempDirs.push(home);
      const missing = Object.assign(new Error("missing socket"), { code: "ENOENT" });
      const currentAuthority = socketAuthority(socketPath);
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
          podman: () => result(0, socketPath),
          docker,
          hardenSocketDirectory: vi.fn(),
          captureSocketAuthority,
          assertSocketAuthority,
          qualifyPodman,
          validateConfigAuthority: vi.fn(),
        },
        runtimeAuthority(home, socketPath),
      );

      expect(prepared?.authority).toEqual(runtimeAuthority(home, socketPath));
      expect(captureSocketAuthority).toHaveBeenCalledTimes(2);
      expect(qualifyPodman).toHaveBeenCalledWith(currentAuthority);
      expect(assertSocketAuthority).toHaveBeenCalledWith(currentAuthority);
    },
  );

  it("stops a post-activation qualification failure before registry work (#9083)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-"));
    tempDirs.push(home);
    const socketPath = "/run/user/1001/custom/podman.sock";
    const missing = Object.assign(new Error("missing socket"), { code: "ENOENT" });
    const currentAuthority = socketAuthority(socketPath);
    const captureSocketAuthority = vi
      .fn<(socketPath: string, uid: number) => PodmanSocketAuthority>()
      .mockImplementationOnce(() => {
        throw missing;
      })
      .mockReturnValueOnce(currentAuthority);
    const systemctl = vi.fn(() => result());
    const docker = vi.fn(() => result());
    const qualifyPodman = vi.fn(() => {
      throw new Error("Podman identity qualification failed.");
    });

    expect(() =>
      preparePortableExperimentalHost(
        { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
        {
          platform: "linux",
          home,
          uid: 1001,
          systemctl,
          podman: () => result(0, socketPath),
          docker,
          hardenSocketDirectory: vi.fn(),
          captureSocketAuthority,
          qualifyPodman,
          validateConfigAuthority: vi.fn(),
        },
        runtimeAuthority(home, socketPath),
      ),
    ).toThrow(/Podman identity qualification failed/);
    expect(systemctl).toHaveBeenCalledTimes(3);
    expect(captureSocketAuthority).toHaveBeenCalledTimes(2);
    expect(docker).not.toHaveBeenCalled();
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
    ).toThrow(/not a real directory|unsafe write permissions/);
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

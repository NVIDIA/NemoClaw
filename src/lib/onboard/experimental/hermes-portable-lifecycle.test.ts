// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../agent/defs";
import { withMcpLifecycleLockSync } from "../../state/mcp-lifecycle-lock";
import type { SandboxEntry } from "../../state/registry";
import { fingerprintOpenShellSandboxLiveIdentity } from "../../adapters/openshell/sandbox-identity";
import type { HermesPortableOpenShellExecutableAuthority } from "../../adapters/openshell/resolve-shared";
import type { PodmanExecutableAuthorityDeps, PodmanExecutableStat } from "../../adapters/podman";
import type { ContainerEngineCommandCapture } from "../../adapters/container-engine";
import type { HermesPortablePodmanExecutableAuthority } from "./hermes-portable-podman-authority";
import { hermesPortableContainerInternals } from "./hermes-portable-container";
import { resolveHermesPortableStartupContract } from "./hermes-portable-contract";
import {
  hermesPortableLifecycleInternals,
  prepareHermesPortableSandboxRemoval,
  recoverHermesPortableSandboxLifecycle,
  stopHermesPortableSandboxLifecycle,
} from "./hermes-portable-lifecycle";
import { hermesPortableCreatePolicySemanticDigest } from "./hermes-portable-policy-authority";
import {
  captureHermesPortablePolicySource,
  publishHermesPortableDurablePolicySource,
  publishHermesPortableLifecycleReceipt,
  type HermesPortableConfiguredReceipt,
  type HermesPortablePendingReceipt,
} from "./hermes-portable-receipt";

const SANDBOX = "alpha";
const GATEWAY = "nemoclaw";
const GENERATION = "generation-1";
const CONTAINER_ID = "a".repeat(64);
const IMAGE = "b".repeat(64);
const SANDBOX_ID = "sandbox-id-1";
const POLICY = "version: 1\nnetwork_policies: {}\n";
const LIVE = `Name: ${SANDBOX}\nID: ${SANDBOX_ID}\nPhase: Ready\n`;
const LABELS = {
  "openshell.managed": "true",
  "openshell.ai/sandbox-id": SANDBOX_ID,
  "openshell.ai/sandbox-name": SANDBOX,
  "openshell.ai/sandbox-namespace": "",
  "openshell.ai/sandbox-workspace": "default",
};

function sandboxListJson(sandboxId: string, phase: string): string {
  return JSON.stringify([
    {
      id: sandboxId,
      name: SANDBOX,
      labels: {},
      resource_version: 1,
      created_at: "2026-01-01T00:00:00Z",
      phase,
      current_policy_version: 1,
    },
  ]);
}

let stateDir: string;
let policyPath: string;

function startupArgv() {
  return [
    "env",
    "NEMOCLAW_HERMES_API_PORT=8642",
    `NEMOCLAW_SANDBOX_NAME=${SANDBOX}`,
    "/usr/local/bin/nemoclaw-start",
  ];
}

function poisonUnexpectedCommand(scope: string, args: readonly string[]): never {
  throw new Error(`unexpected ${scope} command: ${args.join(" ")}`);
}

function directoryChain(directory: string): string[] {
  const parent = path.dirname(directory);
  return parent === directory ? [directory] : [directory, ...directoryChain(parent)];
}

function openshellExecutableAuthority(): HermesPortableOpenShellExecutableAuthority {
  return {
    version: "0.0.106",
    executable: {
      executablePath: "/usr/bin/openshell",
      device: "1",
      inode: "10",
      mode: String(0o100755),
      ownerUid: "0",
      size: "1024",
      modifiedTimeNanoseconds: "11",
      changedTimeNanoseconds: "12",
      sha256: "f".repeat(64),
      directoryChain: ["/usr/bin", "/usr", "/"].map((directory, index) => ({
        device: "1",
        inode: String(index + 20),
        mode: String(0o40755),
        ownerUid: "0",
        path: directory,
      })),
    },
  };
}

function podmanExecutableAuthority(): HermesPortablePodmanExecutableAuthority {
  const bytes = Buffer.from("podman-5.7.0-test", "utf8");
  return {
    version: "5.7.0",
    executable: {
      executablePath: "/usr/bin/podman",
      device: "1",
      inode: "30",
      mode: String(0o100755),
      ownerUid: "0",
      size: String(bytes.byteLength),
      modifiedTimeNanoseconds: "31",
      changedTimeNanoseconds: "32",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      directoryChain: ["/usr/bin", "/usr", "/"].map((directory, index) => ({
        device: "1",
        inode: String(index + 40),
        mode: String(0o40755),
        ownerUid: "0",
        path: directory,
      })),
    },
  };
}

function podmanExecutableAuthorityDeps(): PodmanExecutableAuthorityDeps {
  const bytes = Buffer.from("podman-5.7.0-test", "utf8");
  const stat = (filePath: string): PodmanExecutableStat => ({
    dev: 1n,
    ino:
      filePath === "/usr/bin/podman"
        ? 30n
        : filePath === "/usr/bin"
          ? 40n
          : filePath === "/usr"
            ? 41n
            : 42n,
    mode: filePath === "/usr/bin/podman" ? 0o100755n : 0o40755n,
    uid: 0n,
    size: filePath === "/usr/bin/podman" ? BigInt(bytes.byteLength) : 0n,
    mtimeNs: 31n,
    ctimeNs: 32n,
    isDirectory: () => filePath !== "/usr/bin/podman",
    isFile: () => filePath === "/usr/bin/podman",
    isSymbolicLink: () => false,
  });
  return {
    uid: process.getuid!(),
    lstat: stat,
    readFile: () => bytes,
    realpath: (filePath) => filePath,
  };
}

function activeReceipt(): HermesPortableConfiguredReceipt {
  const uid = process.getuid!();
  const socketPath = `/run/user/${String(uid)}/podman/podman.sock`;
  const transactionId = randomUUID();
  const policyBytes = fs.readFileSync(policyPath);
  const policy = publishHermesPortableDurablePolicySource({
    sandboxName: SANDBOX,
    transactionId,
    stateDir,
    intendedSemanticSha256: hermesPortableCreatePolicySemanticDigest(policyBytes),
    source: captureHermesPortablePolicySource(policyPath),
    hooks: { assertLifecycleLock: () => undefined },
  });
  const pending: HermesPortablePendingReceipt = {
    schemaVersion: 5,
    agent: "hermes",
    phase: "pending",
    transactionId,
    createIntentSha256: "c".repeat(64),
    sandboxName: SANDBOX,
    gatewayName: GATEWAY,
    lifecycleGeneration: GENERATION,
    runtimeAuthority: {
      schemaVersion: 1,
      kind: "podman",
      ownership: "current-user",
      uid,
      homeDir: "/home/test",
      configHome: "/home/test/.config",
      runtimeDir: `/run/user/${String(uid)}`,
      socketPath,
    },
    openshellExecutableAuthority: openshellExecutableAuthority(),
    podmanExecutableAuthority: podmanExecutableAuthority(),
    socketAuthority: {
      device: "1",
      inode: "2",
      mode: String(0o140600),
      ownerUid: String(uid),
      socketPath,
      directoryChain: directoryChain(path.dirname(socketPath)).map((directory, index) => ({
        device: "1",
        inode: String(index + 3),
        mode: String(index === 0 ? 0o40700 : 0o40755),
        ownerUid: String(index === 0 ? uid : 0),
        path: directory,
      })),
    },
    startup: resolveHermesPortableStartupContract({
      agent: loadAgent("hermes"),
      sandboxName: SANDBOX,
      startupArgv: startupArgv(),
    }),
    policy,
  };
  const first = publishHermesPortableLifecycleReceipt(pending, stateDir, {
    assertLifecycleLock: () => undefined,
  });
  const configuring: HermesPortableConfiguredReceipt = {
    ...pending,
    phase: "configuring",
    previousPhaseSha256: first.sha256,
    verifiedLivePolicySemanticSha256: policy.intendedSemanticSha256,
    container: {
      containerId: CONTAINER_ID,
      sandboxId: SANDBOX_ID,
      imageId: `sha256:${IMAGE}`,
      labelsSha256: hermesPortableContainerInternals.labelsDigest(LABELS),
      name: `openshell-default--${SANDBOX}-${SANDBOX_ID}`,
      running: true,
      restartPolicy: "no",
    },
  };
  const second = publishHermesPortableLifecycleReceipt(configuring, stateDir, {
    assertLifecycleLock: () => undefined,
  });
  const active: HermesPortableConfiguredReceipt = {
    ...configuring,
    phase: "active",
    previousPhaseSha256: second.sha256,
    container: { ...configuring.container, restartPolicy: "unless-stopped" },
  };
  publishHermesPortableLifecycleReceipt(active, stateDir, {
    assertLifecycleLock: () => undefined,
  });
  return active;
}

function lifecycleDeps(receipt: HermesPortableConfiguredReceipt, initiallyRunning = true) {
  let running = initiallyRunning;
  const podman = vi.fn((args: readonly string[]) => {
    const actions = {
      inspect: () => ({
        status: 0,
        stdout: JSON.stringify([
          {
            Id: CONTAINER_ID,
            Image: IMAGE,
            Name: receipt.container.name,
            Config: { Labels: LABELS },
            State: { Running: running, Paused: false, Status: running ? "running" : "exited" },
            HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
          },
        ]),
        stderr: "",
      }),
      exec: () => ({ status: 0, stdout: "200\n", stderr: "" }),
      start: () => {
        running = true;
        return { status: 0, stdout: "", stderr: "" };
      },
      stop: () => {
        running = false;
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const action = actions[args[1] as keyof typeof actions];
    return action?.() ?? poisonUnexpectedCommand("podman", args);
  });
  const liveIdentityFingerprint = fingerprintOpenShellSandboxLiveIdentity(LIVE)!;
  const captureOpenShell = vi.fn((args: readonly string[]) => {
    const responses = {
      "policy:get": { status: 0, stdout: POLICY, stderr: "" },
      "sandbox:list": { status: 0, stdout: LIVE, stderr: "" },
      "sandbox:get": { status: 0, stdout: LIVE, stderr: "" },
      "sandbox:exec": { status: 0, stdout: "", stderr: "" },
    };
    return (
      responses[args.slice(0, 2).join(":") as keyof typeof responses] ??
      poisonUnexpectedCommand("OpenShell", args)
    );
  });
  return {
    deps: {
      stateDir,
      env: {
        HOME: "/home/test",
        PATH: "/usr/bin",
        XDG_CONFIG_HOME: "/home/test/.config",
        XDG_RUNTIME_DIR: `/run/user/${String(process.getuid!())}`,
      },
      readRegistry: () =>
        ({
          name: SANDBOX,
          agent: "hermes",
          openshellDriver: "docker",
          gatewayName: GATEWAY,
          lifecycleGeneration: GENERATION,
          lifecycleLiveIdentityFingerprint: liveIdentityFingerprint,
          openshellVersion: "0.0.106",
        }) as SandboxEntry,
      captureOpenShell,
      assertOpenShellExecutableAuthority: vi.fn(() => "/usr/bin/openshell"),
      launchOpenShell: vi.fn(),
      container: { podman, assertSocketAuthority: vi.fn() },
      sleep: vi.fn(),
    },
    podman,
    captureOpenShell,
  };
}

function lifecycleContext() {
  return {
    agent: "hermes",
    gatewayName: GATEWAY,
    lifecycleGeneration: GENERATION,
    openshellDriver: "docker",
    provider: "ollama",
  };
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-lifecycle-"));
  policyPath = path.join(stateDir, "policy.yaml");
  fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("Hermes portable lifecycle", () => {
  it("passes only private state, terminal, locale, and TLS variables to child commands (#9203)", () => {
    const runtimeAuthority = {
      schemaVersion: 1 as const,
      kind: "podman" as const,
      ownership: "current-user" as const,
      uid: process.getuid!(),
      homeDir: "/home/test",
      configHome: "/home/test/.config",
      runtimeDir: "/run/user/1000",
      socketPath: "/run/user/1000/podman/podman.sock",
    };
    const sourceEnv = {
      HOME: "/home/test",
      PATH: "/usr/bin",
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      XDG_CONFIG_HOME: "/home/test/.config",
      XDG_RUNTIME_DIR: "/run/user/1000",
      XDG_CACHE_HOME: "/tmp/ambient-cache",
      HTTPS_PROXY: "http://127.0.0.1:8118",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      DOCKER_HOST: "unix:///run/docker.sock",
      KUBECONFIG: "/home/test/.kube/config",
      SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.sock",
      OPENSHELL_GATEWAY: "ambient",
      OPENSHELL_GATEWAY_ENDPOINT: "https://ambient.example",
      NVIDIA_INFERENCE_API_KEY: "do-not-forward",
      GITHUB_TOKEN: "do-not-forward",
      AWS_SECRET_ACCESS_KEY: "do-not-forward",
    };
    const env = hermesPortableLifecycleInternals.buildHermesPortableOpenShellEnv(
      sourceEnv,
      runtimeAuthority,
    );

    expect(env).toMatchObject({
      HOME: "/home/test",
      PATH: "/usr/bin",
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      XDG_CONFIG_HOME: "/home/test/.config",
      XDG_RUNTIME_DIR: "/run/user/1000",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
    });
    expect(env).not.toHaveProperty("HTTPS_PROXY");
    expect(env).not.toHaveProperty("XDG_CACHE_HOME");
    expect(env).not.toHaveProperty("DOCKER_HOST");
    expect(env).not.toHaveProperty("KUBECONFIG");
    expect(env).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(env).not.toHaveProperty("OPENSHELL_GATEWAY");
    expect(env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    expect(env).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(() =>
      hermesPortableLifecycleInternals.buildHermesPortableOpenShellEnv(
        { ...sourceEnv, XDG_CONFIG_HOME: "/tmp/other-config" },
        runtimeAuthority,
      ),
    ).toThrow("XDG_CONFIG_HOME disagrees with runtime authority");
  });

  it("constructs production Podman dependencies from the receipt authority (#9203)", () => {
    const receipt = activeReceipt();
    const capture = vi.fn<ContainerEngineCommandCapture>(
      (_executable, args, _timeoutMs, _input, environment) => {
        expect(environment).toEqual({
          HOME: receipt.runtimeAuthority.homeDir,
          XDG_CONFIG_HOME: receipt.runtimeAuthority.configHome,
          XDG_RUNTIME_DIR: receipt.runtimeAuthority.runtimeDir,
        });
        const operation = args.includes("version")
          ? "version"
          : args.includes("info")
            ? "info"
            : "business";
        const responses = {
          version: {
            status: 0,
            stdout: JSON.stringify({
              Client: { Version: "5.7.0" },
              Server: { Version: "5.7.0" },
            }),
            stderr: "",
          },
          info: {
            status: 0,
            stdout: JSON.stringify({
              host: {
                arch: "amd64",
                os: "linux",
                cgroupVersion: "v2",
                networkBackend: "netavark",
                security: { rootless: true },
                idMappings: {
                  uidmap: [
                    { container_id: 0, host_id: receipt.runtimeAuthority.uid, size: 1 },
                    { container_id: 1, host_id: 100000, size: 65536 },
                  ],
                  gidmap: [
                    { container_id: 0, host_id: receipt.runtimeAuthority.uid, size: 1 },
                    { container_id: 1, host_id: 100000, size: 65536 },
                  ],
                },
              },
            }),
            stderr: "",
          },
          business: { status: 0, stdout: "exact container", stderr: "" },
        } as const;
        return responses[operation];
      },
    );
    const container = hermesPortableLifecycleInternals.createContainerDeps(
      receipt,
      {
        HOME: receipt.runtimeAuthority.homeDir,
        PATH: "/usr/bin",
        XDG_CONFIG_HOME: receipt.runtimeAuthority.configHome,
        XDG_RUNTIME_DIR: receipt.runtimeAuthority.runtimeDir,
      },
      {
        capture,
        executableAuthorityDeps: podmanExecutableAuthorityDeps(),
        assertSocketAuthority: vi.fn(),
        resolveExecutablePath: () => receipt.podmanExecutableAuthority.executable.executablePath,
        platform: "linux",
        architecture: "x64",
        uid: receipt.runtimeAuthority.uid,
      },
    );

    expect(container.podman(["container", "inspect", CONTAINER_ID], 5_000)).toMatchObject({
      status: 0,
      stdout: "exact container",
    });
    expect(capture).toHaveBeenLastCalledWith(
      receipt.podmanExecutableAuthority.executable.executablePath,
      [
        "--url",
        `unix://${receipt.socketAuthority.socketPath}`,
        "container",
        "inspect",
        CONTAINER_ID,
      ],
      5_000,
      undefined,
      expect.any(Object),
    );
  });

  it("starts and proves exact receipt-owned authenticated health without Docker (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman } = lifecycleDeps(receipt, false);

    const result = withMcpLifecycleLockSync(
      SANDBOX,
      () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), deps),
      { stateDir: path.join(stateDir, "state") },
    );

    expect(result).toEqual({ kind: "recovered" });
    expect(podman.mock.calls.some(([args]) => args[1] === "start")).toBe(true);
    expect(podman.mock.calls.every(([args]) => !String(args[0]).includes("docker"))).toBe(true);
  });

  it("rejects an ambient OpenShell endpoint before Podman or OpenShell effects (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman, captureOpenShell } = lifecycleDeps(receipt, false);
    const endpointDeps = {
      ...deps,
      env: { OPENSHELL_GATEWAY_ENDPOINT: "https://ambient.example" },
    };

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), endpointDeps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("OPENSHELL_GATEWAY_ENDPOINT is set");
    expect(podman).not.toHaveBeenCalled();
    expect(captureOpenShell).not.toHaveBeenCalled();
  });

  it("revalidates identity after the stop callback and stops one full ID (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman } = lifecycleDeps(receipt);

    const result = withMcpLifecycleLockSync(
      SANDBOX,
      () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), deps),
      { stateDir: path.join(stateDir, "state") },
    );

    expect(result).toEqual({ kind: "stopped" });
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toEqual([
      [["container", "stop", CONTAINER_ID], 40_000],
    ]);
  });

  it("reconciles a receipt-owned stopping state without another stop command (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman } = lifecycleDeps(receipt, false);
    let inspectionCount = 0;
    podman.mockImplementation((args: readonly string[]) => {
      inspectionCount += args[1] === "inspect" ? 1 : 0;
      const status = inspectionCount < 4 ? "stopping" : "exited";
      return args[1] === "inspect"
        ? {
            status: 0,
            stdout: JSON.stringify([
              {
                Id: CONTAINER_ID,
                Image: IMAGE,
                Name: receipt.container.name,
                Config: { Labels: LABELS },
                State: { Running: false, Paused: false, Status: status },
                HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
              },
            ]),
            stderr: "",
          }
        : poisonUnexpectedCommand("podman", args);
    });
    let now = 0;

    const result = withMcpLifecycleLockSync(
      SANDBOX,
      () =>
        stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), {
          ...deps,
          now: () => now,
          sleep: (milliseconds) => {
            now += milliseconds;
          },
        }),
      { stateDir: path.join(stateDir, "state") },
    );

    expect(result).toEqual({ kind: "stopped" });
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toEqual([]);
  });

  it("fails closed when OpenShell same-name identity changes (#9203)", () => {
    const receipt = activeReceipt();
    const { deps } = lifecycleDeps(receipt);
    deps.captureOpenShell = vi.fn((args: readonly string[]) =>
      args[0] === "policy"
        ? { status: 0, stdout: POLICY, stderr: "" }
        : { status: 0, stdout: `Name: ${SANDBOX}\nID: replacement\nPhase: Ready\n`, stderr: "" },
    );

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("OpenShell sandbox identity disagrees");
  });

  it("fails closed when the exact OpenShell sandbox is no longer Ready (#9608)", () => {
    const receipt = activeReceipt();
    const { deps, podman } = lifecycleDeps(receipt);
    deps.captureOpenShell = vi.fn((args: readonly string[]) =>
      args[0] === "policy"
        ? { status: 0, stdout: POLICY, stderr: "" }
        : {
            status: 0,
            stdout: `Name: ${SANDBOX}\nID: ${SANDBOX_ID}\nPhase: Creating\n`,
            stderr: "",
          },
    );

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("OpenShell sandbox identity disagrees");
    expect(podman).not.toHaveBeenCalled();
  });

  it.each(["Ready", "Stopped"] as const)(
    "removes one exact %s sandbox and rejects a same-name replacement on retry (#9608)",
    (phase) => {
      const receipt = activeReceipt();
      const { deps, podman } = lifecycleDeps(receipt, phase === "Ready");
      const originalPodman = podman.getMockImplementation()!;
      let sandboxPresent = true;
      let containerPresent = true;
      let replacement = false;
      const live = `Name: ${SANDBOX}\nID: ${SANDBOX_ID}\nPhase: ${phase}\n`;
      podman.mockImplementation((args: readonly string[]) => {
        switch (args[0]) {
          case "container":
            return args[1] === "inspect" && !containerPresent
              ? { status: 125, stdout: "", stderr: "no such container" }
              : originalPodman(args);
          case "ps":
            return { status: 0, stdout: containerPresent ? `${CONTAINER_ID}\n` : "", stderr: "" };
          default:
            return originalPodman(args);
        }
      });
      deps.captureOpenShell = vi.fn((args: readonly string[]) => {
        const command = args.slice(0, 2).join(":");
        switch (command) {
          case "policy:get":
            return { status: 0, stdout: POLICY, stderr: "" };
          case "sandbox:list":
            return {
              status: 0,
              stdout: args.includes("json")
                ? sandboxPresent
                  ? sandboxListJson(SANDBOX_ID, phase)
                  : "[]"
                : live,
              stderr: "",
            };
          case "sandbox:delete":
            sandboxPresent = false;
            containerPresent = false;
            return { status: 0, stdout: "", stderr: "" };
          case "sandbox:get":
            return replacement
              ? {
                  status: 0,
                  stdout: `Name: ${SANDBOX}\nID: replacement\nPhase: Ready\n`,
                  stderr: "",
                }
              : sandboxPresent
                ? { status: 0, stdout: live, stderr: "" }
                : {
                    status: 1,
                    stdout: "",
                    stderr: `Error: sandbox '${SANDBOX}' not found`,
                  };
          default:
            return poisonUnexpectedCommand("OpenShell", args);
        }
      });

      withMcpLifecycleLockSync(
        SANDBOX,
        () => {
          const prepared = prepareHermesPortableSandboxRemoval(SANDBOX, lifecycleContext(), deps, {
            allowAbsent: true,
          });
          expect(prepared.present).toBe(true);
          prepared.removeAndVerify();
          prepared.verifyAbsent();
          expect(
            prepareHermesPortableSandboxRemoval(SANDBOX, lifecycleContext(), deps, {
              allowAbsent: true,
            }).present,
          ).toBe(false);

          replacement = true;
          expect(() =>
            prepareHermesPortableSandboxRemoval(SANDBOX, lifecycleContext(), deps, {
              allowAbsent: true,
            }),
          ).toThrow("OpenShell sandbox identity disagrees");
        },
        { stateDir: path.join(stateDir, "state") },
      );
      expect(
        deps.captureOpenShell.mock.calls.filter(([args]) => args[1] === "delete"),
      ).toHaveLength(1);
    },
  );

  it("rejects rendered absence text when the JSON sandbox list is malformed (#9608)", () => {
    const receipt = activeReceipt();
    const { deps, podman } = lifecycleDeps(receipt);
    deps.captureOpenShell = vi.fn((args: readonly string[]) => {
      const command = args.slice(0, 2).join(":");
      switch (command) {
        case "sandbox:get":
          return { status: 1, stdout: "", stderr: `sandbox ${SANDBOX} not found` };
        case "sandbox:list":
          return { status: 0, stdout: "warning: stale cache", stderr: "" };
        default:
          return poisonUnexpectedCommand("OpenShell", args);
      }
    });

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () =>
          prepareHermesPortableSandboxRemoval(SANDBOX, lifecycleContext(), deps, {
            allowAbsent: true,
          }),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("cannot prove the current OpenShell sandbox");
    expect(podman).not.toHaveBeenCalled();
  });
});

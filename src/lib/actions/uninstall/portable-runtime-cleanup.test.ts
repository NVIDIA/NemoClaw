// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import { portableDemoReceiptPath } from "../../onboard/experimental/portable-runtime-receipt-readiness";
import {
  hasPortableRuntimeCleanup,
  removePortableSandboxContainers,
  removePortableSharedResources,
  type PortableRuntimeCleanupDeps,
  type PortableRuntimeCleanupInput,
} from "./portable-runtime-cleanup";

const UID = process.getuid?.() ?? 1001;
const ALPHA_ID = "a".repeat(64);
const BETA_ID = "b".repeat(64);
const REGISTRY_ID = "c".repeat(64);

interface ContainerRecord {
  id: string;
  name: string;
  labels: Record<string, string>;
  running: boolean;
}

const temporaryDirectories: string[] = [];

function fixture() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-uninstall-"));
  temporaryDirectories.push(homeDir);
  const stateDir = path.join(homeDir, ".nemoclaw");
  const registryFile = path.join(stateDir, "sandboxes.json");
  const authority: CheckpointPortableRuntimeAuthority = {
    schemaVersion: 1,
    kind: "podman",
    ownership: "current-user",
    uid: UID,
    homeDir,
    configHome: path.join(homeDir, ".config"),
    runtimeDir: path.join("/run/user", String(UID)),
    socketPath: path.join("/run/user", String(UID), "podman", "podman.sock"),
  };
  fs.mkdirSync(path.dirname(portableDemoReceiptPath("alpha", stateDir)), { recursive: true });
  const writeReceipt = (sandboxName: string, containerId: string, sandboxId: string) => {
    fs.writeFileSync(
      portableDemoReceiptPath(sandboxName, stateDir),
      `${JSON.stringify(
        {
          schemaVersion: 4,
          sandboxName,
          sandboxId,
          containerId,
          dashboardPort: sandboxName === "alpha" ? 18789 : 18790,
          registryGeneration: containerId,
          runtimeAuthority: authority,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  };
  writeReceipt("alpha", ALPHA_ID, "sandbox-alpha");
  fs.writeFileSync(
    registryFile,
    `${JSON.stringify({
      defaultSandbox: "alpha",
      sandboxes: {
        alpha: {
          name: "alpha",
          agent: "openclaw",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          openshellDriver: "docker",
          lifecycleGeneration: ALPHA_ID,
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
  const containers = new Map<string, ContainerRecord>();
  const addSandbox = (
    sandboxName: string,
    sandboxId: string,
    containerId: string,
    labels: Record<string, string> = {},
  ) => {
    containers.set(containerId, {
      id: containerId,
      name: `openshell-default--${sandboxName}-${sandboxId}`,
      labels: {
        "openshell.managed": "true",
        "openshell.ai/sandbox-id": sandboxId,
        "openshell.ai/sandbox-name": sandboxName,
        "openshell.ai/sandbox-namespace": "",
        "openshell.ai/sandbox-workspace": "default",
        ...labels,
      },
      running: true,
    });
  };
  addSandbox("alpha", "sandbox-alpha", ALPHA_ID);
  containers.set(REGISTRY_ID, {
    id: REGISTRY_ID,
    name: "nemoclaw-portable-registry",
    labels: { "com.nvidia.nemoclaw.portable": "1" },
    running: true,
  });
  const podmanCalls: string[][] = [];
  const podmanEnvironments: NodeJS.ProcessEnv[] = [];
  const podmanHandlers = new Map<
    string,
    (args: readonly string[]) => { status: number; stdout?: string; stderr?: string }
  >([
    [
      "ps",
      (args) => {
        const joined = args.join(" ");
        const sandbox = /openshell\.ai\/sandbox-name=([^ ]+)/u.exec(joined)?.[1];
        const matchesPortableRegistry = joined.includes("com.nvidia.nemoclaw.portable=1");
        const matches = [...containers.values()].filter((container) =>
          matchesPortableRegistry
            ? container.labels["com.nvidia.nemoclaw.portable"] === "1"
            : sandbox !== undefined && container.labels["openshell.ai/sandbox-name"] === sandbox,
        );
        return { status: 0, stdout: matches.map(({ id }) => id).join("\n") };
      },
    ],
    [
      "inspect",
      (args) => {
        const target = String(args[1]);
        const record =
          containers.get(target) ?? [...containers.values()].find(({ name }) => name === target);
        return record === undefined
          ? { status: 1, stderr: `Error: no such container ${target}` }
          : {
              status: 0,
              stdout: JSON.stringify([
                {
                  Id: record.id,
                  Name: record.name,
                  Config: { Labels: record.labels },
                  State: { Running: record.running },
                },
              ]),
            };
      },
    ],
    [
      "rm",
      (args) => {
        containers.delete(String(args[2]));
        return { status: 0 };
      },
    ],
  ]);
  const unexpectedPodmanCommand = (args: readonly string[]) => {
    throw new Error(`Unexpected Podman command: ${args.join(" ")}`);
  };
  const podman = vi.fn((rawArgs: readonly string[], env?: NodeJS.ProcessEnv) => {
    podmanEnvironments.push({ ...(env ?? {}) });
    const args = rawArgs[0] === "--url" ? rawArgs.slice(2) : rawArgs;
    podmanCalls.push([...args]);
    return (podmanHandlers.get(String(args[0])) ?? unexpectedPodmanCommand)(args);
  });
  const selectors = new Map<string, string>([
    ["CONTAINERS_CONF", path.join(authority.configHome, "nemoclaw/portable/containers.conf")],
    ["NETAVARK_FW", "iptables"],
    ["CONTAINER_HOST", "ssh://user-managed.example"],
    ["CONTAINER_CONNECTION", "user-managed"],
    ["CONTAINER_SSHKEY", "/home/test/.ssh/user-managed"],
    ["UNRELATED", "keep"],
  ]);
  const systemctlCalls: string[][] = [];
  const systemctlHandlers = new Map<
    string,
    (args: readonly string[]) => { status: number; stdout?: string }
  >([
    [
      "show-environment",
      () => ({
        status: 0,
        stdout: [...selectors].map(([name, value]) => `${name}=${value}`).join("\n"),
      }),
    ],
    [
      "unset-environment",
      (args) => {
        for (const name of args.slice(2)) selectors.delete(name);
        return { status: 0 };
      },
    ],
  ]);
  const unexpectedSystemctlCommand = (args: readonly string[]) => {
    throw new Error(`Unexpected systemctl command: ${args.join(" ")}`);
  };
  const systemctl = vi.fn((args: readonly string[]) => {
    systemctlCalls.push([...args]);
    return (systemctlHandlers.get(String(args[1])) ?? unexpectedSystemctlCommand)(args);
  });
  const input: PortableRuntimeCleanupInput = {
    env: {
      HOME: homeDir,
      CONTAINER_HOST: "tcp://ambient-attacker.invalid",
      CONTAINER_CONNECTION: "ambient-attacker",
      CONTAINER_SSHKEY: "/tmp/ambient-attacker-key",
    },
    gatewayPort: 8080,
    homeDir,
    registryFile,
    stateDir,
  };
  const deps: PortableRuntimeCleanupDeps = {
    hardenSocketDirectory: vi.fn(),
    platform: "linux",
    podman,
    systemctl,
    runtimeReadiness: {
      uid: UID,
      home: homeDir,
      systemctl: () => ({ status: 0 }),
      captureSocketAuthority: () => ({
        socketPath: authority.socketPath,
        device: "1",
        inode: "2",
        mode: String(0o660),
        ownerUid: String(UID),
        directoryChain: [],
      }),
      assertSocketAuthority: vi.fn(),
      podmanCapture: () => ({
        status: 0,
        stdout: JSON.stringify({ Server: { Version: "5.6.1" } }),
        stderr: "",
      }),
    },
    log: vi.fn(),
  };
  return {
    addSandbox,
    authority,
    containers,
    deps,
    homeDir,
    input,
    podman,
    podmanCalls,
    podmanEnvironments,
    registryFile,
    selectors,
    stateDir,
    systemctl,
    systemctlCalls,
    writeReceipt,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("portable runtime uninstall cleanup", () => {
  it("removes only exact receipt-owned containers and exact current selector projections (#9189)", () => {
    const test = fixture();

    expect(hasPortableRuntimeCleanup(test.stateDir)).toBe(true);
    expect(removePortableSandboxContainers(test.input, test.deps)).toBe(1);
    expect(test.containers.has(ALPHA_ID)).toBe(false);
    expect(test.containers.has(REGISTRY_ID)).toBe(true);

    const shared = removePortableSharedResources(test.input, test.deps);

    expect(shared).toEqual({
      registryRemoved: true,
      selectorsRemoved: ["CONTAINERS_CONF", "NETAVARK_FW"],
    });
    expect(test.containers.size).toBe(0);
    expect(test.selectors).toEqual(
      new Map([
        ["CONTAINER_HOST", "ssh://user-managed.example"],
        ["CONTAINER_CONNECTION", "user-managed"],
        ["CONTAINER_SSHKEY", "/home/test/.ssh/user-managed"],
        ["UNRELATED", "keep"],
      ]),
    );
    expect(fs.existsSync(portableDemoReceiptPath("alpha", test.stateDir))).toBe(true);
    expect(test.podmanEnvironments).not.toEqual([]);
    for (const env of test.podmanEnvironments) {
      expect(env.CONTAINER_HOST).toBeUndefined();
      expect(env.CONTAINER_CONNECTION).toBeUndefined();
      expect(env.CONTAINER_SSHKEY).toBeUndefined();
    }
    expect(fs.existsSync(`${test.registryFile}.lock`)).toBe(false);
  });

  it("preserves changed current-user manager selector values (#9189)", () => {
    const test = fixture();
    test.selectors.set("CONTAINERS_CONF", "/home/test/user-containers.conf");
    test.selectors.set("NETAVARK_FW", "nftables");

    expect(removePortableSandboxContainers(test.input, test.deps)).toBe(1);
    expect(removePortableSharedResources(test.input, test.deps)).toEqual({
      registryRemoved: true,
      selectorsRemoved: [],
    });
    expect(test.selectors.get("CONTAINERS_CONF")).toBe("/home/test/user-containers.conf");
    expect(test.selectors.get("NETAVARK_FW")).toBe("nftables");
  });

  it("prevalidates every receipt before deleting the first container (#9189)", () => {
    const test = fixture();
    test.writeReceipt("beta", BETA_ID, "sandbox-beta");
    test.addSandbox("beta", "sandbox-beta", BETA_ID, { "openshell.managed": "false" });
    const registry = JSON.parse(fs.readFileSync(test.registryFile, "utf8")) as {
      sandboxes: Record<string, unknown>;
    };
    registry.sandboxes.beta = {
      name: "beta",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      openshellDriver: "docker",
      lifecycleGeneration: BETA_ID,
    };
    fs.writeFileSync(test.registryFile, `${JSON.stringify(registry)}\n`);

    expect(() => removePortableSandboxContainers(test.input, test.deps)).toThrow(
      /OpenShell identity does not match sandbox 'beta'/,
    );
    expect(test.containers.has(ALPHA_ID)).toBe(true);
    expect(test.podmanCalls.some((args) => args[0] === "rm")).toBe(false);
  });

  it("preserves receipts and selectors when exact container removal cannot be verified (#9189)", () => {
    const test = fixture();
    test.deps.podman = vi.fn((rawArgs: readonly string[], env?: NodeJS.ProcessEnv) => {
      const args = rawArgs[0] === "--url" ? rawArgs.slice(2) : rawArgs;
      return args[0] === "rm"
        ? { status: 1, stderr: "permission denied" }
        : test.podman(rawArgs, env);
    });

    expect(() => removePortableSandboxContainers(test.input, test.deps)).toThrow(/still has/);
    expect(test.systemctlCalls.some((args) => args[1] === "unset-environment")).toBe(false);
    expect(fs.existsSync(portableDemoReceiptPath("alpha", test.stateDir))).toBe(true);
  });

  it("preserves retry evidence when managed registry removal fails (#9189)", () => {
    const test = fixture();
    expect(removePortableSandboxContainers(test.input, test.deps)).toBe(1);
    const failingDeps: PortableRuntimeCleanupDeps = {
      ...test.deps,
      podman: vi.fn((rawArgs: readonly string[], env?: NodeJS.ProcessEnv) => {
        const args = rawArgs[0] === "--url" ? rawArgs.slice(2) : rawArgs;
        return args[0] === "rm" && args[2] === REGISTRY_ID
          ? { status: 1, stderr: "registry removal denied" }
          : test.podman(rawArgs, env);
      }),
    };

    expect(() => removePortableSharedResources(test.input, failingDeps)).toThrow(
      /managed portable registry container still exists/,
    );
    expect(test.containers.has(REGISTRY_ID)).toBe(true);
    expect(test.systemctlCalls.some((args) => args[1] === "unset-environment")).toBe(false);
    expect(fs.existsSync(portableDemoReceiptPath("alpha", test.stateDir))).toBe(true);

    expect(removePortableSharedResources(test.input, test.deps)).toEqual({
      registryRemoved: true,
      selectorsRemoved: ["CONTAINERS_CONF", "NETAVARK_FW"],
    });
  });

  it("retries selector cleanup after the managed registry was already removed (#9189)", () => {
    const test = fixture();
    const systemctl = test.deps.systemctl!;
    const failingDeps: PortableRuntimeCleanupDeps = {
      ...test.deps,
      systemctl: vi.fn((args, env) =>
        args[1] === "unset-environment"
          ? { status: 1, stderr: "permission denied" }
          : systemctl(args, env),
      ),
    };

    expect(removePortableSandboxContainers(test.input, failingDeps)).toBe(1);
    expect(() => removePortableSharedResources(test.input, failingDeps)).toThrow(
      /Clearing NemoClaw portable selectors.*permission denied/,
    );
    expect(test.containers.has(REGISTRY_ID)).toBe(false);
    expect(fs.existsSync(portableDemoReceiptPath("alpha", test.stateDir))).toBe(true);

    expect(removePortableSharedResources(test.input, test.deps)).toEqual({
      registryRemoved: false,
      selectorsRemoved: ["CONTAINERS_CONF", "NETAVARK_FW"],
    });
  });

  it("accepts an already-absent exact sandbox on retry but rejects a replaced identity (#9189)", () => {
    const retry = fixture();
    retry.containers.delete(ALPHA_ID);
    expect(removePortableSandboxContainers(retry.input, retry.deps)).toBe(0);

    const replaced = fixture();
    replaced.containers.delete(ALPHA_ID);
    replaced.addSandbox("alpha", "sandbox-replacement", BETA_ID);
    expect(() => removePortableSandboxContainers(replaced.input, replaced.deps)).toThrow(
      /replaced or ambiguous container/,
    );
  });

  it("rejects duplicate containers in the sandbox label index before removal (#9189)", () => {
    const test = fixture();
    test.addSandbox("alpha", "sandbox-duplicate", BETA_ID);

    expect(() => removePortableSandboxContainers(test.input, test.deps)).toThrow(
      /replaced or ambiguous container/,
    );
    expect(test.containers.has(ALPHA_ID)).toBe(true);
    expect(test.containers.has(BETA_ID)).toBe(true);
    expect(test.podmanCalls.some((args) => args[0] === "rm")).toBe(false);
  });

  it("fails closed on malformed receipts and mismatched lifecycle generations (#9189)", () => {
    const malformed = fixture();
    fs.writeFileSync(portableDemoReceiptPath("alpha", malformed.stateDir), "{not-json\n");
    expect(() => hasPortableRuntimeCleanup(malformed.stateDir)).toThrow(/malformed/);

    const mismatch = fixture();
    const registry = JSON.parse(fs.readFileSync(mismatch.registryFile, "utf8")) as {
      sandboxes: { alpha: { lifecycleGeneration: string } };
    };
    registry.sandboxes.alpha.lifecycleGeneration = "different-generation";
    fs.writeFileSync(mismatch.registryFile, `${JSON.stringify(registry)}\n`);
    expect(() => removePortableSandboxContainers(mismatch.input, mismatch.deps)).toThrow(
      /current registry ownership/,
    );
    expect(mismatch.containers.has(ALPHA_ID)).toBe(true);
  });
});

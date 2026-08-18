// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../agent/defs";
import { withMcpLifecycleLockSync } from "../../state/mcp-lifecycle-lock";
import type { SandboxEntry } from "../../state/registry";
import { fingerprintOpenShellSandboxLiveIdentity } from "../../adapters/openshell/sandbox-identity";
import { hermesPortableContainerInternals } from "./hermes-portable-container";
import { resolveHermesPortableStartupContract } from "./hermes-portable-contract";
import {
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

let stateDir: string;
let policyPath: string;

function startupArgv() {
  return [
    "env",
    `NEMOCLAW_SANDBOX_NAME=${SANDBOX}`,
    "NEMOCLAW_HERMES_API_PORT=8642",
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
      readRegistry: () =>
        ({
          name: SANDBOX,
          agent: "hermes",
          openshellDriver: "docker",
          gatewayName: GATEWAY,
          lifecycleGeneration: GENERATION,
          lifecycleLiveIdentityFingerprint: liveIdentityFingerprint,
        }) as SandboxEntry,
      captureOpenShell,
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
});

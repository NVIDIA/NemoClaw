// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PodmanSocketAuthority, PodmanSocketAuthorityDeps } from "../../adapters/podman";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import {
  installPortableDemoSandboxLifecycle,
  type PortableDemoLifecycleDeps,
  recoverPortableDemoSandboxLifecycle as recoverPortableDemoSandboxLifecycleUnchecked,
} from "./portable-demo-lifecycle";

const CONTAINER_ID = "a".repeat(64);
const SANDBOX_ID = "sandbox-id-alpha";
const SOCKET_PATH = "/run/user/1001/podman/podman.sock";
const RUNTIME_AUTHORITY: CheckpointPortableRuntimeAuthority = {
  schemaVersion: 1,
  kind: "podman",
  ownership: "current-user",
  uid: 1001,
  homeDir: "/home/tester",
  configHome: "/home/tester/.config",
  runtimeDir: "/run/user/1001",
  socketPath: SOCKET_PATH,
};
const SOCKET_AUTHORITY: PodmanSocketAuthority = {
  directoryChain: [],
  device: "1",
  inode: "2",
  mode: String(0o140600),
  ownerUid: "1001",
  socketPath: SOCKET_PATH,
};
const READINESS = {
  uid: 1001,
  home: RUNTIME_AUTHORITY.homeDir,
  systemctl: () => ({ status: 0 }),
  hardenSocketDirectory: vi.fn(),
  captureSocketAuthority: () => SOCKET_AUTHORITY,
  assertSocketAuthority: vi.fn(),
};
const STARTUP_ARGV = [
  "env",
  "CHAT_UI_URL=http://127.0.0.1:18789",
  "NEMOCLAW_DASHBOARD_PORT=18789",
  "OPENCLAW_HOME=/sandbox",
  "OPENCLAW_STATE_DIR=/sandbox/.openclaw",
  "OPENCLAW_WORKSPACE_DIR=/sandbox/.openclaw/workspace",
  "NEMOCLAW_SANDBOX_NAME=alpha",
  "/usr/local/bin/nemoclaw-start",
];
const temporaryDirectories: string[] = [];

function socketAuthorityDeps(): PodmanSocketAuthorityDeps {
  const directoryInodes = new Map<string, bigint>();
  return {
    uid: 1001,
    lstat: (filePath) => {
      const socket = filePath === SOCKET_PATH;
      const directoryInode = directoryInodes.get(filePath) ?? BigInt(7000 + directoryInodes.size);
      directoryInodes.set(filePath, directoryInode);
      return {
        dev: 8n,
        ino: socket ? 9001n : directoryInode,
        mode: socket ? 0o660n : filePath === path.dirname(SOCKET_PATH) ? 0o700n : 0o755n,
        uid: socket ? 1001n : filePath.startsWith("/run/user/1001") ? 1001n : 0n,
        isDirectory: () => !socket,
        isSocket: () => socket,
      };
    },
  };
}

function temporaryStateDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-identity-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createPodman() {
  let sandboxId = SANDBOX_ID;
  let managedLabel = "true";
  let sandboxNameLabel = "alpha";
  let sandboxNamespaceLabel = "";
  let sandboxWorkspaceLabel = "default";
  let containerName = `openshell-default--alpha-${sandboxId}`;
  const podman = vi.fn((args: readonly string[]) => {
    const command = args[0] === "--url" ? args.slice(2) : args;
    switch (command[0]) {
      case "info":
        return { status: 0, stdout: `${SOCKET_PATH}\n` };
      case "version":
        return { status: 0, stdout: JSON.stringify({ Server: { Version: "5.6.1" } }) };
      case "ps":
        return { status: 0, stdout: `${CONTAINER_ID}\n` };
      case "inspect":
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              Id: CONTAINER_ID,
              Name: containerName,
              Config: {
                Labels: {
                  "openshell.managed": managedLabel,
                  "openshell.ai/sandbox-id": sandboxId,
                  "openshell.ai/sandbox-name": sandboxNameLabel,
                  "openshell.ai/sandbox-namespace": sandboxNamespaceLabel,
                  "openshell.ai/sandbox-workspace": sandboxWorkspaceLabel,
                },
              },
              State: { Running: true },
            },
          ]),
        };
      case "update":
        return { status: 0 };
      default:
        throw new Error(`Unexpected Podman command: ${args.join(" ")}`);
    }
  });
  return {
    podman,
    setSandboxId(value: string) {
      sandboxId = value;
      containerName = `openshell-default--alpha-${value}`;
    },
    setManagedLabel(value: string) {
      managedLabel = value;
    },
    setSandboxNameLabel(value: string) {
      sandboxNameLabel = value;
    },
    setSandboxNamespaceLabel(value: string) {
      sandboxNamespaceLabel = value;
    },
    setSandboxWorkspaceLabel(value: string) {
      sandboxWorkspaceLabel = value;
    },
    setContainerName(value: string) {
      containerName = value;
    },
  };
}

function installReceipt(stateDir: string, podman: ReturnType<typeof createPodman>["podman"]): void {
  installPortableDemoSandboxLifecycle(
    "alpha",
    STARTUP_ARGV,
    { HOME: stateDir, NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
    {
      platform: "linux",
      podman,
      stateDir,
      podmanSocketAuthorityDeps: socketAuthorityDeps(),
      runtimeAuthority: RUNTIME_AUTHORITY,
      runtimeReadiness: READINESS,
      log: vi.fn(),
    },
  );
}

function recoverPortableDemoSandboxLifecycle(
  stateDir: string,
  runtime: ReturnType<typeof createPodman>,
  launchOpenshell: (args: readonly string[]) => void,
) {
  return recoverPortableDemoSandboxLifecycleUnchecked(
    "alpha",
    {
      agent: "openclaw",
      gatewayName: "nemoclaw",
      lifecycleGeneration: CONTAINER_ID,
      openshellDriver: "docker",
    },
    {
      platform: "linux",
      stateDir,
      podman: runtime.podman,
      podmanSocketAuthorityDeps: socketAuthorityDeps(),
      hardenSocketDirectory: vi.fn(),
      launchOpenshell,
      runtimeReadiness: READINESS,
      log: vi.fn(),
    } satisfies PortableDemoLifecycleDeps,
  );
}

function expectRecoveryIdentityRefusal(
  stateDir: string,
  runtime: ReturnType<typeof createPodman>,
): void {
  const launchOpenshell = vi.fn();

  expect(() => recoverPortableDemoSandboxLifecycle(stateDir, runtime, launchOpenshell)).toThrow(
    "OpenShell identity does not match",
  );
  expect(runtime.podman).not.toHaveBeenCalledWith(["start", CONTAINER_ID]);
  expect(launchOpenshell).not.toHaveBeenCalled();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("portable demo OpenShell container identity", () => {
  it("refuses a container whose OpenShell sandbox ID changed (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    runtime.setSandboxId("different-sandbox-id");
    const launchOpenshell = vi.fn();

    expect(() => recoverPortableDemoSandboxLifecycle(stateDir, runtime, launchOpenshell)).toThrow(
      "OpenShell sandbox ID changed",
    );
    expect(launchOpenshell).not.toHaveBeenCalled();
  });

  it("refuses a container whose OpenShell managed label is not true (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    runtime.setManagedLabel("false");

    expectRecoveryIdentityRefusal(stateDir, runtime);
  });

  it("refuses a container whose OpenShell sandbox name changed (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    runtime.setSandboxNameLabel("different-name");

    expectRecoveryIdentityRefusal(stateDir, runtime);
  });

  it("refuses a container whose OpenShell sandbox namespace is not empty (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    runtime.setSandboxNamespaceLabel("default");

    expectRecoveryIdentityRefusal(stateDir, runtime);
  });

  it("refuses a container outside the default OpenShell workspace (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    runtime.setSandboxWorkspaceLabel("another-workspace");

    expectRecoveryIdentityRefusal(stateDir, runtime);
  });

  it("refuses a container whose engine name does not match its OpenShell identity (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    runtime.setContainerName(`openshell-default--alpha-${SANDBOX_ID}-other`);

    expectRecoveryIdentityRefusal(stateDir, runtime);
  });
});

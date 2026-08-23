// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PodmanSocketAuthorityDeps } from "../../adapters/podman";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import {
  installPortableDemoSandboxLifecycle,
  type PortableDemoDestroyContext,
  type PortableDemoLifecycleDeps,
  portableDemoLifecycleInternals,
  preparePortableDemoSandboxDestroyAuthority,
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
const invalidDestroyContexts: Array<
  readonly [string, PortableDemoDestroyContext | null]
> = [
  ["a missing registry record", null],
  [
    "a non-OpenClaw registry record",
    {
      agent: "hermes",
      lifecycleGeneration: CONTAINER_ID,
      openshellDriver: "docker",
    },
  ],
  [
    "a registry record with an omitted agent",
    {
      lifecycleGeneration: CONTAINER_ID,
      openshellDriver: "docker",
    },
  ],
];

function temporaryStateDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-authority-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createPodman() {
  let containerId = CONTAINER_ID;
  let managedLabel = "true";
  let present = true;
  const podman = vi.fn((args: readonly string[], _env?: NodeJS.ProcessEnv) => {
    const command = args[0] === "--url" ? args.slice(2) : args;
    switch (command[0]) {
      case "version":
        return { status: 0, stdout: JSON.stringify({ Server: { Version: "5.6.1" } }) };
      case "ps":
        return { status: 0, stdout: present ? `${CONTAINER_ID}\n` : "" };
      case "inspect":
        return present
          ? {
              status: 0,
              stdout: JSON.stringify([
                {
                  Id: containerId,
                  Name: `openshell-default--alpha-${SANDBOX_ID}`,
                  Config: {
                    Labels: {
                      "openshell.managed": managedLabel,
                      "openshell.ai/sandbox-id": SANDBOX_ID,
                      "openshell.ai/sandbox-name": "alpha",
                      "openshell.ai/sandbox-namespace": "",
                      "openshell.ai/sandbox-workspace": "default",
                    },
                  },
                  State: { Running: true },
                },
              ]),
            }
          : { status: 125, stderr: `Error: no such container ${CONTAINER_ID}` };
      case "update":
        return { status: 0 };
      default:
        throw new Error(`Unexpected Podman command: ${args.join(" ")}`);
    }
  });
  return {
    podman,
    setContainerId(value: string) {
      containerId = value;
    },
    setManagedLabel(value: string) {
      managedLabel = value;
    },
    setPresent(value: boolean) {
      present = value;
    },
  };
}

function socketAuthorityDeps(socketInode: () => bigint = () => 9001n): PodmanSocketAuthorityDeps {
  const directoryInodes = new Map<string, bigint>();
  return {
    uid: 1001,
    lstat: (filePath) => {
      const socket = filePath === SOCKET_PATH;
      const directoryInode = directoryInodes.get(filePath) ?? BigInt(7000 + directoryInodes.size);
      directoryInodes.set(filePath, directoryInode);
      return {
        dev: 8n,
        ino: socket ? socketInode() : directoryInode,
        mode: socket ? 0o660n : filePath === path.dirname(SOCKET_PATH) ? 0o700n : 0o755n,
        uid: socket ? 1001n : filePath.startsWith("/run/user/1001") ? 1001n : 0n,
        isDirectory: () => !socket,
        isSocket: () => socket,
      };
    },
  };
}

function lifecycleDeps(authorityDeps: PodmanSocketAuthorityDeps) {
  return {
    platform: "linux" as const,
    runtimeAuthority: RUNTIME_AUTHORITY,
    podmanSocketAuthorityDeps: authorityDeps,
    hardenSocketDirectory: vi.fn(),
    runtimeReadiness: {
      uid: RUNTIME_AUTHORITY.uid,
      home: RUNTIME_AUTHORITY.homeDir,
      systemctl: () => ({ status: 0 }),
    },
    log: vi.fn(),
  };
}

function installReceipt(stateDir: string, runtime: ReturnType<typeof createPodman>): void {
  installPortableDemoSandboxLifecycle(
    "alpha",
    STARTUP_ARGV,
    { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
    {
      podman: runtime.podman,
      stateDir,
      ...lifecycleDeps(socketAuthorityDeps()),
    },
  );
  runtime.podman.mockClear();
}

function prepareDestroyAuthority(
  stateDir: string,
  runtime: ReturnType<typeof createPodman>,
  readContext: () => PortableDemoDestroyContext | null = () => ({
    agent: "openclaw",
    lifecycleGeneration: CONTAINER_ID,
    openshellDriver: "docker",
  }),
  overrides: Partial<PortableDemoLifecycleDeps> = {},
) {
  return preparePortableDemoSandboxDestroyAuthority("alpha", readContext, {
    podman: runtime.podman,
    stateDir,
    ...lifecycleDeps(socketAuthorityDeps()),
    ...overrides,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("portable demo lifecycle authority", () => {
  it("accepts a legacy null OpenClaw registry identity for Portable destroy", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime);
    const authority = prepareDestroyAuthority(stateDir, runtime, () => ({
      agent: null,
      lifecycleGeneration: CONTAINER_ID,
      openshellDriver: "docker",
    }));

    expect(authority).not.toBeNull();
    expect(() => authority?.revalidate()).not.toThrow();
  });

  it.each(invalidDestroyContexts)(
    "refuses %s during Portable destroy",
    (_description, context) => {
      const stateDir = temporaryStateDir();
      const runtime = createPodman();
      installReceipt(stateDir, runtime);

      expect(() => prepareDestroyAuthority(stateDir, runtime, () => context)).toThrow(
        "does not match the OpenClaw sandbox registry",
      );
    },
  );

  it("revalidates schema-4 Portable destroy authority without removing its Podman container (#9189)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime);
    const authority = prepareDestroyAuthority(stateDir, runtime);

    expect(authority).not.toBeNull();
    expect(() => authority?.revalidate()).not.toThrow();
    runtime.setPresent(false);
    expect(() => authority?.verifyAbsent()).not.toThrow();
    expect(
      runtime.podman.mock.calls.some(([args]) => {
        const command = args[0] === "--url" ? args.slice(2) : args;
        return command[0] === "rm";
      }),
    ).toBe(false);
  });

  it("refuses a changed Portable receipt during destroy revalidation", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime);
    const authority = prepareDestroyAuthority(stateDir, runtime);
    const filePath = portableDemoLifecycleInternals.receiptPath("alpha", stateDir);
    const receipt = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    receipt.dashboardPort = 18790;
    fs.writeFileSync(filePath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });

    expect(() => authority?.revalidate()).toThrow("receipt changed");
    expect(
      runtime.podman.mock.calls.some(([args]) => {
        const command = args[0] === "--url" ? args.slice(2) : args;
        return command[0] === "rm";
      }),
    ).toBe(false);
  });

  it("refuses a changed Portable container presence during destroy revalidation", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime);
    const authority = prepareDestroyAuthority(stateDir, runtime);
    runtime.setPresent(false);

    expect(() => authority?.revalidate()).toThrow("container presence changed");
    expect(
      runtime.podman.mock.calls.some(([args]) => {
        const command = args[0] === "--url" ? args.slice(2) : args;
        return command[0] === "rm";
      }),
    ).toBe(false);
  });

  it("refuses a changed registry lifecycle generation during Portable destroy (#9189)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime);
    let lifecycleGeneration = CONTAINER_ID;
    const authority = prepareDestroyAuthority(stateDir, runtime, () => ({
      agent: "openclaw",
      lifecycleGeneration,
      openshellDriver: "docker",
    }));
    lifecycleGeneration = "replacement-generation";

    expect(() => authority?.revalidate()).toThrow("does not match the OpenClaw sandbox registry");
  });

  it("refuses a changed Podman container ID or required label during Portable destroy (#9189)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime);
    const authority = prepareDestroyAuthority(stateDir, runtime);

    runtime.setContainerId("b".repeat(64));
    expect(() => authority?.revalidate()).toThrow("OpenShell identity does not match");
    runtime.setContainerId(CONTAINER_ID);
    runtime.setManagedLabel("false");
    expect(() => authority?.revalidate()).toThrow("OpenShell identity does not match");
    expect(
      runtime.podman.mock.calls.some(([args]) => {
        const command = args[0] === "--url" ? args.slice(2) : args;
        return command[0] === "rm";
      }),
    ).toBe(false);
  });

  it("refuses a changed current-user Podman socket inode during Portable destroy (#9189)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime);
    let inode = 9001n;
    const authority = prepareDestroyAuthority(stateDir, runtime, undefined, {
      podmanSocketAuthorityDeps: socketAuthorityDeps(() => inode),
    });
    inode = 9002n;

    expect(() => authority?.revalidate()).toThrow("changed after it was qualified");
  });

  it("records the exact OpenShell container and applies the unless-stopped restart policy (#8441)", () => {
    const stateDir = temporaryStateDir();
    const { podman } = createPodman();

    installPortableDemoSandboxLifecycle(
      "alpha",
      STARTUP_ARGV,
      { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
      {
        podman,
        stateDir,
        ...lifecycleDeps(socketAuthorityDeps()),
      },
    );

    expect(podman.mock.calls.map(([args]) => args)).toEqual([
      ["--url", `unix://${SOCKET_PATH}`, "version", "--format", "json"],
      [
        "--url",
        `unix://${SOCKET_PATH}`,
        "ps",
        "-a",
        "--no-trunc",
        "--filter",
        "label=openshell.managed=true",
        "--filter",
        "label=openshell.ai/sandbox-name=alpha",
        "--filter",
        "label=openshell.ai/sandbox-workspace=default",
        "--format",
        "{{.ID}}",
      ],
      ["--url", `unix://${SOCKET_PATH}`, "inspect", CONTAINER_ID],
      ["--url", `unix://${SOCKET_PATH}`, "update", "--restart=unless-stopped", CONTAINER_ID],
    ]);
    const filePath = portableDemoLifecycleInternals.receiptPath("alpha", stateDir);
    const receipt = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(receipt).toEqual({
      schemaVersion: 4,
      sandboxName: "alpha",
      sandboxId: SANDBOX_ID,
      containerId: CONTAINER_ID,
      dashboardPort: 18789,
      registryGeneration: CONTAINER_ID,
      runtimeAuthority: RUNTIME_AUTHORITY,
    });
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("ignores ambient Podman remote selection while installing lifecycle ownership (#9068)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();

    installPortableDemoSandboxLifecycle(
      "alpha",
      STARTUP_ARGV,
      {
        NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
        CONTAINER_CONNECTION: "attacker",
        CONTAINER_HOST: "tcp://example.test:1234",
        CONTAINER_SSHKEY: "/tmp/attacker-key",
      },
      {
        podman: runtime.podman,
        stateDir,
        ...lifecycleDeps(socketAuthorityDeps()),
      },
    );

    runtime.podman.mock.calls.forEach(([, env]) => {
      expect(env).toMatchObject({
        HOME: RUNTIME_AUTHORITY.homeDir,
        XDG_CONFIG_HOME: RUNTIME_AUTHORITY.configHome,
        XDG_RUNTIME_DIR: RUNTIME_AUTHORITY.runtimeDir,
      });
      expect(env).not.toHaveProperty("CONTAINER_CONNECTION");
      expect(env).not.toHaveProperty("CONTAINER_HOST");
      expect(env).not.toHaveProperty("CONTAINER_SSHKEY");
    });
  });

  it("refuses socket replacement before mutating the portable restart policy (#9068)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    let inode = 9001n;
    const podman = vi.fn((args: readonly string[], env?: NodeJS.ProcessEnv) => {
      const result = runtime.podman(args, env);
      const command = args[0] === "--url" ? args.slice(2) : args;
      inode = command[0] === "inspect" ? 9002n : inode;
      return result;
    });

    expect(() =>
      installPortableDemoSandboxLifecycle(
        "alpha",
        STARTUP_ARGV,
        { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
        {
          podman,
          stateDir,
          ...lifecycleDeps(socketAuthorityDeps(() => inode)),
        },
      ),
    ).toThrow("changed after it was qualified");
    expect(
      runtime.podman.mock.calls.some(([args]) => {
        const command = args[0] === "--url" ? args.slice(2) : args;
        return command[0] === "update";
      }),
    ).toBe(false);
    expect(fs.existsSync(portableDemoLifecycleInternals.receiptPath("alpha", stateDir))).toBe(
      false,
    );
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PodmanSocketAuthorityDeps } from "../../adapters/podman";
import {
  installPortableDemoSandboxLifecycle,
  portableDemoLifecycleInternals,
} from "./portable-demo-lifecycle";

const CONTAINER_ID = "a".repeat(64);
const SANDBOX_ID = "sandbox-id-alpha";
const SOCKET_PATH = "/run/user/1001/podman/podman.sock";
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

function temporaryStateDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-authority-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createPodman() {
  const podman = vi.fn((args: readonly string[], _env?: NodeJS.ProcessEnv) => {
    const command = args[0] === "--url" ? args.slice(2) : args;
    switch (command[0]) {
      case "info":
        return { status: 0, stdout: `${SOCKET_PATH}\n` };
      case "ps":
        return { status: 0, stdout: `${CONTAINER_ID}\n` };
      case "inspect":
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              Id: CONTAINER_ID,
              Name: `openshell-default--alpha-${SANDBOX_ID}`,
              Config: {
                Labels: {
                  "openshell.managed": "true",
                  "openshell.ai/sandbox-id": SANDBOX_ID,
                  "openshell.ai/sandbox-name": "alpha",
                  "openshell.ai/sandbox-namespace": "",
                  "openshell.ai/sandbox-workspace": "default",
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
  return { podman };
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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("portable demo lifecycle authority", () => {
  it("records the exact OpenShell container and applies the unless-stopped restart policy (#8441)", () => {
    const stateDir = temporaryStateDir();
    const { podman } = createPodman();

    installPortableDemoSandboxLifecycle(
      "alpha",
      STARTUP_ARGV,
      { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
      {
        platform: "linux",
        podman,
        stateDir,
        podmanSocketAuthorityDeps: socketAuthorityDeps(),
        hardenSocketDirectory: vi.fn(),
      },
    );

    expect(podman.mock.calls.map(([args]) => args)).toEqual([
      ["info", "--format", "{{.Host.RemoteSocket.Path}}"],
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
      schemaVersion: 3,
      sandboxName: "alpha",
      sandboxId: SANDBOX_ID,
      containerId: CONTAINER_ID,
      dashboardPort: 18789,
      registryGeneration: CONTAINER_ID,
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
        platform: "linux",
        podman: runtime.podman,
        stateDir,
        podmanSocketAuthorityDeps: socketAuthorityDeps(),
        hardenSocketDirectory: vi.fn(),
      },
    );

    for (const [, env] of runtime.podman.mock.calls) {
      expect(env).toEqual({ NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" });
    }
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
          platform: "linux",
          podman,
          stateDir,
          podmanSocketAuthorityDeps: socketAuthorityDeps(() => inode),
          hardenSocketDirectory: vi.fn(),
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

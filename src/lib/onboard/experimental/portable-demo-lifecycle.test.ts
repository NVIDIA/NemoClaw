// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PodmanSocketAuthorityDeps } from "../../adapters/podman";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import type { SandboxEntry } from "../../state/registry";
import { gatewayWaitResult } from "./__test-helpers__/portable-demo-gateway-wait";
import { recordUserLocalOllamaOwnership } from "./ollama-user-local-runtime";
import {
  installPortableDemoSandboxLifecycle,
  type PortableDemoLifecycleDeps,
  portableDemoLifecycleInternals,
  recoverPortableDemoSandboxLifecycle as recoverPortableDemoSandboxLifecycleUnchecked,
  removePortableDemoSandboxLifecycleReceipt,
  resolvePortableDemoPrivilegedExecTarget,
  stopPortableDemoSandboxLifecycle,
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
const RECOVERY_STARTUP_ARGV = [
  "env",
  "NEMOCLAW_MANAGED_STARTUP_APPLIED=1",
  "_NEMOCLAW_CORPORATE_CA_MERGED=0",
  "NODE_EXTRA_CA_CERTS=/etc/openshell-tls/openshell-ca.pem",
  "DENO_CERT=/etc/openshell-tls/openshell-ca.pem",
  "SSL_CERT_FILE=/etc/openshell-tls/ca-bundle.pem",
  "REQUESTS_CA_BUNDLE=/etc/openshell-tls/ca-bundle.pem",
  "CURL_CA_BUNDLE=/etc/openshell-tls/ca-bundle.pem",
  "GIT_SSL_CAINFO=/etc/openshell-tls/ca-bundle.pem",
  ...STARTUP_ARGV.slice(1),
];

const temporaryDirectories: string[] = [];

function temporaryStateDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-lifecycle-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sandboxEntry(): SandboxEntry {
  return {
    name: "alpha",
    agent: "openclaw",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
  };
}

function createPodman(
  options: {
    running?: boolean;
    sandboxId?: string;
    updateStatus?: number;
    discoveredContainerIds?: readonly string[];
  } = {},
) {
  let running = options.running ?? true;
  let sandboxId = options.sandboxId ?? SANDBOX_ID;
  let managedLabel = "true";
  let sandboxNameLabel = "alpha";
  let sandboxNamespaceLabel = "";
  let sandboxWorkspaceLabel = "default";
  let containerId = CONTAINER_ID;
  let containerName = `openshell-default--alpha-${sandboxId}`;
  let matches = [...(options.discoveredContainerIds ?? [CONTAINER_ID])];
  const podman = vi.fn((args: readonly string[], _env?: NodeJS.ProcessEnv) => {
    const command = args[0] === "--url" ? args.slice(2) : args;
    switch (command[0]) {
      case "version":
        return { status: 0, stdout: JSON.stringify({ Server: { Version: "5.6.1" } }) };
      case "ps":
        return { status: 0, stdout: matches.length > 0 ? `${matches.join("\n")}\n` : "" };
      case "inspect":
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              Id: containerId,
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
              State: { Running: running, Status: running ? "running" : "exited" },
            },
          ]),
        };
      case "start":
        running = true;
        return { status: 0 };
      case "stop":
        running = false;
        return { status: 0 };
      case "update":
        return { status: options.updateStatus ?? 0 };
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
    setContainerId(value: string) {
      containerId = value;
    },
    setContainerName(value: string) {
      containerName = value;
    },
    setMatches(value: string[]) {
      matches = value;
    },
    setRunning(value: boolean) {
      running = value;
    },
  };
}

function socketAuthorityDeps(
  options: {
    directory?: boolean;
    directoryMode?: bigint;
    onLstat?: () => void;
    socketInode?: () => bigint;
    socketMode?: bigint;
    socketUid?: bigint;
  } = {},
): PodmanSocketAuthorityDeps {
  const directoryInodes = new Map<string, bigint>();
  return {
    uid: 1001,
    lstat: (filePath) => {
      options.onLstat?.();
      const socket = filePath === SOCKET_PATH;
      const directoryInode = directoryInodes.get(filePath) ?? BigInt(7000 + directoryInodes.size);
      directoryInodes.set(filePath, directoryInode);
      return {
        dev: 8n,
        ino: socket ? (options.socketInode?.() ?? 9001n) : directoryInode,
        mode: socket
          ? (options.socketMode ?? 0o660n)
          : filePath === path.dirname(SOCKET_PATH)
            ? (options.directoryMode ?? 0o700n)
            : 0o755n,
        uid: socket
          ? (options.socketUid ?? 1001n)
          : filePath.startsWith("/run/user/1001")
            ? 1001n
            : 0n,
        isDirectory: () => !socket && (options.directory ?? true),
        isSocket: () => socket,
      };
    },
  };
}

function resolveTarget(
  stateDir: string,
  runtime: ReturnType<typeof createPodman>,
  overrides: Partial<PortableDemoLifecycleDeps> = {},
) {
  return resolvePortableDemoPrivilegedExecTarget("alpha", {
    platform: "linux",
    registryGeneration: CONTAINER_ID,
    stateDir,
    podman: runtime.podman,
    podmanSocketAuthorityDeps: socketAuthorityDeps(),
    hardenSocketDirectory: vi.fn(),
    runtimeReadiness: {
      uid: 1001,
      home: RUNTIME_AUTHORITY.homeDir,
      systemctl: () => ({ status: 0 }),
      podmanCapture: () => ({
        status: 0,
        stdout: JSON.stringify({ Server: { Version: "5.6.1" } }),
        stderr: "",
      }),
    },
    log: vi.fn(),
    ...overrides,
  });
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
      runtimeAuthority: RUNTIME_AUTHORITY,
      podmanSocketAuthorityDeps: socketAuthorityDeps(),
      hardenSocketDirectory: vi.fn(),
      runtimeReadiness: {
        uid: 1001,
        home: RUNTIME_AUTHORITY.homeDir,
        systemctl: () => ({ status: 0 }),
        podmanCapture: () => ({
          status: 0,
          stdout: JSON.stringify({ Server: { Version: "5.6.1" } }),
          stderr: "",
        }),
      },
      log: vi.fn(),
    },
  );
}

function recoverPortableDemoSandboxLifecycle(
  sandboxName: string,
  context: Parameters<typeof recoverPortableDemoSandboxLifecycleUnchecked>[1],
  deps: PortableDemoLifecycleDeps = {},
) {
  return recoverPortableDemoSandboxLifecycleUnchecked(
    sandboxName,
    {
      lifecycleGeneration: CONTAINER_ID,
      openshellDriver: "docker",
      ...context,
    },
    {
      platform: "linux",
      podmanSocketAuthorityDeps: socketAuthorityDeps(),
      hardenSocketDirectory: vi.fn(),
      runtimeReadiness: {
        uid: 1001,
        home: RUNTIME_AUTHORITY.homeDir,
        systemctl: () => ({ status: 0 }),
        podmanCapture: () => ({
          status: 0,
          stdout: JSON.stringify({ Server: { Version: "5.6.1" } }),
          stderr: "",
        }),
      },
      log: vi.fn(),
      ...deps,
    },
  );
}

function createManagedOllamaBinary(homeDir: string): string {
  const binPath = path.join(homeDir, ".local", "bin", "ollama");
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(binPath, "#!/bin/sh\n", { mode: 0o755 });
  return binPath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("portable demo sandbox lifecycle", () => {
  it("removes a stale receipt without inspecting Podman for a non-portable replacement (#8584)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    runtime.podman.mockClear();
    const filePath = portableDemoLifecycleInternals.receiptPath("alpha", stateDir);

    installPortableDemoSandboxLifecycle(
      "alpha",
      STARTUP_ARGV,
      {},
      {
        podman: runtime.podman,
        stateDir,
      },
    );

    expect(fs.existsSync(filePath)).toBe(false);
    expect(runtime.podman).not.toHaveBeenCalled();
  });

  it("stops the receipt-owned container through qualified Podman authority (#9070)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    runtime.podman.mockClear();
    const beforeStop = vi.fn();

    expect(
      stopPortableDemoSandboxLifecycle(
        "alpha",
        {
          agent: "openclaw",
          gatewayName: "nemoclaw",
          lifecycleGeneration: CONTAINER_ID,
          openshellDriver: "docker",
        },
        beforeStop,
        {
          platform: "linux",
          podman: runtime.podman,
          podmanSocketAuthorityDeps: socketAuthorityDeps(),
          stateDir,
          hardenSocketDirectory: vi.fn(),
          runtimeReadiness: {
            uid: 1001,
            home: RUNTIME_AUTHORITY.homeDir,
            systemctl: () => ({ status: 0 }),
            podmanCapture: () => ({
              status: 0,
              stdout: JSON.stringify({ Server: { Version: "5.6.1" } }),
              stderr: "",
            }),
          },
          log: vi.fn(),
        },
      ),
    ).toEqual({ kind: "stopped" });
    expect(beforeStop).toHaveBeenCalledExactlyOnceWith();
    expect(runtime.podman).toHaveBeenCalledWith(
      expect.arrayContaining(["stop", CONTAINER_ID]),
      expect.any(Object),
    );
  });

  it("removes a stale receipt for another startup contract (#8584)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    runtime.podman.mockClear();
    const filePath = portableDemoLifecycleInternals.receiptPath("alpha", stateDir);

    installPortableDemoSandboxLifecycle(
      "alpha",
      ["env", "NEMOCLAW_OBSERVABILITY=0", "/usr/local/bin/nemoclaw-start"],
      { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
      { platform: "linux", podman: runtime.podman, stateDir },
    );

    expect(fs.existsSync(filePath)).toBe(false);
    expect(runtime.podman).not.toHaveBeenCalled();
  });

  it("ignores an installed receipt for another agent (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    runtime.podman.mockClear();

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "hermes", gatewayName: "nemoclaw" },
        { platform: "linux", stateDir, podman: runtime.podman },
      ),
    ).toEqual({ kind: "not-installed" });
    expect(runtime.podman).not.toHaveBeenCalled();
  });

  it("ignores an installed receipt for a non-Docker registry driver (#8584)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    runtime.podman.mockClear();

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        {
          agent: "openclaw",
          gatewayName: "nemoclaw",
          openshellDriver: "kubernetes",
        },
        { platform: "linux", stateDir, podman: runtime.podman },
      ),
    ).toEqual({ kind: "not-installed" });
    expect(runtime.podman).not.toHaveBeenCalled();
  });

  it("rejects an installed receipt outside Linux (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw" },
        { platform: "darwin", stateDir, podman: runtime.podman },
      ),
    ).toThrow("receipt is only valid on Linux");
  });

  it("rejects a receipt with an out-of-range dashboard port (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const filePath = portableDemoLifecycleInternals.receiptPath("alpha", stateDir);
    const receipt = JSON.parse(fs.readFileSync(filePath, "utf8"));
    fs.writeFileSync(filePath, `${JSON.stringify({ ...receipt, dashboardPort: 65_536 })}\n`, {
      mode: 0o600,
    });
    runtime.podman.mockClear();

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw" },
        { platform: "linux", stateDir, podman: runtime.podman },
      ),
    ).toThrow("receipt values are invalid");
    expect(runtime.podman).not.toHaveBeenCalled();
  });

  it("resolves the receipt-owned container through the rootless Podman socket (#8584)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    runtime.podman.mockClear();
    const socketEvents: string[] = [];
    const hardenSocketDirectory = vi.fn(() => socketEvents.push("harden"));
    const podmanSocketAuthorityDeps = socketAuthorityDeps({
      onLstat: () => socketEvents.push("capture"),
    });

    expect(
      resolveTarget(stateDir, runtime, { hardenSocketDirectory, podmanSocketAuthorityDeps }),
    ).toMatchObject({
      containerId: CONTAINER_ID,
      dockerHost: "unix:///run/user/1001/podman/podman.sock",
    });
    expect(hardenSocketDirectory).toHaveBeenCalledWith(SOCKET_PATH, 1001);
    expect(socketEvents.slice(0, 2)).toEqual(["harden", "capture"]);
    expect(runtime.podman.mock.calls.map(([args]) => args)).toEqual([
      [
        "--url",
        "unix:///run/user/1001/podman/podman.sock",
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
      ["--url", "unix:///run/user/1001/podman/podman.sock", "inspect", CONTAINER_ID],
    ]);
    expect(runtime.podman.mock.calls.map(([, env]) => env)).toEqual([
      expect.not.objectContaining({ CONTAINER_HOST: expect.anything() }),
      expect.not.objectContaining({ CONTAINER_HOST: expect.anything() }),
    ]);
  });

  it("rejects a receipt outside the current registry generation before Podman access (#8584)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    runtime.podman.mockClear();

    expect(() =>
      resolveTarget(stateDir, runtime, { registryGeneration: "replacement-generation" }),
    ).toThrow("does not belong to the current registry generation");
    expect(runtime.podman).not.toHaveBeenCalled();
  });

  it("rejects recovery outside the current registry generation before Podman access (#8584)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    runtime.podman.mockClear();

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        {
          agent: "openclaw",
          gatewayName: "nemoclaw",
          lifecycleGeneration: "replacement-generation",
          openshellDriver: "docker",
        },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
        },
      ),
    ).toThrow("does not belong to the current registry generation");
    expect(runtime.podman).not.toHaveBeenCalled();
  });

  it("rejects a legacy receipt after same-name registry replacement (#8584)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const receiptPath = portableDemoLifecycleInternals.receiptPath("alpha", stateDir);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    delete receipt.registryGeneration;
    delete receipt.runtimeAuthority;
    fs.writeFileSync(receiptPath, `${JSON.stringify({ ...receipt, schemaVersion: 2 })}\n`, {
      mode: 0o600,
    });
    runtime.podman.mockClear();

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        {
          agent: "openclaw",
          gatewayName: "nemoclaw",
          lifecycleGeneration: "replacement-generation",
          openshellDriver: "docker",
        },
        { platform: "linux", stateDir, podman: runtime.podman },
      ),
    ).toThrow("does not belong to the current registry generation");
    expect(runtime.podman).not.toHaveBeenCalled();
  });

  it("retires portable lifecycle authority after its sandbox registry entry is removed (#8584)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const receiptPath = portableDemoLifecycleInternals.receiptPath("alpha", stateDir);

    removePortableDemoSandboxLifecycleReceipt("alpha", stateDir);

    expect(fs.existsSync(receiptPath)).toBe(false);
  });

  it.each([[], [CONTAINER_ID, "b".repeat(64)]].map((matches) => [matches] as const))(
    "refuses missing or duplicate portable containers before privileged exec [case %#] (#8584)",
    (matches) => {
      const stateDir = temporaryStateDir();
      const runtime = createPodman();
      installReceipt(stateDir, runtime.podman);
      runtime.setMatches(matches);

      expect(() => resolveTarget(stateDir, runtime)).toThrow(`found ${matches.length}`);
    },
  );

  it("refuses renamed or relabeled portable containers before privileged exec (#8584)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);

    runtime.setContainerName("renamed-alpha");
    expect(() => resolveTarget(stateDir, runtime)).toThrow("OpenShell identity does not match");

    runtime.setContainerName(`openshell-default--alpha-${SANDBOX_ID}`);
    runtime.setSandboxNameLabel("beta");
    expect(() => resolveTarget(stateDir, runtime)).toThrow("OpenShell identity does not match");
  });

  it("refuses a replacement or stopped portable container before privileged exec (#8584)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);

    const replacementId = "b".repeat(64);
    runtime.setMatches([replacementId]);
    runtime.setContainerId(replacementId);
    expect(() => resolveTarget(stateDir, runtime)).toThrow("recorded container identity changed");

    runtime.setMatches([CONTAINER_ID]);
    runtime.setContainerId(CONTAINER_ID);
    runtime.setRunning(false);
    expect(() => resolveTarget(stateDir, runtime)).toThrow("is not running");
  });

  it.each([
    ["foreign owner", socketAuthorityDeps({ socketUid: 2000n }), "owned by uid 2000"],
    ["world-writable socket", socketAuthorityDeps({ socketMode: 0o666n }), "writable by another"],
    [
      "group-writable socket outside a private parent",
      socketAuthorityDeps({ directoryMode: 0o750n }),
      "writable by another",
    ],
    ["writable parent", socketAuthorityDeps({ directoryMode: 0o770n }), "writable by another"],
    ["symlinked parent", socketAuthorityDeps({ directory: false }), "not a real directory"],
  ])("refuses a %s for portable privileged exec (#8584)", (_case, authority, _message) => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);

    expect(() =>
      resolveTarget(stateDir, runtime, { podmanSocketAuthorityDeps: authority }),
    ).toThrow("socket authority");
  });

  it("ignores ambient Podman remote selection for portable privileged exec (#8584)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    runtime.podman.mockClear();

    resolveTarget(stateDir, runtime, {
      env: {
        CONTAINER_CONNECTION: "attacker",
        CONTAINER_HOST: "tcp://example.test:1234",
        CONTAINER_SSHKEY: "/tmp/attacker-key",
      },
    });

    runtime.podman.mock.calls.forEach(([, commandEnv]) => {
      expect(commandEnv).toMatchObject({
        HOME: RUNTIME_AUTHORITY.homeDir,
        XDG_CONFIG_HOME: RUNTIME_AUTHORITY.configHome,
        XDG_RUNTIME_DIR: RUNTIME_AUTHORITY.runtimeDir,
      });
      expect(commandEnv).not.toHaveProperty("CONTAINER_CONNECTION");
      expect(commandEnv).not.toHaveProperty("CONTAINER_HOST");
      expect(commandEnv).not.toHaveProperty("CONTAINER_SSHKEY");
    });
  });

  it("refuses socket replacement after portable workload inspection (#8584)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    let inode = 9001n;
    const target = resolveTarget(stateDir, runtime, {
      podmanSocketAuthorityDeps: socketAuthorityDeps({ socketInode: () => inode }),
    });
    inode = 9002n;

    expect(() => target?.assertRuntimeAuthority()).toThrow("changed after it was qualified");
  });

  it("does not persist proxy credentials from the create-time environment (#8441)", () => {
    const stateDir = temporaryStateDir();
    const { podman } = createPodman();

    installPortableDemoSandboxLifecycle(
      "alpha",
      [
        ...STARTUP_ARGV.slice(0, -1),
        "HTTPS_PROXY=https://user:password@example.test",
        STARTUP_ARGV.at(-1)!,
      ],
      { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
      {
        platform: "linux",
        podman,
        stateDir,
        runtimeAuthority: RUNTIME_AUTHORITY,
        podmanSocketAuthorityDeps: socketAuthorityDeps(),
        hardenSocketDirectory: vi.fn(),
        runtimeReadiness: {
          uid: 1001,
          home: RUNTIME_AUTHORITY.homeDir,
          systemctl: () => ({ status: 0 }),
          podmanCapture: () => ({
            status: 0,
            stdout: JSON.stringify({ Server: { Version: "5.6.1" } }),
            stderr: "",
          }),
        },
        log: vi.fn(),
      },
    );

    const receipt = fs.readFileSync(
      portableDemoLifecycleInternals.receiptPath("alpha", stateDir),
      "utf-8",
    );
    expect(receipt).not.toContain("PROXY");
    expect(receipt).not.toContain("user:password");
  });

  it("does not record lifecycle ownership when the restart policy update fails (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman({ updateStatus: 125 });

    expect(() => installReceipt(stateDir, runtime.podman)).toThrow(
      "Setting the portable restart policy",
    );
    expect(fs.existsSync(portableDemoLifecycleInternals.receiptPath("alpha", stateDir))).toBe(
      false,
    );
  });

  it("fails closed when exact OpenShell labels identify multiple containers (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman({
      discoveredContainerIds: [CONTAINER_ID, "b".repeat(64)],
    });

    expect(() => installReceipt(stateDir, runtime.podman)).toThrow(
      "requires one exact Podman container",
    );
    expect(runtime.podman).not.toHaveBeenCalledWith([
      "update",
      "--restart=unless-stopped",
      expect.any(String),
    ]);
    expect(fs.existsSync(portableDemoLifecycleInternals.receiptPath("alpha", stateDir))).toBe(
      false,
    );
  });

  it("starts the stopped container with the current OpenShell CA environment (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman({ running: false });
    installReceipt(stateDir, runtime.podman);
    const launchOpenshell = vi.fn();
    const log = vi.fn();
    const captureOpenshell = vi.fn((args: readonly string[]) => {
      const command = args.find((arg) => ["true", "pgrep", "curl", "python3"].includes(arg));
      switch (command) {
        case "true":
          return { status: 0 };
        case "pgrep":
          return { status: 1 };
        case "curl":
          return { status: 0, stdout: "000" };
        case "python3":
          return gatewayWaitResult();
        default:
          throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
      }
    });

    const result = recoverPortableDemoSandboxLifecycle(
      "alpha",
      { agent: sandboxEntry().agent, gatewayName: "nemoclaw" },
      {
        platform: "linux",
        stateDir,
        podman: runtime.podman,
        captureOpenshell,
        launchOpenshell,
        log,
      },
    );

    expect(result).toEqual({ kind: "recovered" });
    expect(runtime.podman).toHaveBeenCalledWith(
      ["--url", `unix://${SOCKET_PATH}`, "start", CONTAINER_ID],
      expect.any(Object),
    );
    expect(launchOpenshell).toHaveBeenCalledWith([
      "sandbox",
      "exec",
      "-g",
      "nemoclaw",
      "--name",
      "alpha",
      "--no-tty",
      "--",
      ...RECOVERY_STARTUP_ARGV,
    ]);
    expect(log).toHaveBeenCalledWith("  Portable demo lifecycle recovered sandbox 'alpha'.");
  });

  it("waits through a transient OpenShell registration gap after starting the container (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman({ running: false });
    installReceipt(stateDir, runtime.podman);
    const launchOpenshell = vi.fn();
    let now = 0;
    const captureOpenshell = vi.fn((args: readonly string[]) => {
      const command = args.find((arg) => ["true", "pgrep", "curl", "python3"].includes(arg));
      switch (command) {
        case "true":
          return { status: now >= 30_100 ? 0 : 1 };
        case "pgrep":
          return { status: 1 };
        case "curl":
          return { status: 0, stdout: "000" };
        case "python3":
          return gatewayWaitResult();
        default:
          throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
      }
    });

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: sandboxEntry().agent, gatewayName: "nemoclaw" },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
          captureOpenshell,
          launchOpenshell,
          now: () => now,
          sleep: (milliseconds) => {
            now += milliseconds;
          },
        },
      ),
    ).toEqual({ kind: "recovered" });
    expect(now).toBe(30_100);
    expect(launchOpenshell).toHaveBeenCalledOnce();
  });

  it("fails after the startup timeout when the managed startup process exists and the agent gateway does not pass its health check (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const launchOpenshell = vi.fn();
    let now = 0;
    const captureOpenshell = vi.fn((args: readonly string[]) => {
      const command = args.find((arg) => ["true", "pgrep", "curl", "python3"].includes(arg));
      switch (command) {
        case "true":
        case "pgrep":
          return { status: 0 };
        case "curl":
          return { status: 0, stdout: "000" };
        case "python3": {
          const emittedCommand = args.slice(args.lastIndexOf("--") + 1);
          const waiterTimeoutMs = Number(emittedCommand.at(-2));
          now += waiterTimeoutMs;
          return gatewayWaitResult("not-ready", { sleepMs: waiterTimeoutMs });
        }
        default:
          throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
      }
    });

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: sandboxEntry().agent, gatewayName: "nemoclaw" },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
          captureOpenshell,
          launchOpenshell,
          now: () => now,
          sleep: (milliseconds) => {
            now += milliseconds;
          },
        },
      ),
    ).toThrow("has a startup process, but its agent gateway did not pass");
    expect(now).toBe(90_000);
    expect(captureOpenshell.mock.calls.filter(([args]) => args.includes("curl"))).toHaveLength(1);
    expect(launchOpenshell).not.toHaveBeenCalled();
  });

  it("retries the same receipt after a detached startup times out (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const receiptPath = portableDemoLifecycleInternals.receiptPath("alpha", stateDir);
    const originalReceipt = fs.readFileSync(receiptPath, "utf-8");
    const launchOpenshell = vi.fn();
    let now = 0;
    const captureOpenshell = vi.fn((args: readonly string[]) => {
      const command = args.find((arg) => ["true", "pgrep", "curl", "python3"].includes(arg));
      switch (command) {
        case "true":
          return { status: 0 };
        case "pgrep":
          return { status: 1 };
        case "curl":
          return { status: 0, stdout: "000" };
        case "python3":
          now += 89_900;
          return gatewayWaitResult(launchOpenshell.mock.calls.length < 2 ? "not-ready" : "ready");
        default:
          throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
      }
    });
    const deps = {
      platform: "linux" as const,
      stateDir,
      podman: runtime.podman,
      captureOpenshell,
      launchOpenshell,
      now: () => now,
      sleep: (milliseconds: number) => {
        now += milliseconds;
      },
    };

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: sandboxEntry().agent, gatewayName: "nemoclaw" },
        deps,
      ),
    ).toThrow("startup did not start its agent gateway");

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: sandboxEntry().agent, gatewayName: "nemoclaw" },
        deps,
      ),
    ).toEqual({ kind: "recovered" });
    expect(launchOpenshell).toHaveBeenCalledTimes(2);
    expect(
      runtime.podman.mock.calls.some(([args]) => {
        const command = args[0] === "--url" ? args.slice(2) : args;
        return command[0] === "start";
      }),
    ).toBe(false);
    expect(fs.readFileSync(receiptPath, "utf-8")).toBe(originalReceipt);
  });

  it("removes only the stale receipt when its exact container no longer exists (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const filePath = portableDemoLifecycleInternals.receiptPath("alpha", stateDir);
    const otherFilePath = portableDemoLifecycleInternals.receiptPath("beta", stateDir);
    const otherReceipt = '{"sandboxName":"beta"}\n';
    fs.writeFileSync(otherFilePath, otherReceipt, { mode: 0o600 });
    runtime.podman.mockImplementation((args) => {
      const command = args[0] === "--url" ? args.slice(2) : args;
      return command[0] === "info"
        ? { status: 0, stdout: `${SOCKET_PATH}\n` }
        : {
            status: 125,
            stdout: `Error: no such container ${CONTAINER_ID}`,
          };
    });

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw" },
        { platform: "linux", stateDir, podman: runtime.podman },
      ),
    ).toEqual({ kind: "not-installed" });
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.readFileSync(otherFilePath, "utf-8")).toBe(otherReceipt);
  });

  it("does not launch a second startup command when the agent gateway responds (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const launchOpenshell = vi.fn();

    const result = recoverPortableDemoSandboxLifecycle(
      "alpha",
      { agent: sandboxEntry().agent, gatewayName: "nemoclaw" },
      {
        platform: "linux",
        stateDir,
        podman: runtime.podman,
        captureOpenshell: (args) =>
          args.includes("curl") ? { status: 0, stdout: "401" } : { status: 0 },
        launchOpenshell,
      },
    );

    expect(result).toEqual({ kind: "already-running" });
    expect(launchOpenshell).not.toHaveBeenCalled();
  });

  it("restarts receipt-owned user-local Ollama before reporting portable recovery complete (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const binPath = createManagedOllamaBinary(stateDir);
    recordUserLocalOllamaOwnership(binPath, { homeDir: stateDir, stateDir });
    let ollamaStarted = false;
    const captureHost = vi.fn((command: string) => {
      switch (command) {
        case "pgrep":
          return { status: 1 };
        case "curl":
          return ollamaStarted
            ? { status: 0, stdout: JSON.stringify({ models: [] }) }
            : { status: 7, stderr: "connection refused" };
        default:
          throw new Error(`Unexpected host command: ${command}`);
      }
    });
    const launchHost = vi.fn(() => {
      ollamaStarted = true;
    });
    const log = vi.fn();

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          env: { HOME: stateDir },
          stateDir,
          podman: runtime.podman,
          captureOpenshell: (args) =>
            args.includes("curl") ? { status: 0, stdout: "200" } : { status: 0 },
          captureHost,
          launchHost,
          log,
        },
      ),
    ).toEqual({ kind: "already-running" });
    expect(launchHost).toHaveBeenCalledWith(
      "/proc/self/fd/3",
      ["serve"],
      {
        HOME: stateDir,
        OLLAMA_HOST: "127.0.0.1:11434",
      },
      expect.any(Number),
    );
    expect(log).toHaveBeenCalledWith(
      "  Portable demo lifecycle restarted NemoClaw-managed Ollama.",
    );
    expect(captureHost).toHaveBeenCalledWith(
      "curl",
      expect.arrayContaining(["--noproxy", "127.0.0.1"]),
      5000,
    );
  });

  it("launches the validated Ollama identity when its pathname is replaced (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const binPath = createManagedOllamaBinary(stateDir);
    recordUserLocalOllamaOwnership(binPath, { homeDir: stateDir, stateDir });
    let ollamaStarted = false;
    const captureHost = vi.fn((command: string) =>
      command === "pgrep"
        ? { status: 1 }
        : ollamaStarted
          ? { status: 0, stdout: JSON.stringify({ models: [] }) }
          : { status: 7 },
    );
    const launchHost = vi.fn(
      (_command: string, _args: readonly string[], _env: NodeJS.ProcessEnv, descriptor: number) => {
        fs.renameSync(binPath, `${binPath}.validated`);
        fs.writeFileSync(binPath, "#!/bin/sh\n# replacement\n", { mode: 0o755 });
        expect(fs.readFileSync(descriptor, "utf8")).toBe("#!/bin/sh\n");
        ollamaStarted = true;
      },
    );

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          env: { HOME: stateDir },
          stateDir,
          podman: runtime.podman,
          captureOpenshell: (args) =>
            args.includes("curl") ? { status: 0, stdout: "200" } : { status: 0 },
          captureHost,
          launchHost,
        },
      ),
    ).toEqual({ kind: "already-running" });
    expect(launchHost).toHaveBeenCalledWith(
      "/proc/self/fd/3",
      ["serve"],
      expect.objectContaining({ OLLAMA_HOST: "127.0.0.1:11434" }),
      expect.any(Number),
    );
  });

  it("records an explicitly re-enrolled pre-receipt Ollama before recovery (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const binPath = createManagedOllamaBinary(stateDir);
    let ollamaStarted = false;
    const launchHost = vi.fn(() => {
      ollamaStarted = true;
    });

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          env: { HOME: stateDir, NEMOCLAW_PORTABLE_OLLAMA_REENROLL: "1" },
          stateDir,
          podman: runtime.podman,
          captureOpenshell: (args) =>
            args.includes("curl") ? { status: 0, stdout: "200" } : { status: 0 },
          captureHost: (command) =>
            command === "pgrep"
              ? { status: 1 }
              : ollamaStarted
                ? { status: 0, stdout: JSON.stringify({ models: [] }) }
                : { status: 7 },
          launchHost,
        },
      ),
    ).toEqual({ kind: "already-running" });
    expect(
      JSON.parse(
        fs.readFileSync(path.join(stateDir, "ollama", "user-local-ownership.json"), "utf8"),
      ),
    ).toMatchObject({ binPath });
    expect(launchHost).toHaveBeenCalledWith(
      "/proc/self/fd/3",
      ["serve"],
      {
        HOME: stateDir,
        OLLAMA_HOST: "127.0.0.1:11434",
      },
      expect.any(Number),
    );
  });

  it("rejects Ollama re-enrollment for a non-Ollama sandbox (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "nvidia" },
        {
          platform: "linux",
          env: { HOME: stateDir, NEMOCLAW_PORTABLE_OLLAMA_REENROLL: "1" },
          stateDir,
          podman: runtime.podman,
          captureOpenshell: () => ({ status: 0 }),
        },
      ),
    ).toThrow("requires a portable sandbox with the recorded ollama-local provider");
  });

  it("rejects a symlink before recording explicit Ollama re-enrollment (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const binPath = createManagedOllamaBinary(stateDir);
    const targetPath = path.join(stateDir, "ollama-target");
    fs.renameSync(binPath, targetPath);
    fs.symlinkSync(targetPath, binPath);

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          env: { HOME: stateDir, NEMOCLAW_PORTABLE_OLLAMA_REENROLL: "1" },
          stateDir,
          podman: runtime.podman,
          captureOpenshell: () => ({ status: 0 }),
        },
      ),
    ).toThrow("is not a regular executable");
    expect(fs.existsSync(path.join(stateDir, "ollama", "user-local-ownership.json"))).toBe(false);
  });

  it("rejects a symlinked receipt directory during explicit Ollama re-enrollment (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    createManagedOllamaBinary(stateDir);
    const plantedDirectory = path.join(stateDir, "planted-ollama-state");
    const receiptDirectory = path.join(stateDir, "ollama");
    fs.mkdirSync(plantedDirectory, { mode: 0o700 });
    fs.symlinkSync(plantedDirectory, receiptDirectory);
    vi.stubEnv("HOME", stateDir);
    const launchHost = vi.fn();

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          env: { HOME: stateDir, NEMOCLAW_PORTABLE_OLLAMA_REENROLL: "1" },
          stateDir,
          podman: runtime.podman,
          captureOpenshell: () => ({ status: 0 }),
          launchHost,
        },
      ),
    ).toThrow("is a symbolic link");
    expect(fs.existsSync(path.join(plantedDirectory, "user-local-ownership.json"))).toBe(false);
    expect(launchHost).not.toHaveBeenCalled();
  });

  it("does not inspect ownership or launch Ollama when the local API is already healthy (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const loadManagedOllama = vi.fn();
    const launchHost = vi.fn();

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
          captureOpenshell: (args) =>
            args.includes("curl") ? { status: 0, stdout: "200" } : { status: 0 },
          captureHost: (command) =>
            command === "curl"
              ? { status: 0, stdout: JSON.stringify({ models: [] }) }
              : { status: 1 },
          launchHost,
          loadManagedOllama,
        },
      ),
    ).toEqual({ kind: "already-running" });
    expect(loadManagedOllama).not.toHaveBeenCalled();
    expect(launchHost).not.toHaveBeenCalled();
  });

  it("does not launch an unowned user-local Ollama binary (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const launchHost = vi.fn();

    expect(
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
          captureOpenshell: (args) =>
            args.includes("curl") ? { status: 0, stdout: "200" } : { status: 0 },
          captureHost: () => ({ status: 7 }),
          launchHost,
          loadManagedOllama: () => null,
        },
      ),
    ).toEqual({ kind: "already-running" });
    expect(launchHost).not.toHaveBeenCalled();
  });

  it("refuses to launch a duplicate when another Ollama process is unhealthy (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const binPath = createManagedOllamaBinary(stateDir);
    const launchHost = vi.fn();

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
          captureOpenshell: () => ({ status: 0 }),
          captureHost: (command) => ({ status: command === "pgrep" ? 0 : 7 }),
          launchHost,
          loadManagedOllama: () => binPath,
        },
      ),
    ).toThrow("refused to launch a duplicate");
    expect(launchHost).not.toHaveBeenCalled();
  });

  it("refuses a receipt-owned Ollama binary that is not executable (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const binPath = createManagedOllamaBinary(stateDir);
    fs.chmodSync(binPath, 0o600);
    const launchHost = vi.fn();

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
          captureOpenshell: () => ({ status: 0 }),
          captureHost: () => ({ status: 7 }),
          launchHost,
          loadManagedOllama: () => binPath,
        },
      ),
    ).toThrow("is not a regular executable");
    expect(launchHost).not.toHaveBeenCalled();
  });

  it("refuses a receipt-owned Ollama path that is a symbolic link (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const targetPath = createManagedOllamaBinary(stateDir);
    const binPath = path.join(stateDir, "ollama-link");
    fs.symlinkSync(targetPath, binPath);
    const launchHost = vi.fn();

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
          captureOpenshell: () => ({ status: 0 }),
          captureHost: () => ({ status: 7 }),
          launchHost,
          loadManagedOllama: () => binPath,
        },
      ),
    ).toThrow("is not a regular executable");
    expect(launchHost).not.toHaveBeenCalled();
  });

  it("fails after the bounded timeout when restarted Ollama stays unhealthy (#8502)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const binPath = createManagedOllamaBinary(stateDir);
    let now = 0;
    const launchHost = vi.fn();

    let failure: Error | undefined;
    try {
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: "openclaw", gatewayName: "nemoclaw", provider: "ollama-local" },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
          captureOpenshell: () => ({ status: 0 }),
          captureHost: (command) =>
            command === "pgrep"
              ? { status: 1 }
              : { status: 0, stdout: JSON.stringify({ status: "ok" }) },
          launchHost,
          loadManagedOllama: () => binPath,
          now: () => now,
          sleep: (milliseconds) => {
            now += milliseconds;
          },
        },
      );
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toContain("did not become healthy");
    expect(failure?.message).toContain(
      `start the receipt-bound executable at ${JSON.stringify(binPath)} with the 'serve' argument, then retry`,
    );
    expect(now).toBe(30_000);
    expect(launchHost).toHaveBeenCalledOnce();
  });

  it("refuses schema-1 recovery without recorded runtime authority (#9070)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const receiptPath = portableDemoLifecycleInternals.receiptPath("alpha", stateDir);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8"));
    delete receipt.registryGeneration;
    delete receipt.runtimeAuthority;
    fs.writeFileSync(
      receiptPath,
      `${JSON.stringify({ ...receipt, schemaVersion: 1 }, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    runtime.podman.mockClear();
    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: sandboxEntry().agent, gatewayName: "nemoclaw" },
        { platform: "linux", stateDir, podman: runtime.podman },
      ),
    ).toThrow("predates recorded portable Podman authority");
    expect(runtime.podman).not.toHaveBeenCalled();
  });

  it("fails closed for a schema-1 receipt when the gateway is healthy without its managed startup process (#8441)", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    installReceipt(stateDir, runtime.podman);
    const receiptPath = portableDemoLifecycleInternals.receiptPath("alpha", stateDir);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8"));
    delete receipt.registryGeneration;
    delete receipt.runtimeAuthority;
    fs.writeFileSync(
      receiptPath,
      `${JSON.stringify({ ...receipt, schemaVersion: 1 }, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    const launchOpenshell = vi.fn();

    expect(() =>
      recoverPortableDemoSandboxLifecycle(
        "alpha",
        { agent: sandboxEntry().agent, gatewayName: "nemoclaw" },
        {
          platform: "linux",
          stateDir,
          podman: runtime.podman,
          captureOpenshell: (args) => {
            const command = args.find((arg) => ["true", "pgrep", "curl"].includes(arg));
            switch (command) {
              case "curl":
                return { status: 0, stdout: "200" };
              case "pgrep":
                return { status: 1 };
              default:
                return { status: 0 };
            }
          },
          launchOpenshell,
        },
      ),
    ).toThrow("predates recorded portable Podman authority");
    expect(launchOpenshell).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(receiptPath, "utf-8"))).toMatchObject({ schemaVersion: 1 });
  });
});

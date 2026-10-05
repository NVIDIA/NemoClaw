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
  listPortableDemoSandboxLifecycleReceipts,
  preparePortableDemoSandboxRemoval,
  portableDemoLifecycleInternals,
  stopPortableDemoSandboxLifecycle,
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
  let isolationRole: string | undefined;
  let companion = false;
  let duplicateWorkload = false;
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
        return {
          status: 0,
          stdout:
            CONTAINER_ID +
            "\n" +
            (duplicateWorkload ||
            (companion && !command.includes("label!=openshell.ai/isolation-role=supervisor"))
              ? "b".repeat(64) + "\n"
              : ""),
        };
      case "inspect":
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              Id: CONTAINER_ID,
              Name: containerName,
              Config: {
                Labels: {
                  ...(isolationRole === undefined
                    ? {}
                    : { "openshell.ai/isolation-role": isolationRole }),
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
    setIsolationRole(value: string | undefined) {
      isolationRole = value;
    },
    addCompanion() {
      companion = true;
    },
    addDuplicateWorkload() {
      duplicateWorkload = true;
    },
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

describe("portable receipt workload discovery", () => {
  it("installs the workload receipt when a supervisor shares its labels", () => {
    const stateDir = temporaryStateDir();
    const runtime = createPodman();
    runtime.setIsolationRole("sandbox");
    runtime.addCompanion();
    expect(() => installReceipt(stateDir, runtime.podman)).not.toThrow();
    expect(runtime.podman).toHaveBeenCalledWith(
      expect.arrayContaining(["update", "--restart=unless-stopped", CONTAINER_ID]),
      expect.any(Object),
    );
  });

  it("retains installation for legacy workloads without an isolation role", () => {
    const runtime = createPodman();
    expect(() => installReceipt(temporaryStateDir(), runtime.podman)).not.toThrow();
  });

  it.each(["supervisor", "unknown", ""])("rejects workload role %j before mutation", (role) => {
    const runtime = createPodman();
    runtime.setIsolationRole(role);
    expect(() => installReceipt(temporaryStateDir(), runtime.podman)).toThrow(
      "OpenShell identity does not match",
    );
    expect(runtime.podman.mock.calls.some(([args]) => args.includes("update"))).toBe(false);
  });

  it("rejects duplicate workloads after excluding the supervisor", () => {
    const runtime = createPodman();
    runtime.addDuplicateWorkload();
    expect(() => installReceipt(temporaryStateDir(), runtime.podman)).toThrow(
      "requires one exact Podman container",
    );
    expect(runtime.podman.mock.calls.some(([args]) => args.includes("update"))).toBe(false);
  });
});

function pairRemovalFixture() {
  const stateDir = temporaryStateDir();
  installReceipt(stateDir, createPodman().podman);
  const receipt = listPortableDemoSandboxLifecycleReceipts(stateDir)[0]!;
  const supervisorId = "b".repeat(64);
  const unrelatedId = "c".repeat(64);
  const labels = {
    "openshell.managed": "true",
    "openshell.ai/sandbox-id": SANDBOX_ID,
    "openshell.ai/sandbox-name": "alpha",
    "openshell.ai/sandbox-namespace": "",
    "openshell.ai/sandbox-workspace": "default",
  };
  const record = (id: string, name: string, role: string) => ({
    Id: id,
    Name: name,
    Config: {
      Labels: { ...labels, "openshell.ai/isolation-role": role } as Record<string, string>,
    },
    State: { Running: true, Status: "running" },
  });
  const workload = record(CONTAINER_ID, "openshell-default--alpha-" + SANDBOX_ID, "sandbox");
  const supervisor = record(supervisorId, "openshell-supervisor-" + SANDBOX_ID, "supervisor");
  const records = new Map([
    [CONTAINER_ID, workload],
    [supervisorId, supervisor],
    [unrelatedId, record(unrelatedId, "unrelated", "sandbox")],
  ]);
  const index = new Set([CONTAINER_ID, supervisorId]);
  const handlers: Record<
    string,
    (args: readonly string[]) => {
      status: number;
      stdout?: string;
      stderr?: string;
    }
  > = {
    ps: () => ({ status: 0, stdout: [...index].filter((id) => records.has(id)).join("\n") }),
    inspect: (args) => {
      const found = records.get(args[1]!);
      return found
        ? { status: 0, stdout: JSON.stringify([found]) }
        : { status: 125, stderr: "no such container" };
    },
    rm: (args) => {
      records.delete(args[2]!);
      return { status: 0 };
    },
  };
  const unexpected = (args: readonly string[]): never => {
    throw new Error("Unexpected fixture command: " + args.join(" "));
  };
  const podman = vi.fn((args: readonly string[]) => (handlers[args[0]!] ?? unexpected)(args));
  const assertRuntimeAuthority = vi.fn();
  return {
    stateDir,
    receipt,
    supervisorId,
    unrelatedId,
    workload,
    supervisor,
    records,
    index,
    podman,
    assertRuntimeAuthority,
    prepare: () =>
      preparePortableDemoSandboxRemoval(
        receipt,
        {
          assertRuntimeAuthority,
          dockerHost: "unix://" + SOCKET_PATH,
          podman,
        },
        stateDir,
      ),
    removals: () => podman.mock.calls.filter(([args]) => args[0] === "rm").map(([args]) => args),
  };
}

describe("portable receipt paired removal", () => {
  it("removes the validated supervisor then workload and preserves unrelated resources", () => {
    const f = pairRemovalFixture();
    const prepared = f.prepare();
    expect(prepared.present).toBe(true);
    prepared.removeAndVerify();
    expect(() => prepared.verifyAbsent()).not.toThrow();
    expect(f.removals()).toEqual([
      ["rm", "--force", f.supervisorId],
      ["rm", "--force", CONTAINER_ID],
    ]);
    expect([...f.records.keys()]).toEqual([f.unrelatedId]);
  });

  it("retains removal of a legacy workload without a companion or role label", () => {
    const f = pairRemovalFixture();
    f.records.delete(f.supervisorId);
    delete f.workload.Config.Labels["openshell.ai/isolation-role"];
    f.prepare().removeAndVerify();
    expect(f.removals()).toEqual([["rm", "--force", CONTAINER_ID]]);
  });

  it("removes a receipt-bound companion after the workload was already removed", () => {
    const f = pairRemovalFixture();
    f.records.delete(CONTAINER_ID);
    f.prepare().removeAndVerify();
    expect(f.removals()).toEqual([["rm", "--force", f.supervisorId]]);
  });

  it.each([
    ["openshell.ai/isolation-role", "sandbox"],
    ["openshell.ai/sandbox-id", "another-sandbox"],
    ["openshell.ai/sandbox-name", "another-name"],
    ["openshell.ai/sandbox-namespace", "another-namespace"],
    ["openshell.ai/sandbox-workspace", "another-workspace"],
    ["openshell.managed", "false"],
  ])("rejects a companion with changed %s before removal", (label, value) => {
    const f = pairRemovalFixture();
    f.supervisor.Config.Labels[label] = value;
    expect(() => f.prepare()).toThrow("replaced or ambiguous container");
    expect(f.removals()).toEqual([]);
  });

  it("rejects a companion whose engine name does not match its sandbox ID", () => {
    const f = pairRemovalFixture();
    f.supervisor.Name = "unrelated";
    expect(() => f.prepare()).toThrow("replaced or ambiguous container");
    expect(f.removals()).toEqual([]);
  });

  it("rechecks the companion ID before deleting either resource", () => {
    const f = pairRemovalFixture();
    const prepared = f.prepare();
    const replacement = "d".repeat(64);
    f.records.delete(f.supervisorId);
    f.records.set(replacement, { ...f.supervisor, Id: replacement });
    f.index.add(replacement);
    expect(() => prepared.removeAndVerify()).toThrow("container presence changed");
    expect(f.removals()).toEqual([]);
  });

  it("does not remove the workload when supervisor removal fails", () => {
    const f = pairRemovalFixture();
    const prepared = f.prepare();
    const original = f.podman.getMockImplementation()!;
    f.podman.mockImplementation((args) =>
      args[0] === "rm" ? { status: 125, stderr: "permission denied" } : original(args),
    );
    expect(() => prepared.removeAndVerify()).toThrow("still has a recorded Podman container");
    expect(f.removals()).toEqual([["rm", "--force", f.supervisorId]]);
    expect(f.records.has(CONTAINER_ID)).toBe(true);
  });

  it("rejects cleanup proof when an unindexed captured companion still exists", () => {
    const f = pairRemovalFixture();
    const prepared = f.prepare();
    f.records.delete(CONTAINER_ID);
    f.index.delete(f.supervisorId);
    expect(() => prepared.verifyAbsent()).toThrow("still has a recorded Podman container");
    expect(f.removals()).toEqual([]);
  });

  it("does not mutate after runtime authority is revoked", () => {
    const f = pairRemovalFixture();
    const prepared = f.prepare();
    f.assertRuntimeAuthority.mockImplementation(() => {
      throw new Error("socket changed");
    });
    expect(() => prepared.removeAndVerify()).toThrow("socket changed");
    expect(f.removals()).toEqual([]);
  });
});

function pairLifecycleFixture() {
  const f = pairRemovalFixture();
  const detail = { id: SANDBOX_ID, name: "alpha", workspace: "default", phase: "Stopped" };
  const setState = (running: boolean) => {
    for (const record of [f.workload, f.supervisor]) {
      record.State.Running = running;
      record.State.Status = running ? "running" : "exited";
    }
    detail.phase = running ? "Ready" : "Stopped";
  };
  setState(false);
  const transition = vi.fn((action: string): { status: number | null; error?: Error } => {
    setState(action === "start");
    return { status: 0 };
  });
  const handlers: Record<
    string,
    (args: readonly string[]) => {
      status: number | null;
      stdout?: string;
      error?: Error;
    }
  > = {
    get: () => ({ status: 0, stdout: JSON.stringify(detail) }),
    start: () => transition("start"),
    stop: () => transition("stop"),
    exec: (args) => ({ status: 0, stdout: args.includes("curl") ? "200" : "" }),
  };
  const unexpected = (args: readonly string[]): never => {
    throw new Error("Unexpected fixture OpenShell command: " + args.join(" "));
  };
  const capture = vi.fn((args: readonly string[], _timeoutMs: number) =>
    (handlers[args[1]!] ?? unexpected)(args),
  );
  const context = {
    agent: "openclaw",
    gatewayName: "nemoclaw",
    lifecycleGeneration: CONTAINER_ID,
    openshellDriver: "docker",
  };
  const deps: PortableDemoLifecycleDeps = {
    platform: "linux",
    stateDir: f.stateDir,
    env: { HOME: f.stateDir },
    podman: (args) => f.podman(args[0] === "--url" ? args.slice(2) : args),
    captureOpenshell: capture,
    log: vi.fn(),
    hardenSocketDirectory: vi.fn(),
    runtimeReadiness: {
      ...READINESS,
      podmanCapture: () => ({
        status: 0,
        stdout: JSON.stringify({ Server: { Version: "5.6.1" } }),
        stderr: "",
      }),
    },
  };
  const beforeStop = vi.fn();
  return {
    ...f,
    detail,
    setState,
    transition,
    capture,
    beforeStop,
    recover: () => recoverPortableDemoSandboxLifecycleUnchecked("alpha", context, deps),
    stop: () => stopPortableDemoSandboxLifecycle("alpha", context, beforeStop, deps),
    rawMutations: () =>
      f.podman.mock.calls.filter(([args]) => ["start", "stop"].includes(args[0]!)),
  };
}

describe("portable split-container gateway lifecycle", () => {
  it("starts through the named gateway with receipt identity checks", () => {
    const f = pairLifecycleFixture();
    expect(f.recover()).toEqual({ kind: "already-running" });
    expect(f.transition).toHaveBeenCalledExactlyOnceWith("start");
    expect(f.capture).toHaveBeenCalledWith(
      ["sandbox", "start", "-g", "nemoclaw", "--workspace", "default", "--", "alpha"],
      90_000,
    );
    expect(f.capture.mock.calls.filter(([args]) => args[1] === "get")).toHaveLength(2);
    expect(f.workload.State.Running && f.supervisor.State.Running).toBe(true);
    expect(f.rawMutations()).toEqual([]);
  });

  it("stops both containers through OpenShell before returning stopped", () => {
    const f = pairLifecycleFixture();
    f.setState(true);
    expect(f.stop()).toEqual({ kind: "stopped" });
    expect(f.transition).toHaveBeenCalledExactlyOnceWith("stop");
    expect(f.beforeStop).toHaveBeenCalledOnce();
    expect(f.workload.State.Running || f.supervisor.State.Running).toBe(false);
    expect(f.rawMutations()).toEqual([]);
  });

  it("returns already-stopped only after checking the gateway identity and phase", () => {
    const f = pairLifecycleFixture();
    expect(f.stop()).toEqual({ kind: "already-stopped" });
    expect(f.transition).not.toHaveBeenCalled();
    expect(f.beforeStop).not.toHaveBeenCalled();
    expect(f.capture.mock.calls.filter(([args]) => args[1] === "get")).toHaveLength(1);
  });

  it.each(["id", "name", "workspace"] as const)(
    "rejects gateway %s mismatch before mutation",
    (key) => {
      const f = pairLifecycleFixture();
      f.detail[key] = "another-identity";
      expect(() => f.recover()).toThrow("does not match the portable receipt");
      expect(f.transition).not.toHaveBeenCalled();
      expect(f.rawMutations()).toEqual([]);
    },
  );

  it("rejects changed gateway identity after an accepted start", () => {
    const f = pairLifecycleFixture();
    const original = f.transition.getMockImplementation()!;
    f.transition.mockImplementation((action) => {
      const result = original(action);
      f.detail.id = "replacement-id";
      return result;
    });
    expect(() => f.recover()).toThrow("does not match the portable receipt");
    expect(f.transition).toHaveBeenCalledOnce();
    expect(f.rawMutations()).toEqual([]);
  });

  it("preserves both containers when the gateway refuses the start", () => {
    const f = pairLifecycleFixture();
    f.transition.mockReturnValue({ status: 1 });
    expect(() => f.recover()).toThrow("no raw Podman fallback");
    expect(f.transition).toHaveBeenCalledOnce();
    expect(f.rawMutations()).toEqual([]);
    expect(f.records.has(CONTAINER_ID) && f.records.has(f.supervisorId)).toBe(true);
  });

  it("accepts a timed-out stop only when the same sandbox is proven stopped", () => {
    const f = pairLifecycleFixture();
    f.setState(true);
    f.transition.mockImplementation(() => {
      f.setState(false);
      return { status: null, error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) };
    });
    expect(f.stop()).toEqual({ kind: "stopped" });
    expect(f.transition).toHaveBeenCalledOnce();
    expect(f.rawMutations()).toEqual([]);
  });

  it("rechecks the receipt after the before-stop hook", () => {
    const f = pairLifecycleFixture();
    f.setState(true);
    f.beforeStop.mockImplementation(() => {
      const file = portableDemoLifecycleInternals.receiptPath("alpha", f.stateDir);
      const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
      receipt.dashboardPort += 1;
      fs.writeFileSync(file, JSON.stringify(receipt));
    });
    expect(() => f.stop()).toThrow("receipt changed");
    expect(f.transition).not.toHaveBeenCalled();
    expect(f.rawMutations()).toEqual([]);
  });
});

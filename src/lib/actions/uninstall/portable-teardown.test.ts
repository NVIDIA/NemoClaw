// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { PodmanSocketStat } from "../../adapters/podman/socket-authority";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import type { CommandResult } from "./portable-teardown";
import {
  clearPortableUserManagerSelectors,
  portableReceiptDirectory,
  readPortableReceipt,
  resolveReceiptRuntimeAuthority,
  teardownPortableRuntime,
} from "./portable-teardown";

const SOCKET_PATH = "/run/user/1001/podman/podman.sock";
const UID = 1001;
const SANDBOX_ID = "a".repeat(64);
const REGISTRY_ID = "b".repeat(64);

const UID_ENV: NodeJS.ProcessEnv = {
  HOME: "/home/tester",
  CONTAINERS_CONF: "/home/tester/.config/nemoclaw/portable/containers.conf",
  NETAVARK_FW: "iptables",
};

function runtimeAuthority(
  socketPath = SOCKET_PATH,
): CheckpointPortableRuntimeAuthority {
  return {
    schemaVersion: 1,
    kind: "podman",
    ownership: "current-user",
    uid: UID,
    homeDir: "/home/tester",
    configHome: "/home/tester/.config",
    runtimeDir: "/run/user/1001",
    socketPath,
  };
}

function receiptJson(containerId: string): string {
  return JSON.stringify({
    schemaVersion: 4,
    sandboxName: "sandbox-1",
    containerId,
    registryGeneration: "gen-1",
    runtimeAuthority: runtimeAuthority(),
  });
}

function receiptFile(
  stateDir: string,
  name: string,
  containerId: string,
): string {
  return `${portableReceiptDirectory(stateDir)}/${name}`;
}

function inspectJson(
  fullId: string,
  options: {
    running?: boolean;
    sandboxName?: string;
    managed?: boolean;
    namespace?: string;
    workspace?: string;
    registryOwned?: boolean;
  } = {},
): string {
  return JSON.stringify([
    {
      Id: fullId,
      State: { Running: options.running ?? true },
      Config: {
        Labels: {
          "openshell.managed": options.managed === false ? "false" : "true",
          "openshell.ai/sandbox-name": options.sandboxName ?? "sandbox-1",
          "openshell.ai/sandbox-namespace": options.namespace ?? "",
          "openshell.ai/sandbox-workspace": options.workspace ?? "default",
          "com.nvidia.nemoclaw.portable":
            options.registryOwned === false ? undefined : "1",
        },
      },
    },
  ]);
}

function socketStat(filePath: string): PodmanSocketStat {
  if (filePath === SOCKET_PATH) {
    return {
      dev: 11n,
      ino: 9001n,
      mode: 0o660n,
      uid: 1001n,
      isDirectory: () => false,
      isSocket: () => true,
    };
  }
  const mode =
    filePath === "/run/user/1001" || filePath === "/run/user/1001/podman"
      ? 0o700n
      : 0o755n;
  return {
    dev: 11n,
    ino: 7000n + BigInt(filePath.length),
    mode,
    uid: 1001n,
    isDirectory: () => true,
    isSocket: () => false,
  };
}

function socketAuthorityDeps(): {
  lstat: (filePath: string) => PodmanSocketStat;
  uid: number;
} {
  return { lstat: socketStat, uid: UID };
}

function commandRecorder(
  script: (
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => CommandResult,
) {
  const calls: Array<{
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
  }> = [];
  const run = (
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): CommandResult => {
    calls.push({ command, args, env });
    return script(command, args, env);
  };
  return { calls, run };
}

function scriptedCommand(
  responses: Readonly<Record<string, CommandResult>>,
): (command: string, args: string[], env: NodeJS.ProcessEnv) => CommandResult {
  return (command, args) => {
    const key = `${command}:${command === "systemctl" ? args[1] : args[0]}`;
    return (
      responses[key] ?? { status: 1, stdout: "", stderr: `unexpected: ${key}` }
    );
  };
}

function podmanEnvAssert(
  calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }>,
) {
  for (const call of calls) {
    if (call.command !== "podman") continue;
    expect(call.env.CONTAINER_HOST).toBe(`unix://${SOCKET_PATH}`);
    expect(call.env).not.toHaveProperty("CONTAINER_CONNECTION");
    expect(call.env).not.toHaveProperty("CONTAINER_SSHKEY");
  }
}

describe("readPortableReceipt", () => {
  it("parses a schema-4 receipt with its runtime authority", () => {
    const receipt = readPortableReceipt("receipt.json", () =>
      receiptJson(SANDBOX_ID),
    );
    expect(receipt?.containerId).toBe(SANDBOX_ID);
    expect(receipt?.schemaVersion).toBe(4);
    expect(receipt?.sandboxName).toBe("sandbox-1");
    expect(receipt?.runtimeAuthority?.socketPath).toBe(SOCKET_PATH);
  });

  it("returns null for malformed JSON, a missing containerId, an invalid id, or missing authority", () => {
    expect(readPortableReceipt("a.json", () => "{not json")).toBeNull();
    expect(readPortableReceipt("a.json", () => "{}")).toBeNull();
    expect(
      readPortableReceipt("a.json", () =>
        JSON.stringify({ containerId: "../not-a-container-id" }),
      ),
    ).toBeNull();
    expect(
      readPortableReceipt("a.json", () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
    // schema 4 without a valid recorded authority cannot be trusted.
    expect(
      readPortableReceipt("a.json", () =>
        JSON.stringify({ schemaVersion: 4, containerId: SANDBOX_ID }),
      ),
    ).toBeNull();
  });
});

describe("resolveReceiptRuntimeAuthority", () => {
  it("refuses receipts that predate recorded portable Podman authority", () => {
    const receipt = readPortableReceipt("a.json", () =>
      JSON.stringify({ schemaVersion: 3, containerId: SANDBOX_ID }),
    );
    expect(receipt).not.toBeNull();
    const resolved = resolveReceiptRuntimeAuthority(receipt!, UID);
    expect("reason" in resolved).toBe(true);
    expect((resolved as { reason: string }).reason).toContain("predates");
  });

  it("refuses an authority recorded for a different user", () => {
    const receipt = readPortableReceipt("a.json", () =>
      JSON.stringify({
        schemaVersion: 4,
        containerId: SANDBOX_ID,
        runtimeAuthority: {
          ...runtimeAuthority(),
          uid: 2000,
          runtimeDir: "/run/user/2000",
          socketPath: "/run/user/2000/podman/podman.sock",
        },
      }),
    );
    const resolved = resolveReceiptRuntimeAuthority(receipt!, UID);
    expect("reason" in resolved).toBe(true);
    expect((resolved as { reason: string }).reason).toContain("uid");
  });
});

describe("teardownPortableRuntime", () => {
  it("is a no-op when there is no portable runtime to tear down", () => {
    const { calls, run } = commandRecorder(() => ({
      status: 1,
      stdout: "",
      stderr: "nope",
    }));
    const result = teardownPortableRuntime({
      env: { HOME: "/home/tester" },
      stateDir: "/home/tester/.nemoclaw",
      uid: UID,
      socketAuthorityDeps: socketAuthorityDeps(),
      run,
      readDirSync: () => {
        throw new Error("ENOENT");
      },
      readFileSync: () => {
        throw new Error("ENOENT");
      },
      rmSync: () => {
        throw new Error("unexpected rmSync");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.removedContainerIds).toEqual([]);
    expect(result.removedReceiptFiles).toEqual([]);
    expect(result.unsetSelectors).toEqual([]);
    // No destructive calls — and no ambient podman access either: without a
    // receipt there is no recorded socket authority to pin a transport to.
    expect(calls.filter((c) => c.command === "podman")).toEqual([]);
    expect(
      calls.filter(
        (c) => c.command === "systemctl" && c.args[1] === "unset-environment",
      ),
    ).toEqual([]);
  });

  it("removes verified receipt and registry containers through the pinned socket, clears matched selectors, then retires receipts", () => {
    const stateDir = "/home/tester/.nemoclaw";
    const file = receiptFile(stateDir, "deadbeef.json", SANDBOX_ID);
    const { calls, run } = commandRecorder(
      scriptedCommand({
        "podman:inspect": (() => {
          let calls = 0;
          return {
            status: 0,
            get stdout() {
              calls += 1;
              return calls === 1
                ? inspectJson(SANDBOX_ID)
                : inspectJson(REGISTRY_ID);
            },
            stderr: "",
          };
        })(),
        "podman:ps": { status: 0, stdout: `${REGISTRY_ID}\n`, stderr: "" },
        "podman:rm": { status: 0, stdout: "", stderr: "" },
        "systemctl:show-environment": {
          status: 0,
          stdout:
            "CONTAINERS_CONF=/home/tester/.config/nemoclaw/portable/containers.conf\n" +
            `CONTAINER_HOST=unix://${SOCKET_PATH}\n` +
            "NETAVARK_FW=iptables\n",
          stderr: "",
        },
        "systemctl:unset-environment": { status: 0, stdout: "", stderr: "" },
      }),
    );
    const removed: string[] = [];
    const result = teardownPortableRuntime({
      env: UID_ENV,
      stateDir,
      uid: UID,
      socketAuthorityDeps: socketAuthorityDeps(),
      run,
      readDirSync: (dir) =>
        dir === portableReceiptDirectory(stateDir) ? ["deadbeef.json"] : [],
      readFileSync: (f) => (f === file ? receiptJson(SANDBOX_ID) : ""),
      rmSync: (f) => {
        removed.push(f);
      },
      log: () => {},
      warn: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.removedContainerIds).toEqual([SANDBOX_ID, REGISTRY_ID]);
    expect(result.unsetSelectors).toEqual([
      "CONTAINERS_CONF",
      "NETAVARK_FW",
      "CONTAINER_HOST",
    ]);
    expect(result.removedReceiptFiles).toEqual([file]);
    expect(removed).toEqual([file]);
    // Every podman call went through the recorded socket, and deletion used
    // the verified full container IDs.
    podmanEnvAssert(calls);
    const rmCalls = calls.filter(
      (c) => c.command === "podman" && c.args[0] === "rm",
    );
    expect(rmCalls.map((c) => c.args[2])).toEqual([SANDBOX_ID, REGISTRY_ID]);
    const inspectCalls = calls.filter(
      (c) => c.command === "podman" && c.args[0] === "inspect",
    );
    expect(inspectCalls).toHaveLength(2);
  });

  it("refuses a receipt that predates recorded socket authority and preserves everything", () => {
    const stateDir = "/home/tester/.nemoclaw";
    const file = receiptFile(stateDir, "deadbeef.json", SANDBOX_ID);
    const { calls, run } = commandRecorder(() => ({
      status: 1,
      stdout: "",
      stderr: "unexpected",
    }));
    const removed: string[] = [];
    const result = teardownPortableRuntime({
      env: UID_ENV,
      stateDir,
      uid: UID,
      socketAuthorityDeps: socketAuthorityDeps(),
      run,
      readDirSync: (dir) =>
        dir === portableReceiptDirectory(stateDir) ? ["deadbeef.json"] : [],
      readFileSync: (f) =>
        f === file
          ? JSON.stringify({ schemaVersion: 3, containerId: SANDBOX_ID })
          : "",
      rmSync: (f) => {
        removed.push(f);
      },
      log: () => {},
      warn: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("predates");
    expect(removed).toEqual([]);
    expect(
      calls.filter((c) => c.command === "podman" && c.args[0] === "rm"),
    ).toEqual([]);
  });

  it("fails closed when the recorded socket cannot be revalidated", () => {
    const stateDir = "/home/tester/.nemoclaw";
    const file = receiptFile(stateDir, "deadbeef.json", SANDBOX_ID);
    const { calls, run } = commandRecorder(() => ({
      status: 1,
      stdout: "",
      stderr: "unexpected",
    }));
    const result = teardownPortableRuntime({
      env: UID_ENV,
      stateDir,
      uid: UID,
      socketAuthorityDeps: {
        lstat: () => {
          throw new Error("ENOENT");
        },
        uid: UID,
      },
      run,
      readDirSync: (dir) =>
        dir === portableReceiptDirectory(stateDir) ? ["deadbeef.json"] : [],
      readFileSync: (f) => (f === file ? receiptJson(SANDBOX_ID) : ""),
      rmSync: () => {},
      log: () => {},
      warn: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("could not be revalidated");
    expect(
      calls.filter((c) => c.command === "podman" && c.args[0] === "rm"),
    ).toEqual([]);
  });

  it("preserves the receipt and selectors when a container cannot be removed", () => {
    const stateDir = "/home/tester/.nemoclaw";
    const file = receiptFile(stateDir, "deadbeef.json", SANDBOX_ID);
    const { calls, run } = commandRecorder(
      scriptedCommand({
        "podman:inspect": {
          status: 0,
          stdout: inspectJson(SANDBOX_ID),
          stderr: "",
        },
        "podman:rm": {
          status: 1,
          stdout: "",
          stderr: "Error: no such container",
        },
      }),
    );
    const removed: string[] = [];
    const result = teardownPortableRuntime({
      env: UID_ENV,
      stateDir,
      uid: UID,
      socketAuthorityDeps: socketAuthorityDeps(),
      run,
      readDirSync: (dir) =>
        dir === portableReceiptDirectory(stateDir) ? ["deadbeef.json"] : [],
      readFileSync: (f) => (f === file ? receiptJson(SANDBOX_ID) : ""),
      rmSync: (f) => {
        removed.push(f);
      },
      log: () => {},
      warn: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("preserved for retry");
    // The receipt (the container ID needed for retry) stays, and the selectors
    // are NOT cleared while runtime state remains.
    expect(removed).toEqual([]);
    expect(result.unsetSelectors).toEqual([]);
    expect(
      calls.filter(
        (c) => c.command === "systemctl" && c.args[1] === "unset-environment",
      ),
    ).toEqual([]);
  });

  it("refuses deletion when the inspected container identity does not match", () => {
    const stateDir = "/home/tester/.nemoclaw";
    const file = receiptFile(stateDir, "deadbeef.json", SANDBOX_ID);
    const { calls, run } = commandRecorder(
      scriptedCommand({
        "podman:inspect": {
          status: 0,
          stdout: inspectJson(SANDBOX_ID, { sandboxName: "other-sandbox" }),
          stderr: "",
        },
      }),
    );
    const removed: string[] = [];
    const result = teardownPortableRuntime({
      env: UID_ENV,
      stateDir,
      uid: UID,
      socketAuthorityDeps: socketAuthorityDeps(),
      run,
      readDirSync: (dir) =>
        dir === portableReceiptDirectory(stateDir) ? ["deadbeef.json"] : [],
      readFileSync: (f) => (f === file ? receiptJson(SANDBOX_ID) : ""),
      rmSync: (f) => {
        removed.push(f);
      },
      log: () => {},
      warn: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("sandbox name does not match");
    expect(removed).toEqual([]);
    expect(
      calls.filter((c) => c.command === "podman" && c.args[0] === "rm"),
    ).toEqual([]);
  });

  it("skips malformed receipts without deleting or removing them and fails closed", () => {
    const stateDir = "/home/tester/.nemoclaw";
    const file = receiptFile(stateDir, "deadbeef.json", SANDBOX_ID);
    const { calls, run } = commandRecorder(() => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));
    const removed: string[] = [];
    const result = teardownPortableRuntime({
      env: { HOME: "/home/tester" },
      stateDir,
      uid: UID,
      socketAuthorityDeps: socketAuthorityDeps(),
      run,
      readDirSync: (dir) =>
        dir === portableReceiptDirectory(stateDir) ? ["deadbeef.json"] : [],
      readFileSync: () => "{not json",
      rmSync: (f) => {
        removed.push(f);
      },
      log: () => {},
      warn: () => {},
    });
    // Unprovable ownership is fatal: exit nonzero, preserve the evidence.
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("unreadable portable lifecycle receipt");
    expect(removed).toEqual([]);
    expect(calls.filter((c) => c.command === "podman")).toEqual([]);
  });
});

describe("clearPortableUserManagerSelectors", () => {
  it("unsets only the NemoClaw-owned selectors whose value still matches", () => {
    const { calls, run } = commandRecorder(
      scriptedCommand({
        "systemctl:show-environment": {
          status: 0,
          stdout:
            "CONTAINERS_CONF=/home/tester/.config/nemoclaw/portable/containers.conf\n" +
            `CONTAINER_HOST=unix://${SOCKET_PATH}\n` +
            "NETAVARK_FW=iptables\n" +
            "CONTAINER_CONNECTION=user-chosen\n" +
            "CONTAINER_SSHKEY=/home/tester/.ssh/id_user\n" +
            "MY_APP=/unrelated/path\n",
          stderr: "",
        },
        "systemctl:unset-environment": { status: 0, stdout: "", stderr: "" },
      }),
    );
    const unset = clearPortableUserManagerSelectors(UID_ENV, run, SOCKET_PATH);
    expect(unset).toEqual(["CONTAINERS_CONF", "NETAVARK_FW", "CONTAINER_HOST"]);
    const unsetCalls = calls.filter(
      (c) => c.command === "systemctl" && c.args[1] === "unset-environment",
    );
    expect(unsetCalls.map((c) => c.args[2])).toEqual([
      "CONTAINERS_CONF",
      "NETAVARK_FW",
      "CONTAINER_HOST",
    ]);
  });

  it("leaves unrelated or changed selector values alone", () => {
    const { calls, run } = commandRecorder(
      scriptedCommand({
        "systemctl:show-environment": {
          status: 0,
          stdout:
            "CONTAINERS_CONF=/etc/containers/containers.conf\n" +
            `CONTAINER_HOST=unix:///run/user/9999/podman/podman.sock\n` +
            "NETAVARK_FW=firewalld\n",
          stderr: "",
        },
      }),
    );
    const unset = clearPortableUserManagerSelectors(
      { HOME: "/home/tester" },
      run,
      SOCKET_PATH,
    );
    expect(unset).toEqual([]);
    const unsetCalls = calls.filter(
      (c) => c.command === "systemctl" && c.args[1] === "unset-environment",
    );
    expect(unsetCalls).toEqual([]);
  });
});

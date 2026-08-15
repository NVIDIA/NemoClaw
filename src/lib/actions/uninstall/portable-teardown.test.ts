// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { CommandResult } from "./portable-teardown";
import {
  clearPortableUserManagerSelectors,
  portableReceiptDirectory,
  readPortableReceipt,
  teardownPortableRuntime,
} from "./portable-teardown";

const UID_ENV: NodeJS.ProcessEnv = {
  HOME: "/home/tester",
  CONTAINERS_CONF: "/home/tester/.config/nemoclaw/portable/containers.conf",
  NETAVARK_FW: "iptables",
};

function receiptFile(stateDir: string, name: string, containerId: string): string {
  return `${portableReceiptDirectory(stateDir)}/${name}`;
}

function commandRecorder(script: (command: string, args: string[]) => CommandResult) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run = (command: string, args: string[]): CommandResult => {
    calls.push({ command, args });
    return script(command, args);
  };
  return { calls, run };
}

describe("readPortableReceipt", () => {
  it("parses a valid receipt", () => {
    const receipt = readPortableReceipt("receipt.json", () =>
      JSON.stringify({ schemaVersion: 4, containerId: "abc123def456" }),
    );
    expect(receipt).toEqual({ containerId: "abc123def456" });
  });

  it("returns null for malformed JSON, a missing containerId, or an invalid id", () => {
    expect(readPortableReceipt("a.json", () => "{not json")).toBeNull();
    expect(readPortableReceipt("a.json", () => "{}")).toBeNull();
    expect(
      readPortableReceipt("a.json", () => JSON.stringify({ containerId: "../not-a-container-id" })),
    ).toBeNull();
    expect(
      readPortableReceipt("a.json", () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });
});

describe("teardownPortableRuntime", () => {
  it("is a no-op when there is no portable runtime to tear down", () => {
    const { calls, run } = commandRecorder(() => ({ status: 1, stdout: "", stderr: "nope" }));
    const result = teardownPortableRuntime({
      env: { HOME: "/home/tester" },
      stateDir: "/home/tester/.nemoclaw",
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
    // No destructive calls when there is nothing to remove (the label scan and
    // the user-manager selector probe are read-only).
    expect(calls.filter((c) => c.command === "podman" && c.args[0] === "rm")).toEqual([]);
    expect(
      calls.filter((c) => c.command === "systemctl" && c.args[1] === "unset-environment"),
    ).toEqual([]);
  });

  it("removes the receipt-owned container by ID and the label-owned registry container", () => {
    const stateDir = "/home/tester/.nemoclaw";
    const sandboxId = "aaaabbbbccccdddd";
    const registryId = "1111222233334444";
    const file = receiptFile(stateDir, "deadbeef.json", sandboxId);
    const { calls, run } = commandRecorder((command, args) => {
      if (command === "podman" && args[0] === "ps") {
        return { status: 0, stdout: `${registryId}\n`, stderr: "" };
      }
      if (command === "podman" && args[0] === "rm") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "systemctl" && args[1] === "show-environment") {
        return {
          status: 0,
          stdout:
            "CONTAINERS_CONF=/home/tester/.config/nemoclaw/portable/containers.conf\nNETAVARK_FW=iptables\n",
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "unexpected" };
    });
    const removed: string[] = [];
    const result = teardownPortableRuntime({
      env: UID_ENV,
      stateDir,
      run,
      readDirSync: (dir) => (dir === portableReceiptDirectory(stateDir) ? ["deadbeef.json"] : []),
      readFileSync: (f) => (f === file ? JSON.stringify({ containerId: sandboxId }) : ""),
      rmSync: (f) => {
        removed.push(f);
      },
      log: () => {},
      warn: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.removedContainerIds).toEqual([sandboxId, registryId]);
    expect(result.removedReceiptFiles).toEqual([file]);
    expect(removed).toEqual([file]);
    const rmCalls = calls.filter((c) => c.command === "podman" && c.args[0] === "rm");
    expect(rmCalls.map((c) => c.args[2])).toEqual([sandboxId, registryId]);
  });

  it("does not double-remove a container already removed via its receipt", () => {
    const stateDir = "/home/tester/.nemoclaw";
    const sandboxId = "aaaabbbbccccdddd";
    const file = receiptFile(stateDir, "deadbeef.json", sandboxId);
    const { calls, run } = commandRecorder((command, args) => {
      if (command === "podman" && args[0] === "ps") {
        return { status: 0, stdout: `${sandboxId}\n`, stderr: "" };
      }
      if (command === "podman" && args[0] === "rm") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unexpected" };
    });
    const result = teardownPortableRuntime({
      env: { HOME: "/home/tester" },
      stateDir,
      run,
      readDirSync: (dir) => (dir === portableReceiptDirectory(stateDir) ? ["deadbeef.json"] : []),
      readFileSync: (f) => (f === file ? JSON.stringify({ containerId: sandboxId }) : ""),
      rmSync: () => {},
      log: () => {},
      warn: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.removedContainerIds).toEqual([sandboxId]);
    const rmCalls = calls.filter((c) => c.command === "podman" && c.args[0] === "rm");
    expect(rmCalls).toHaveLength(1);
  });

  it("reports ok=false when a receipt-owned container cannot be removed", () => {
    const stateDir = "/home/tester/.nemoclaw";
    const sandboxId = "aaaabbbbccccdddd";
    const file = receiptFile(stateDir, "deadbeef.json", sandboxId);
    const { calls, run } = commandRecorder((command, args) => {
      if (command === "podman" && args[0] === "ps") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "podman" && args[0] === "rm") {
        return { status: 1, stdout: "", stderr: "Error: No such container" };
      }
      return { status: 1, stdout: "", stderr: "unexpected" };
    });
    const result = teardownPortableRuntime({
      env: { HOME: "/home/tester" },
      stateDir,
      run,
      readDirSync: (dir) => (dir === portableReceiptDirectory(stateDir) ? ["deadbeef.json"] : []),
      readFileSync: (f) => (f === file ? JSON.stringify({ containerId: sandboxId }) : ""),
      rmSync: () => {},
      log: () => {},
      warn: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("could not all be removed");
    // The registry scan still ran.
    expect(calls.some((c) => c.command === "podman" && c.args[0] === "ps")).toBe(true);
  });

  it("skips malformed receipts without deleting or removing them", () => {
    const stateDir = "/home/tester/.nemoclaw";
    const file = receiptFile(stateDir, "deadbeef.json", "ignored");
    const { calls, run } = commandRecorder(() => ({ status: 0, stdout: "", stderr: "" }));
    const removed: string[] = [];
    const result = teardownPortableRuntime({
      env: { HOME: "/home/tester" },
      stateDir,
      run,
      readDirSync: (dir) => (dir === portableReceiptDirectory(stateDir) ? ["deadbeef.json"] : []),
      readFileSync: () => "{not json",
      rmSync: (f) => {
        removed.push(f);
      },
      log: () => {},
      warn: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.removedContainerIds).toEqual([]);
    expect(result.removedReceiptFiles).toEqual([]);
    expect(removed).toEqual([]);
    expect(calls.filter((c) => c.command === "podman")).toHaveLength(1); // registry scan only
  });
});

describe("clearPortableUserManagerSelectors", () => {
  it("unsets only the NemoClaw-owned selectors", () => {
    const { calls, run } = commandRecorder((command, args) => {
      if (command === "systemctl" && args[1] === "show-environment") {
        return {
          status: 0,
          stdout:
            "CONTAINERS_CONF=/home/tester/.config/nemoclaw/portable/containers.conf\n" +
            "NETAVARK_FW=iptables\n" +
            "MY_APP=/unrelated/path\n",
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const unset = clearPortableUserManagerSelectors(UID_ENV, run);
    expect(unset).toEqual(["CONTAINERS_CONF", "NETAVARK_FW"]);
    const unsetCalls = calls.filter(
      (c) => c.command === "systemctl" && c.args[1] === "unset-environment",
    );
    expect(unsetCalls.map((c) => c.args[2])).toEqual(["CONTAINERS_CONF", "NETAVARK_FW"]);
  });

  it("leaves unrelated selector values alone", () => {
    const { calls, run } = commandRecorder((command, args) => {
      if (command === "systemctl" && args[1] === "show-environment") {
        return {
          status: 0,
          stdout: "CONTAINERS_CONF=/etc/containers/containers.conf\n" + "NETAVARK_FW=firewalld\n",
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const unset = clearPortableUserManagerSelectors({ HOME: "/home/tester" }, run);
    expect(unset).toEqual([]);
    const unsetCalls = calls.filter(
      (c) => c.command === "systemctl" && c.args[1] === "unset-environment",
    );
    expect(unsetCalls).toEqual([]);
  });
});

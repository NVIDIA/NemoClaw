// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PodmanManagedSandboxRecreateTransaction } from "../compute/podman/sandbox-recreate";
import type { PodmanManagedStartupTransaction } from "./podman-root-apply";
import type {
  PodmanManagedStartupCommandResult,
  RunManagedStartupPodmanCommand,
} from "./podman-runtime";
import { finalizePodmanManagedStartupSharedState } from "./podman-shared-state";
import {
  MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY,
  MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY,
  MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
} from "./shared-state-transaction";

const SOCKET_PATH = "/run/user/1000/podman/podman.sock";
const SOCKET_URL = `unix://${SOCKET_PATH}`;
const SOCKET_AUTHORITY = {
  directoryChain: [
    {
      device: "8",
      inode: "7000",
      mode: "448",
      ownerUid: "1000",
      path: "/run/user/1000/podman",
    },
  ],
  device: "8",
  inode: "9001",
  ownerUid: "1000",
  socketPath: SOCKET_PATH,
} as const;
const CONTAINER_ID = "b".repeat(64);
const IMAGE_ID = `sha256:${"c".repeat(64)}`;
const BOOTSTRAP_IDENTITY = "d".repeat(64);
const PROFILE_FINGERPRINT = "e".repeat(64);
const GRAPH_ROOT = "/home/test/.local/share/containers/storage";
const RUN_ROOT = "/run/user/1000/containers";

function transaction(
  agent: PodmanManagedStartupTransaction["agent"] = "openclaw",
): PodmanManagedStartupTransaction {
  return {
    agent,
    bootstrapIdentity: BOOTSTRAP_IDENTITY,
    containerId: CONTAINER_ID,
    image: IMAGE_ID,
    profileFingerprint: PROFILE_FINGERPRINT,
    runtime: {
      fingerprint: createHash("sha256").update(`${GRAPH_ROOT}\0${RUN_ROOT}`).digest("hex"),
      socketAuthority: SOCKET_AUTHORITY,
      socketPath: SOCKET_PATH,
    },
  };
}

function rollbackAuthority(
  overrides: Partial<PodmanManagedSandboxRecreateTransaction> = {},
): PodmanManagedSandboxRecreateTransaction {
  return {
    applied: true,
    driverName: "podman",
    immutableImage: IMAGE_ID,
    newContainerId: CONTAINER_ID,
    socketAuthority: SOCKET_AUTHORITY,
    socketPath: SOCKET_PATH,
    ...overrides,
  } as PodmanManagedSandboxRecreateTransaction;
}

function testDeps(run: RunManagedStartupPodmanCommand) {
  return { assertSocketAuthority: vi.fn(), run };
}

function result(
  status: number | null,
  overrides: Partial<PodmanManagedStartupCommandResult> = {},
): PodmanManagedStartupCommandResult {
  return { status, stderr: "", stdout: "", ...overrides };
}

function identityRunner(
  mutation: (
    args: readonly string[],
    options: Parameters<RunManagedStartupPodmanCommand>[2],
  ) => PodmanManagedStartupCommandResult,
  config: { readonly commitOnFailure?: boolean } = {},
): {
  readonly calls: string[];
  readonly receiptPaths: string[];
  readonly run: RunManagedStartupPodmanCommand;
} {
  const calls: string[] = [];
  const receiptPaths: string[] = [];
  let running = true;
  let receiptState: "committed" | "none" | "pending" = "pending";
  const run = vi.fn((_command, args, options) => {
    expect(args.slice(0, 2)).toEqual(["--url", SOCKET_URL]);
    const operation = args.slice(2);
    if (operation[0] === "info") {
      return result(0, {
        stdout: JSON.stringify({
          host: { security: { rootless: true } },
          store: { graphRoot: GRAPH_ROOT, runRoot: RUN_ROOT },
        }),
      });
    }
    if (operation[0] === "container" && operation[1] === "inspect") {
      return result(0, {
        stdout: JSON.stringify([
          {
            Id: CONTAINER_ID,
            Image: IMAGE_ID,
            State: { Dead: false, Paused: false, Restarting: false, Running: running },
          },
        ]),
      });
    }
    if (operation[0] === "stop") {
      calls.push("stop");
      const mutationResult = mutation(operation, options);
      if (mutationResult.status === 0) running = false;
      return mutationResult;
    }
    if (operation[0] === "cp") {
      const source = String(operation[1] ?? "");
      const isCommittedReceipt = source.endsWith(
        `:${MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY}`,
      );
      const expectedState = isCommittedReceipt ? "committed" : "pending";
      if (receiptState !== expectedState) {
        return result(1, {
          stderr: `Error: stat ${source.slice(source.indexOf(":") + 1)}: no such file or directory`,
        });
      }
      if (!isCommittedReceipt) {
        calls.push("copy");
        receiptPaths.push(String(operation[2]));
      }
    } else if (
      operation[0] === "run" &&
      operation.includes("--shared-state-transaction-status")
    ) {
      return result(0, {
        stdout: operation.some((entry) =>
          entry.includes(`dst=${MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY},readonly`),
        )
          ? "committed\n"
          : "pending\n",
      });
    } else if (operation[0] === "exec") {
      calls.push("commit");
      const mutationResult = mutation(operation, options);
      if (mutationResult.status === 0 || config.commitOnFailure) receiptState = "committed";
      return mutationResult;
    } else if (operation[0] === "run") {
      calls.push("rollback");
      const mutationResult = mutation(operation, options);
      if (mutationResult.status === 0) receiptState = "none";
      return mutationResult;
    } else if (operation[0] === "rm") {
      calls.push("remove");
    } else if (operation[0] === "container" && operation[1] === "exists") {
      calls.push("exists");
    }
    return mutation(operation, options);
  });
  return { calls, receiptPaths, run };
}

describe("Podman managed-startup shared-state finalization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("copies before committing %s through the exact rootless runtime", (agent) => {
    const harness = identityRunner(() => result(0));
    const outcome = finalizePodmanManagedStartupSharedState(
      {
        containerRollbackAuthority: rollbackAuthority(),
        supervisorReady: true,
        transaction: transaction(agent),
      },
      testDeps(harness.run),
    );

    expect(outcome).toEqual({ failure: null, supervisorReady: true });
    expect(harness.calls).toEqual(["copy", "commit"]);
    expect(harness.receiptPaths).toHaveLength(1);
    expect(fs.existsSync(path.dirname(harness.receiptPaths[0] as string))).toBe(false);

    const copyCall = vi.mocked(harness.run).mock.calls.find((call) => call[1].slice(2)[0] === "cp");
    expect(copyCall?.[1].slice(2, 4)).toEqual([
      "cp",
      `${CONTAINER_ID}:${MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY}`,
    ]);
    const commitCall = vi
      .mocked(harness.run)
      .mock.calls.find((call) => call[1].includes("--commit-shared-state-transaction"));
    expect(commitCall?.[1].slice(2)).toEqual(
      expect.arrayContaining([
        "exec",
        CONTAINER_ID,
        "/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs",
        "--commit-shared-state-transaction",
        "--agent",
        agent,
        "--bootstrap-identity",
        BOOTSTRAP_IDENTITY,
      ]),
    );
  });

  it("accepts a lost commit acknowledgement only after immutable durable proof", () => {
    const harness = identityRunner(
      (args) => {
        if (args[0] === "exec") return result(1, { stderr: "ack lost" });
        return result(0);
      },
      { commitOnFailure: true },
    );
    const outcome = finalizePodmanManagedStartupSharedState(
      {
        containerRollbackAuthority: rollbackAuthority(),
        supervisorReady: true,
        transaction: transaction("hermes"),
      },
      testDeps(harness.run),
    );

    expect(outcome).toEqual({ failure: null, supervisorReady: true });
    expect(harness.calls).toEqual(["copy", "commit"]);
    expect(fs.existsSync(path.dirname(harness.receiptPaths[0] as string))).toBe(false);
  });

  it("quiesces before copying and removes an unbacked failed replacement after rollback", () => {
    const harness = identityRunner((args) => {
      if (args[0] === "container" && args[1] === "exists") return result(1);
      return result(0);
    });

    expect(
      finalizePodmanManagedStartupSharedState(
        { supervisorReady: false, transaction: transaction() },
        testDeps(harness.run),
      ),
    ).toEqual({ failure: null, supervisorReady: false });
    expect(harness.calls).toEqual(["stop", "copy", "rollback", "remove", "exists"]);
    expect(fs.existsSync(path.dirname(harness.receiptPaths[0] as string))).toBe(false);
  });

  it("retains the protected receipt when immutable rollback verification fails", () => {
    const harness = identityRunner((args) =>
      args[0] === "run" ? result(1, { stderr: "receipt verification failed" }) : result(0),
    );

    try {
      expect(() =>
        finalizePodmanManagedStartupSharedState(
          {
            containerRollbackAuthority: rollbackAuthority(),
            supervisorReady: false,
            transaction: transaction(),
          },
          testDeps(harness.run),
        ),
      ).toThrow(/Protected receipt retained/u);
      expect(harness.calls).toEqual(["stop", "copy", "rollback"]);
      expect(fs.existsSync(path.dirname(harness.receiptPaths[0] as string))).toBe(true);
    } finally {
      const receiptPath = harness.receiptPaths[0];
      if (receiptPath) {
        fs.rmSync(path.dirname(receiptPath), { force: true, recursive: true });
      }
    }
  });

  it("stops the live workload when receipt preservation fails", () => {
    const harness = identityRunner((args) =>
      args[0] === "cp" ? result(1, { stderr: "copy failed" }) : result(0),
    );

    expect(() =>
      finalizePodmanManagedStartupSharedState(
        {
          containerRollbackAuthority: rollbackAuthority(),
          supervisorReady: true,
          transaction: transaction(),
        },
        testDeps(harness.run),
      ),
    ).toThrow(/Could not copy/u);
    expect(harness.calls).toEqual(["copy", "stop"]);
  });

  it("fails closed before mutation when the rootless runtime fingerprint changed", () => {
    const run = vi.fn((_command, args: readonly string[]) => {
      expect(args.slice(0, 2)).toEqual(["--url", SOCKET_URL]);
      return result(0, {
        stdout: JSON.stringify({
          host: { security: { rootless: true } },
          store: { graphRoot: "/different/storage", runRoot: RUN_ROOT },
        }),
      });
    });

    expect(() =>
      finalizePodmanManagedStartupSharedState(
        {
          containerRollbackAuthority: rollbackAuthority(),
          supervisorReady: true,
          transaction: transaction(),
        },
        testDeps(run),
      ),
    ).toThrow(/runtime identity changed/u);
    expect(run).toHaveBeenCalledOnce();
  });

  it("fails closed before mutation when the exact image identity changed", () => {
    const run = vi.fn((_command, args: readonly string[]) => {
      const operation = args.slice(2);
      if (operation[0] === "info") {
        return result(0, {
          stdout: JSON.stringify({
            host: { security: { rootless: true } },
            store: { graphRoot: GRAPH_ROOT, runRoot: RUN_ROOT },
          }),
        });
      }
      return result(0, {
        stdout: JSON.stringify([
          {
            Id: CONTAINER_ID,
            Image: `sha256:${"d".repeat(64)}`,
            State: { Dead: false, Paused: false, Restarting: false, Running: true },
          },
        ]),
      });
    });

    expect(() =>
      finalizePodmanManagedStartupSharedState(
        {
          containerRollbackAuthority: rollbackAuthority(),
          supervisorReady: true,
          transaction: transaction(),
        },
        testDeps(run),
      ),
    ).toThrow(/image identity changed/u);
    expect(vi.mocked(run).mock.calls.some((call) => call[1].slice(2)[0] === "cp")).toBe(false);
  });

  it.each([
    {
      label: "driver",
      authority: rollbackAuthority({ driverName: "docker" as "podman" }),
    },
    {
      label: "application state",
      authority: rollbackAuthority({ applied: false as true }),
    },
    {
      label: "runtime socket",
      authority: rollbackAuthority({ socketPath: "/run/user/1000/podman/other.sock" }),
    },
    {
      label: "socket identity",
      authority: rollbackAuthority({
        socketAuthority: { ...SOCKET_AUTHORITY, inode: "9002" },
      }),
    },
    {
      label: "replacement container",
      authority: rollbackAuthority({ newContainerId: "d".repeat(64) }),
    },
    {
      label: "immutable image",
      authority: rollbackAuthority({ immutableImage: `sha256:${"e".repeat(64)}` }),
    },
  ])("rejects mismatched $label rollback authority before mutation", ({ authority }) => {
    const run = vi.fn();

    expect(() =>
      finalizePodmanManagedStartupSharedState(
        {
          containerRollbackAuthority: authority,
          supervisorReady: false,
          transaction: transaction(),
        },
        testDeps(run),
      ),
    ).toThrow(/rollback authority does not match/u);
    expect(run).not.toHaveBeenCalled();
  });

  it("is a no-op without a managed-startup transaction", () => {
    const run = vi.fn();
    expect(
      finalizePodmanManagedStartupSharedState(
        { supervisorReady: true, transaction: null },
        testDeps(run),
      ),
    ).toEqual({ failure: null, supervisorReady: true });
    expect(run).not.toHaveBeenCalled();
  });
});

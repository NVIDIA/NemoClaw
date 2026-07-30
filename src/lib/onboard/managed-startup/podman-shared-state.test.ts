// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PodmanManagedStartupTransaction } from "./podman-root-apply";
import type {
  PodmanManagedStartupCommandResult,
  RunManagedStartupPodmanCommand,
} from "./podman-runtime";
import { finalizePodmanManagedStartupSharedState } from "./podman-shared-state";
import {
  MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY,
  MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
} from "./shared-state-transaction";

const SOCKET_PATH = "/run/user/1000/podman/podman.sock";
const SOCKET_URL = `unix://${SOCKET_PATH}`;
const CONTAINER_ID = "b".repeat(64);
const IMAGE_ID = `sha256:${"c".repeat(64)}`;
const GRAPH_ROOT = "/home/test/.local/share/containers/storage";
const RUN_ROOT = "/run/user/1000/containers";

function transaction(
  agent: PodmanManagedStartupTransaction["agent"] = "openclaw",
): PodmanManagedStartupTransaction {
  return {
    agent,
    containerId: CONTAINER_ID,
    image: IMAGE_ID,
    runtime: {
      fingerprint: createHash("sha256").update(`${GRAPH_ROOT}\0${RUN_ROOT}`).digest("hex"),
      socketPath: SOCKET_PATH,
    },
  };
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
): {
  readonly calls: string[];
  readonly receiptPaths: string[];
  readonly run: RunManagedStartupPodmanCommand;
} {
  const calls: string[] = [];
  const receiptPaths: string[] = [];
  let running = true;
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
      calls.push("copy");
      receiptPaths.push(String(operation[2]));
    } else if (operation[0] === "exec") {
      calls.push("commit");
    } else if (operation[0] === "run") {
      calls.push("rollback");
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
        containerRollbackArmed: true,
        supervisorReady: true,
        transaction: transaction(agent),
      },
      { run: harness.run },
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
    expect(commitCall?.[1].slice(2)).toEqual([
      "exec",
      "--user",
      "0:0",
      "--env",
      "NODE_OPTIONS=",
      "--env",
      "NODE_PATH=",
      "--env",
      "BASH_ENV=",
      "--env",
      "ENV=",
      CONTAINER_ID,
      "/usr/bin/env",
      "-i",
      "HOME=/root",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "/usr/local/bin/node",
      "/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs",
      "--commit-shared-state-transaction",
      "--agent",
      agent,
    ]);
  });

  it("uses the preserved receipt after a lost commit acknowledgement", () => {
    const harness = identityRunner((args) => {
      if (args[0] === "exec") return result(1, { stderr: "ack lost" });
      return result(0);
    });
    const outcome = finalizePodmanManagedStartupSharedState(
      {
        containerRollbackArmed: true,
        supervisorReady: true,
        transaction: transaction("hermes"),
      },
      { run: harness.run },
    );

    expect(outcome.supervisorReady).toBe(false);
    expect(outcome.failure?.message).toContain("commit failed");
    expect(harness.calls).toEqual(["copy", "commit", "stop", "rollback"]);
    expect(fs.existsSync(path.dirname(harness.receiptPaths[0] as string))).toBe(false);

    const rollbackCall = vi
      .mocked(harness.run)
      .mock.calls.find((call) => call[1].includes("--rollback-shared-state-transaction"));
    expect(rollbackCall?.[1].slice(2)).toEqual([
      "run",
      "--rm",
      "--pull",
      "never",
      "--network",
      "none",
      "--read-only",
      "--user",
      "0:0",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "DAC_OVERRIDE",
      "--cap-add",
      "FOWNER",
      "--env",
      "NODE_OPTIONS=",
      "--env",
      "NODE_PATH=",
      "--env",
      "BASH_ENV=",
      "--env",
      "ENV=",
      "--volumes-from",
      CONTAINER_ID,
      "--mount",
      expect.stringMatching(
        new RegExp(
          `^type=bind,src=.+,dst=${MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY},readonly$`,
          "u",
        ),
      ),
      "--entrypoint",
      "/usr/local/bin/node",
      IMAGE_ID,
      "/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs",
      "--rollback-shared-state-transaction",
      "--agent",
      "hermes",
      "--read-only-receipt",
    ]);
  });

  it("quiesces before copying and removes an unbacked failed replacement after rollback", () => {
    const harness = identityRunner((args) => {
      if (args[0] === "container" && args[1] === "exists") return result(1);
      return result(0);
    });

    expect(
      finalizePodmanManagedStartupSharedState(
        { supervisorReady: false, transaction: transaction() },
        { run: harness.run },
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
            containerRollbackArmed: true,
            supervisorReady: false,
            transaction: transaction(),
          },
          { run: harness.run },
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
          containerRollbackArmed: true,
          supervisorReady: true,
          transaction: transaction(),
        },
        { run: harness.run },
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
          containerRollbackArmed: true,
          supervisorReady: true,
          transaction: transaction(),
        },
        { run },
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
          containerRollbackArmed: true,
          supervisorReady: true,
          transaction: transaction(),
        },
        { run },
      ),
    ).toThrow(/image identity changed/u);
    expect(vi.mocked(run).mock.calls.some((call) => call[1].slice(2)[0] === "cp")).toBe(false);
  });

  it("is a no-op without a managed-startup transaction", () => {
    const run = vi.fn();
    expect(
      finalizePodmanManagedStartupSharedState(
        { supervisorReady: true, transaction: null },
        { run },
      ),
    ).toEqual({ failure: null, supervisorReady: true });
    expect(run).not.toHaveBeenCalled();
  });
});

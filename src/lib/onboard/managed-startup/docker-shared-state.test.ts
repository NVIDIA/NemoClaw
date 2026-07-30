// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DockerGpuPatchResult } from "../docker-gpu-patch-types";
import type { DockerManagedStartupTransaction } from "./docker-root-apply";
import { finalizeDockerManagedStartupSharedState } from "./docker-shared-state";
import { MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY } from "./shared-state-transaction";

const IMMUTABLE_IMAGE = `sha256:${"a".repeat(64)}`;

function result(): DockerGpuPatchResult {
  return {
    applied: true,
    oldContainerId: "old",
    newContainerId: "new",
    originalName: "openshell-alpha",
    backupContainerName: "openshell-alpha-backup",
    mode: {
      kind: "startup-command",
      label: "restart-safe startup command",
      device: "",
      args: [],
    },
    backupRemoved: false,
  };
}

function transaction(): DockerManagedStartupTransaction {
  return {
    agent: "openclaw",
    containerId: "new",
    image: IMMUTABLE_IMAGE,
  };
}

function removeReceiptParents(...receiptPaths: readonly string[]): void {
  for (const receiptPath of receiptPaths.filter((candidate) => candidate.length > 0)) {
    fs.rmSync(path.dirname(receiptPath), { force: true, recursive: true });
  }
}

describe("Docker managed-startup shared-state finalization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("copies the bounded receipt before commit and removes the host copy on success", () => {
    const calls: string[] = [];
    let receiptPath = "";
    const dockerRun = vi
      .fn()
      .mockImplementationOnce((args: readonly string[]) => {
        calls.push("copy");
        receiptPath = String(args[2]);
        expect(args[1]).toBe(`new:${MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY}`);
        return { status: 0 };
      })
      .mockImplementationOnce((args: readonly string[]) => {
        calls.push("commit");
        expect(args).toEqual([
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
          "new",
          "/usr/bin/env",
          "-i",
          "HOME=/root",
          "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          "/usr/local/bin/node",
          "/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs",
          "--commit-shared-state-transaction",
          "--agent",
          "openclaw",
        ]);
        return { status: 0 };
      });
    const dockerStop = vi.fn();

    expect(
      finalizeDockerManagedStartupSharedState(
        { transaction: transaction(), patchResult: result(), supervisorReady: true },
        { dockerRun, dockerStop },
      ),
    ).toEqual({ supervisorReady: true, failure: null });
    expect(calls).toEqual(["copy", "commit"]);
    expect(dockerStop).not.toHaveBeenCalled();
    expect(fs.existsSync(path.dirname(receiptPath))).toBe(false);
  });

  it("uses the preserved pre-commit receipt after a lost commit acknowledgement", () => {
    const calls: string[] = [];
    let receiptPath = "";
    const dockerRun = vi
      .fn()
      .mockImplementationOnce((args: readonly string[]) => {
        calls.push("copy");
        receiptPath = String(args[2]);
        return { status: 0 };
      })
      .mockImplementationOnce(() => {
        calls.push("commit-lost-ack");
        return { status: 1, stderr: "daemon acknowledgement lost" };
      })
      .mockImplementationOnce((args: readonly string[]) => {
        calls.push("rollback-helper");
        expect(args).toEqual([
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
          "new",
          "--mount",
          expect.stringMatching(
            /^type=bind,src=.+,dst=\/run\/nemoclaw\/managed-startup-shared-rollback-receipt-v1,readonly$/u,
          ),
          "--entrypoint",
          "/usr/local/bin/node",
          IMMUTABLE_IMAGE,
          "/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs",
          "--rollback-shared-state-transaction",
          "--agent",
          "openclaw",
          "--read-only-receipt",
        ]);
        return { status: 0 };
      });
    const dockerStop = vi.fn(() => {
      calls.push("stop");
      return { status: 0 };
    });

    const outcome = finalizeDockerManagedStartupSharedState(
      { transaction: transaction(), patchResult: result(), supervisorReady: true },
      { dockerRun, dockerStop },
    );
    expect(outcome.supervisorReady).toBe(false);
    expect(outcome.failure?.message).toContain("commit failed");
    expect(calls).toEqual(["copy", "commit-lost-ack", "stop", "rollback-helper"]);
    expect(fs.existsSync(path.dirname(receiptPath))).toBe(false);
  });

  it("uses unique receipt paths and treats already-completed cleanup idempotently", () => {
    const receiptPaths: string[] = [];
    const copyReceipt = (args: readonly string[]) => {
      expect(args[0]).toBe("cp");
      const receiptPath = String(args[2]);
      receiptPaths.push(receiptPath);
      return { status: 0 };
    };
    const completeCommit = (args: readonly string[]) => {
      expect(args[0]).toBe("exec");
      removeReceiptParents(receiptPaths.at(-1)!);
      return { status: 0 };
    };
    const dockerRun = vi
      .fn()
      .mockImplementationOnce(copyReceipt)
      .mockImplementationOnce(completeCommit)
      .mockImplementationOnce(copyReceipt)
      .mockImplementationOnce(completeCommit);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        finalizeDockerManagedStartupSharedState(
          { transaction: transaction(), patchResult: result(), supervisorReady: true },
          { dockerRun },
        ),
      ).toEqual({ supervisorReady: true, failure: null });
    }
    expect(new Set(receiptPaths).size).toBe(2);
    expect(receiptPaths.every((receiptPath) => !fs.existsSync(path.dirname(receiptPath)))).toBe(
      true,
    );
  });

  it("quiesces a failed supervisor before copying and replaying the receipt", () => {
    const calls: string[] = [];
    const dockerStop = vi.fn(() => {
      calls.push("stop");
      return { status: 0 };
    });
    const dockerRun = vi.fn((args: readonly string[]) => {
      calls.push(args[0] === "cp" ? "copy" : "rollback-helper");
      return { status: 0 };
    });

    expect(
      finalizeDockerManagedStartupSharedState(
        { transaction: transaction(), patchResult: result(), supervisorReady: false },
        { dockerRun, dockerStop },
      ),
    ).toEqual({ supervisorReady: false, failure: null });
    expect(calls).toEqual(["stop", "copy", "rollback-helper"]);
  });

  it("stops a live workload when pre-commit receipt preservation fails", () => {
    const dockerRun = vi.fn(() => ({ status: 1, stderr: "copy failed" }));
    const dockerStop = vi.fn(() => ({ status: 0 }));

    expect(() =>
      finalizeDockerManagedStartupSharedState(
        { transaction: transaction(), patchResult: result(), supervisorReady: true },
        { dockerRun, dockerStop },
      ),
    ).toThrow(/Could not copy/u);
    expect(dockerStop).toHaveBeenCalledOnce();
    expect(dockerRun).toHaveBeenCalledOnce();
  });

  it("fails before container rollback when the immutable helper cannot verify restoration", () => {
    const dockerStop = vi.fn(() => ({ status: 0 }));
    let receiptPath = "";
    const dockerRun = vi
      .fn()
      .mockImplementationOnce((args: readonly string[]) => {
        receiptPath = String(args[2]);
        return { status: 0 };
      })
      .mockImplementationOnce(() => ({
        status: 1,
        stderr: "receipt verification failed",
      }));

    try {
      expect(() =>
        finalizeDockerManagedStartupSharedState(
          { transaction: transaction(), patchResult: result(), supervisorReady: false },
          { dockerRun, dockerStop },
        ),
      ).toThrow(/could not restore and verify/u);
      expect(dockerStop).toHaveBeenCalledOnce();
      expect(fs.existsSync(path.dirname(receiptPath))).toBe(true);
    } finally {
      removeReceiptParents(receiptPath);
    }
  });

  it("is a no-op for non-managed container patches", () => {
    const dockerRun = vi.fn();
    const dockerStop = vi.fn();
    expect(
      finalizeDockerManagedStartupSharedState(
        { transaction: null, patchResult: result(), supervisorReady: true },
        { dockerRun, dockerStop },
      ),
    ).toEqual({ supervisorReady: true, failure: null });
    expect(dockerRun).not.toHaveBeenCalled();
    expect(dockerStop).not.toHaveBeenCalled();
  });
});

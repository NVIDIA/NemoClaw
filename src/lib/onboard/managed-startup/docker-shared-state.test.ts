// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DockerGpuPatchResult } from "../docker-gpu-patch-types";
import type { DockerManagedStartupTransaction } from "./docker-root-apply";
import {
  clearDockerManagedStartupSharedStateCommitReceipt,
  DockerManagedStartupSharedStateCommitIndeterminateError,
  finalizeDockerManagedStartupSharedState,
  probeDockerManagedStartupSharedState,
} from "./docker-shared-state";
import {
  MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY,
  MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
} from "./shared-state-transaction";

const IMMUTABLE_IMAGE = `sha256:${"a".repeat(64)}`;
const BOOTSTRAP_IDENTITY = "b".repeat(64);

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
    bootstrapIdentity: BOOTSTRAP_IDENTITY,
    profileFingerprint: "c".repeat(64),
  };
}

function removeReceiptParents(...receiptPaths: readonly string[]): void {
  for (const receiptPath of receiptPaths.filter((candidate) => candidate.length > 0)) {
    fs.rmSync(path.dirname(receiptPath), { force: true, recursive: true });
  }
}

function exactMissingReceipt(sourcePath: string) {
  return {
    status: 1,
    stderr: `Error response from daemon: Could not find the file ${sourcePath} in container new`,
  };
}

function fakeSharedStateDocker(
  initialStatus: "committed" | "none" | "pending",
  options: {
    readonly clearLostAcknowledgement?: boolean;
    readonly commitLostAcknowledgement?: boolean;
    readonly commitWithoutDurableState?: boolean;
    readonly failCommittedProbe?: boolean;
  } = {},
) {
  let status = initialStatus;
  const receiptPaths: string[] = [];
  const events: string[] = [];
  const dockerRun = vi.fn((args: readonly string[]) => {
    if (args[0] === "cp") {
      const source = String(args[2] ?? "");
      const destination = String(args[3] ?? "");
      if (source.endsWith(`:${MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY}`)) {
        events.push("copy-commit");
        if (status !== "committed") {
          return exactMissingReceipt(MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY);
        }
        receiptPaths.push(destination);
        return { status: 0 };
      }
      if (source.endsWith(`:${MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY}`)) {
        events.push("copy-pending");
        if (status !== "pending") {
          return exactMissingReceipt(MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY);
        }
        receiptPaths.push(destination);
        return { status: 0 };
      }
    }
    if (args[0] === "run" && args.includes("--shared-state-transaction-status")) {
      events.push(`probe-${status}`);
      if (status === "committed" && options.failCommittedProbe) {
        return { status: 1, stderr: "injected immutable committed-status probe failure" };
      }
      return { status: 0, stdout: `${status}\n` };
    }
    if (args[0] === "exec" && args.includes("--commit-shared-state-transaction")) {
      events.push("commit");
      if (!options.commitWithoutDurableState) status = "committed";
      return options.commitLostAcknowledgement
        ? { status: 1, stderr: "daemon acknowledgement lost" }
        : { status: 0 };
    }
    if (args[0] === "exec" && args.includes("--clear-shared-state-commit-receipt")) {
      events.push("clear");
      status = "none";
      return options.clearLostAcknowledgement
        ? { status: 1, stderr: "daemon acknowledgement lost" }
        : { status: 0 };
    }
    if (args[0] === "run" && args.includes("--rollback-shared-state-transaction")) {
      events.push("rollback");
      status = "none";
      return { status: 0 };
    }
    throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
  });
  return {
    dockerRun,
    events,
    receiptPaths,
    get status() {
      return status;
    },
  };
}

describe("Docker managed-startup shared-state finalization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probes pending state through an explicit copied receipt without writable-layer access", () => {
    const fake = fakeSharedStateDocker("pending");

    expect(
      probeDockerManagedStartupSharedState(
        {
          transaction: transaction(),
          profileFingerprint: "c".repeat(64),
        },
        { dockerRun: fake.dockerRun },
      ),
    ).toBe("pending");
    expect(fake.events).toEqual(["copy-commit", "copy-pending", "probe-pending"]);
    const probe = fake.dockerRun.mock.calls.find(
      ([args]) => args[0] === "run" && args.includes("--shared-state-transaction-status"),
    )?.[0];
    expect(probe).not.toContain("--volumes-from");
    expect(probe).toEqual(
      expect.arrayContaining([
        "--mount",
        expect.stringMatching(
          /^type=bind,src=.+\/managed-startup-shared-state-transaction-v1,dst=\/var\/lib\/nemoclaw\/managed-startup-shared-state-transaction-v1,readonly$/u,
        ),
        "--profile-fingerprint",
        "c".repeat(64),
        "--bootstrap-identity",
        BOOTSTRAP_IDENTITY,
      ]),
    );
    expect(
      fake.receiptPaths.every((receiptPath) => !fs.existsSync(path.dirname(receiptPath))),
    ).toBe(true);
  });

  it("probes committed state only through the exact immutable image-owned receipt", () => {
    const fake = fakeSharedStateDocker("committed");

    expect(
      probeDockerManagedStartupSharedState(
        {
          transaction: transaction(),
          profileFingerprint: "c".repeat(64),
        },
        { dockerRun: fake.dockerRun },
      ),
    ).toBe("committed");
    expect(fake.events).toEqual(["copy-commit", "probe-committed"]);
    const probe = fake.dockerRun.mock.calls.find(
      ([args]) => args[0] === "run" && args.includes("--shared-state-transaction-status"),
    )?.[0];
    expect(probe).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--mount",
        expect.stringMatching(
          /^type=bind,src=.+\/managed-startup-shared-state-commit-v1,dst=\/var\/lib\/nemoclaw\/managed-startup-shared-state-commit-v1,readonly$/u,
        ),
        IMMUTABLE_IMAGE,
        "--agent",
        "openclaw",
        "--profile-fingerprint",
        "c".repeat(64),
        "--bootstrap-identity",
        BOOTSTRAP_IDENTITY,
      ]),
    );
    expect(
      fake.receiptPaths.every((receiptPath) => !fs.existsSync(path.dirname(receiptPath))),
    ).toBe(true);
  });

  it("copies the bounded receipt before commit and removes the host copy on success", () => {
    const fake = fakeSharedStateDocker("pending");
    const dockerStop = vi.fn();

    expect(
      finalizeDockerManagedStartupSharedState(
        { transaction: transaction(), patchResult: result(), supervisorReady: true },
        { dockerRun: fake.dockerRun, dockerStop },
      ),
    ).toEqual({ supervisorReady: true, failure: null });
    expect(fake.events).toEqual([
      "copy-pending",
      "probe-pending",
      "commit",
      "copy-commit",
      "probe-committed",
    ]);
    expect(dockerStop).not.toHaveBeenCalled();
    expect(
      fake.receiptPaths.every((receiptPath) => !fs.existsSync(path.dirname(receiptPath))),
    ).toBe(true);
  });

  it("accepts a lost commit acknowledgement only after immutable committed proof", () => {
    const fake = fakeSharedStateDocker("pending", {
      commitLostAcknowledgement: true,
    });
    const dockerStop = vi.fn();

    const outcome = finalizeDockerManagedStartupSharedState(
      { transaction: transaction(), patchResult: result(), supervisorReady: true },
      { dockerRun: fake.dockerRun, dockerStop },
    );
    expect(outcome).toEqual({ supervisorReady: true, failure: null });
    expect(fake.status).toBe("committed");
    expect(fake.events).toEqual([
      "copy-pending",
      "probe-pending",
      "commit",
      "copy-commit",
      "probe-committed",
    ]);
    expect(dockerStop).not.toHaveBeenCalled();
  });

  it("forbids rollback when commit succeeds but immutable committed proof is unavailable", () => {
    const fake = fakeSharedStateDocker("pending", {
      failCommittedProbe: true,
    });
    const dockerStop = vi.fn(() => ({ status: 0 }));

    try {
      expect(() =>
        finalizeDockerManagedStartupSharedState(
          { transaction: transaction(), patchResult: result(), supervisorReady: true },
          { dockerRun: fake.dockerRun, dockerStop },
        ),
      ).toThrow(DockerManagedStartupSharedStateCommitIndeterminateError);
      expect(fake.status).toBe("committed");
      expect(fake.events).toEqual([
        "copy-pending",
        "probe-pending",
        "commit",
        "copy-commit",
        "probe-committed",
      ]);
      expect(fake.events).not.toContain("rollback");
      expect(dockerStop).not.toHaveBeenCalled();
    } finally {
      removeReceiptParents(...fake.receiptPaths);
    }
  });

  it("uses the preserved pre-commit receipt when a lost acknowledgement has no durable proof", () => {
    const fake = fakeSharedStateDocker("pending", {
      commitLostAcknowledgement: true,
      commitWithoutDurableState: true,
    });
    const dockerStop = vi.fn(() => ({ status: 0 }));

    const outcome = finalizeDockerManagedStartupSharedState(
      { transaction: transaction(), patchResult: result(), supervisorReady: true },
      { dockerRun: fake.dockerRun, dockerStop },
    );
    expect(outcome.supervisorReady).toBe(false);
    expect(outcome.failure?.message).toContain("logical commit validation failed");
    expect(fake.events).toEqual([
      "copy-pending",
      "probe-pending",
      "commit",
      "copy-commit",
      "copy-pending",
      "probe-pending",
      "rollback",
    ]);
    expect(dockerStop).toHaveBeenCalledOnce();
    expect(fake.status).toBe("none");
  });

  it("retires the durable receipt after exact backup cleanup and accepts only proven lost clear acknowledgement", () => {
    const fake = fakeSharedStateDocker("committed", {
      clearLostAcknowledgement: true,
    });

    expect(() =>
      clearDockerManagedStartupSharedStateCommitReceipt(transaction(), {
        dockerRun: fake.dockerRun,
      }),
    ).not.toThrow();
    expect(fake.events).toEqual(["clear", "copy-commit", "copy-pending"]);
    expect(fake.status).toBe("none");
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

  it("accepts only exact post-quiesce ENOENT as proof no transaction began", () => {
    const calls: string[] = [];
    const dockerStop = vi.fn(() => {
      calls.push("stop");
      return { status: 0 };
    });
    const dockerRun = vi.fn((args: readonly string[]) => {
      calls.push("copy-absent");
      return {
        status: 1,
        stderr: `Error response from daemon: Could not find the file ${MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY} in container new`,
      };
    });

    expect(
      finalizeDockerManagedStartupSharedState(
        { transaction: transaction(), patchResult: result(), supervisorReady: false },
        { dockerRun, dockerStop },
      ),
    ).toEqual({ supervisorReady: false, failure: null });
    expect(calls).toEqual(["stop", "copy-absent"]);
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
        receiptPath = String(args[3]);
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

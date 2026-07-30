// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import {
  MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY,
  MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
} from "../shared-state-transaction";

export type FakeSharedStateDockerOptions = {
  readonly clearLostAcknowledgement?: boolean;
  readonly commitLostAcknowledgement?: boolean;
  readonly commitWithoutDurableState?: boolean;
  readonly failCommittedProbe?: boolean;
};

function exactMissingReceipt(sourcePath: string, containerId: string) {
  return {
    status: 1,
    stderr: `Error response from daemon: Could not find the file ${sourcePath} in container ${containerId}`,
  };
}

export function createFakeSharedStateDocker(
  containerId: string,
  initialStatus: "committed" | "none" | "pending",
  options: FakeSharedStateDockerOptions = {},
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
          return exactMissingReceipt(MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY, containerId);
        }
        receiptPaths.push(destination);
        return { status: 0 };
      }
      if (source.endsWith(`:${MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY}`)) {
        events.push("copy-pending");
        if (status !== "pending") {
          return exactMissingReceipt(MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY, containerId);
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

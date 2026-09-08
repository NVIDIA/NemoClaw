// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DockerGpuPatchDeps } from "../docker-gpu-patch-types";
import {
  MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY,
  MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY,
  MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
} from "../managed-startup/shared-state-transaction";
import {
  type DockerManagedBootstrapSharedStateTransaction,
  finalizeDockerManagedStartupSharedState,
} from "./docker-shared-state";

const CONTAINER_ID = "c".repeat(64);
const TRANSACTION: DockerManagedBootstrapSharedStateTransaction = {
  agent: "openclaw",
  bootstrapIdentity: "b".repeat(64),
  containerId: CONTAINER_ID,
  image: `sha256:${"a".repeat(64)}`,
  profileFingerprint: "d".repeat(64),
};

interface SharedStateFixture {
  readonly commands: readonly (readonly string[])[];
  readonly deps: DockerGpuPatchDeps;
  readonly events: readonly string[];
  readonly state: () => "committed" | "none" | "pending";
}

interface SharedStateFixtureOptions {
  readonly daemonTransferStatus?: number;
  readonly stateAfterCommitFailure?: "committed" | "none" | "pending";
  readonly stateAfterStop?: "committed" | "none" | "pending";
}

const copiedReceiptPaths: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const receiptPath of copiedReceiptPaths.splice(0)) {
    fs.rmSync(path.dirname(receiptPath), { force: true, recursive: true });
  }
});

function fixture(
  initialState: "committed" | "none" | "pending",
  options: SharedStateFixtureOptions = {},
): SharedStateFixture {
  let state = initialState;
  const commands: string[][] = [];
  const events: string[] = [];
  const copyPresentReceipt = (destination: string) => {
    fs.mkdirSync(destination, { recursive: true });
    copiedReceiptPaths.push(destination);
    return { status: 0 };
  };
  const copyMissingReceipt = (sourcePath: string) => ({
    status: 1,
    stderr: `Error response from daemon: Could not find the file ${sourcePath} in container ${CONTAINER_ID}`,
  });
  const dockerRun = vi.fn((args: readonly string[]) => {
    commands.push([...args]);
    switch (args[0]) {
      case "volume":
      case "create":
      case "rm":
        return { status: 0 };
      case "cp": {
        const daemonTransfer =
          args[1] === "-a" && String(args[3]).includes("nemoclaw-managed-startup-receipt-seed");
        switch (daemonTransfer) {
          case true:
            return {
              status: options.daemonTransferStatus ?? 0,
              stderr: options.daemonTransferStatus ? "daemon transfer failed" : "",
            };
          default: {
            const source = String(args[2] ?? "");
            const destination = String(args[3] ?? "");
            const sourcePath = source.slice(`${CONTAINER_ID}:`.length);
            const present =
              (sourcePath === MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY &&
                state === "committed") ||
              (sourcePath === MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY && state === "pending");
            events.push(`copy:${path.basename(sourcePath)}:${present ? "present" : "absent"}`);
            return present ? copyPresentReceipt(destination) : copyMissingReceipt(sourcePath);
          }
        }
      }
      case "run": {
        const action = args.includes("--shared-state-transaction-status")
          ? "status"
          : args.includes("--rollback-shared-state-transaction")
            ? "rollback"
            : "unexpected";
        switch (action) {
          case "status":
            events.push(`status:${state}`);
            return { status: 0, stdout: `${state}\n` };
          case "rollback":
            events.push("rollback");
            state = "none";
            return { status: 0 };
          default:
            throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
        }
      }
      case "exec":
        switch (args.includes("--commit-shared-state-transaction")) {
          case true:
            events.push("commit:failed");
            state = options.stateAfterCommitFailure ?? state;
            return { status: 1, stderr: "commit helper failed" };
          default:
            throw new Error("Unexpected Docker commit command");
        }
      default:
        throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
    }
  });
  return {
    commands,
    deps: {
      dockerRm: vi.fn(() => ({ status: 0 })),
      dockerRun,
      dockerStop: vi.fn(() => {
        events.push("stop");
        state = options.stateAfterStop ?? state;
        return { status: 0 };
      }),
    },
    events,
    state: () => state,
  };
}

describe("Docker managed-bootstrap shared-state rollback authority", () => {
  it("copies and verifies writable-layer commit authority before rollback", () => {
    const fake = fixture("committed");

    expect(() =>
      finalizeDockerManagedStartupSharedState(
        { transaction: TRANSACTION, supervisorReady: false },
        fake.deps,
      ),
    ).toThrow(/durably committed and cannot be rolled back/u);

    expect(fake.events).toEqual([
      "stop",
      `copy:${path.basename(MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY)}:present`,
      "status:committed",
    ]);
    const statusCommand = fake.commands.find((args) =>
      args.includes("--shared-state-transaction-status"),
    );
    expect(statusCommand).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^type=volume,src=nemoclaw-managed-startup-receipt-volume-[a-f0-9]+,dst=${path.posix.dirname(MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY)},readonly$`,
          "u",
        ),
      ),
    );
    expect(fake.commands.some((args) => args.includes("--rollback-shared-state-transaction"))).toBe(
      false,
    );
  });

  it("proves pending authority after quiescence before starting the rollback helper", () => {
    const fake = fixture("pending");

    expect(
      finalizeDockerManagedStartupSharedState(
        { transaction: TRANSACTION, supervisorReady: false },
        fake.deps,
      ),
    ).toEqual({ supervisorReady: false, failure: null });

    expect(fake.events[0]).toBe("stop");
    expect(fake.events.indexOf("status:pending")).toBeLessThan(fake.events.indexOf("rollback"));
    expect(fake.state()).toBe("none");
    const rollbackCommand = fake.commands.find((args) =>
      args.includes("--rollback-shared-state-transaction"),
    );
    expect(rollbackCommand).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^type=volume,src=nemoclaw-managed-startup-receipt-volume-[a-f0-9]+,dst=${path.posix.dirname(MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY)},readonly$`,
          "u",
        ),
      ),
    );
    expect(fake.deps.dockerRm).not.toHaveBeenCalled();
    expect(fake.commands.flat().some((value) => value.includes("type=bind"))).toBe(false);
  });

  it("retains host authority and cleans daemon staging when receipt transfer fails", () => {
    const fake = fixture("pending", { daemonTransferStatus: 1 });

    expect(() =>
      finalizeDockerManagedStartupSharedState(
        { transaction: TRANSACTION, supervisorReady: false },
        fake.deps,
      ),
    ).toThrow(/Could not transfer managed-startup receipt to Docker/u);

    const hostCopy = fake.commands.find(
      (args) =>
        args[0] === "cp" &&
        String(args[2]).startsWith(`${CONTAINER_ID}:`) &&
        String(args[2]).endsWith(MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY),
    );
    expect(fs.existsSync(String(hostCopy?.[3] ?? ""))).toBe(true);
    expect(fake.commands.some((args) => args[0] === "rm" && args[1] === "-f")).toBe(true);
    expect(fake.commands.some((args) => args[0] === "volume" && args[1] === "rm")).toBe(true);
    expect(fake.deps.dockerRm).not.toHaveBeenCalled();
  });

  it("removes the exact failed container without rollback when both receipts are absent", () => {
    const fake = fixture("none");

    expect(
      finalizeDockerManagedStartupSharedState(
        { transaction: TRANSACTION, supervisorReady: false },
        fake.deps,
      ),
    ).toEqual({ supervisorReady: false, failure: null });

    expect(fake.events).toEqual([
      "stop",
      `copy:${path.basename(MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY)}:absent`,
      `copy:${path.basename(MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY)}:absent`,
    ]);
    expect(fake.commands.some((args) => args.includes("--rollback-shared-state-transaction"))).toBe(
      false,
    );
    expect(fake.deps.dockerRm).toHaveBeenCalledTimes(1);
    expect(fake.deps.dockerRm).toHaveBeenCalledWith(CONTAINER_ID, expect.any(Object));
    expect(fake.state()).toBe("none");
  });

  it("reuses one preserved pending receipt when commit validation fails", () => {
    const fake = fixture("pending", { stateAfterCommitFailure: "none" });

    const outcome = finalizeDockerManagedStartupSharedState(
      {
        transaction: TRANSACTION,
        supervisorReady: true,
      },
      fake.deps,
    );

    expect(outcome.supervisorReady).toBe(false);
    expect(outcome.failure).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("commit helper failed"),
      }),
    );
    expect(
      fake.events.filter(
        (event) =>
          event ===
          "copy:" + path.basename(MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY) + ":present",
      ),
    ).toHaveLength(1);
    const volumeCreates = fake.commands.filter(
      (args) => args[0] === "volume" && args[1] === "create",
    );
    const rollbackCommand = fake.commands.find((args) =>
      args.includes("--rollback-shared-state-transaction"),
    );
    const rollbackMount = String(rollbackCommand?.[rollbackCommand.indexOf("--mount") + 1] ?? "");
    expect(volumeCreates).toHaveLength(1);
    expect(rollbackMount).toMatch(
      new RegExp(
        `^type=volume,src=${String(volumeCreates[0]?.[2])},dst=${path.posix.dirname(MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY)},readonly$`,
        "u",
      ),
    );
    expect(fake.deps.dockerRm).not.toHaveBeenCalled();
  });

  it("rejects rollback when a failed commit becomes durable during quiescence", () => {
    const fake = fixture("pending", {
      stateAfterCommitFailure: "none",
      stateAfterStop: "committed",
    });

    expect(() =>
      finalizeDockerManagedStartupSharedState(
        { transaction: TRANSACTION, supervisorReady: true },
        fake.deps,
      ),
    ).toThrow(/durably committed and cannot be rolled back/u);

    expect(
      fake.events.filter(
        (event) =>
          event ===
          "copy:" + path.basename(MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY) + ":present",
      ),
    ).toHaveLength(1);
    expect(fake.events).toContain("commit:failed");
    expect(fake.events).toContain("status:committed");
    expect(fake.events).not.toContain("rollback");
    expect(fake.commands.some((args) => args.includes("--rollback-shared-state-transaction"))).toBe(
      false,
    );
    expect(fake.deps.dockerRm).not.toHaveBeenCalled();
  });
});

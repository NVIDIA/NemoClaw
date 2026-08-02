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

const copiedReceiptPaths: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const receiptPath of copiedReceiptPaths.splice(0)) {
    fs.rmSync(path.dirname(receiptPath), { force: true, recursive: true });
  }
});

function fixture(initialState: "committed" | "none" | "pending"): SharedStateFixture {
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
      case "cp": {
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
          `^type=bind,src=.+,dst=${MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY},readonly$`,
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
          `^type=bind,src=.+,dst=${MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY},readonly$`,
          "u",
        ),
      ),
    );
  });
});

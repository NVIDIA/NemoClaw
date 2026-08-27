// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DockerGpuPatchResult } from "../docker-gpu-patch-types";
import type { DockerManagedStartupTransaction } from "./docker-root-apply";
import { finalizeDockerManagedStartupSharedState } from "./docker-shared-state";
import { MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY } from "./shared-state-transaction";

const IMMUTABLE_IMAGE = `sha256:${"a".repeat(64)}`;
const receiptParents: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  receiptParents
    .splice(0)
    .forEach((receiptPath) =>
      fs.rmSync(path.dirname(receiptPath), { force: true, recursive: true }),
    );
});

function transaction(): DockerManagedStartupTransaction {
  return { agent: "openclaw", containerId: "new", image: IMMUTABLE_IMAGE };
}

function patchResult(): DockerGpuPatchResult {
  return {
    applied: true,
    oldContainerId: "old",
    newContainerId: "new",
    originalName: "openshell-alpha",
    backupContainerName: "openshell-alpha-backup",
    mode: { kind: "startup-command", label: "restart-safe startup command", device: "", args: [] },
    backupRemoved: false,
  };
}

function dockerWithReceipt(options: { commitStatus?: number; helperStatus?: number } = {}) {
  const calls: string[][] = [];
  const dockerRun = vi.fn((args: readonly string[]) => {
    calls.push([...args]);
    switch (true) {
      case args[0] === "cp" && String(args[2]).startsWith("new:"):
        receiptParents.push(String(args[3]));
        return { status: 0 };
      case args[0] === "exec":
        return { status: options.commitStatus ?? 0 };
      case args[0] === "run" && args.includes("--rollback-shared-state-transaction"):
        return { status: options.helperStatus ?? 0 };
      default:
        return { status: 0 };
    }
  });
  return { calls, dockerRun };
}

describe("Docker managed-startup shared-state finalization", () => {
  it("stages the protected receipt in a daemon volume and removes it after commit", () => {
    const fake = dockerWithReceipt();

    expect(
      finalizeDockerManagedStartupSharedState(
        { transaction: transaction(), patchResult: patchResult(), supervisorReady: true },
        { dockerRun: fake.dockerRun },
      ),
    ).toEqual({ supervisorReady: true, failure: null });

    const volume = fake.calls.find((args) => args[0] === "volume" && args[1] === "create");
    const seed = fake.calls.find((args) => args[0] === "create");
    const transfer = fake.calls.find(
      (args) => args[0] === "cp" && args[1] === "-a" && !String(args[2]).startsWith("new:"),
    );
    const cleanup = fake.calls.filter((args) => args[0] === "volume" && args[1] === "rm");
    expect(volume).toBeDefined();
    expect(seed).toEqual(
      expect.arrayContaining(["--network", "none", "--read-only", "--cap-drop", "ALL"]),
    );
    expect(
      fake.calls.find((args) => args[0] === "cp" && String(args[2]).startsWith("new:")),
    ).toEqual(expect.arrayContaining(["-a"]));
    expect(transfer).toEqual(expect.arrayContaining(["-a"]));
    expect(cleanup).toHaveLength(1);
    expect(fake.calls.some((args) => args.join(",").includes("type=bind"))).toBe(false);
  });

  it("mounts the daemon receipt readonly for rollback after a lost commit acknowledgement", () => {
    const fake = dockerWithReceipt({ commitStatus: 1 });
    const dockerStop = vi.fn(() => ({ status: 0 }));

    const outcome = finalizeDockerManagedStartupSharedState(
      { transaction: transaction(), patchResult: patchResult(), supervisorReady: true },
      { dockerRun: fake.dockerRun, dockerStop },
    );

    expect(outcome.supervisorReady).toBe(false);
    const helper = fake.calls.find((args) => args.includes("--rollback-shared-state-transaction"));
    expect(helper).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--read-only",
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
        "--mount",
        expect.stringMatching(
          new RegExp(
            `^type=volume,src=.+,dst=${path.posix.dirname(MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY)},readonly$`,
            "u",
          ),
        ),
      ]),
    );
    expect(dockerStop).toHaveBeenCalledOnce();
  });

  it("retains host and daemon receipts when immutable rollback verification fails", () => {
    const fake = dockerWithReceipt({ helperStatus: 1 });
    const dockerStop = vi.fn(() => ({ status: 0 }));

    expect(() =>
      finalizeDockerManagedStartupSharedState(
        { transaction: transaction(), patchResult: patchResult(), supervisorReady: false },
        { dockerRun: fake.dockerRun, dockerStop },
      ),
    ).toThrow(/Protected receipt retained at .*daemon volume/u);
    expect(fake.calls.some((args) => args[0] === "volume" && args[1] === "rm")).toBe(false);
    expect(fake.calls.flat().some((value) => value.includes("type=bind"))).toBe(false);
  });

  it("removes the incomplete seed and volume but retains the host receipt when daemon staging fails", () => {
    const fake = dockerWithReceipt();
    fake.dockerRun.mockImplementation((args: readonly string[]) => {
      fake.calls.push([...args]);
      const hostCopy = args[0] === "cp" && String(args[2]).startsWith("new:");
      hostCopy ? receiptParents.push(String(args[3])) : undefined;
      return args[0] === "cp" && !hostCopy
        ? { status: 1, stderr: "daemon copy failed" }
        : { status: 0 };
    });
    const dockerStop = vi.fn(() => ({ status: 0 }));

    expect(() =>
      finalizeDockerManagedStartupSharedState(
        { transaction: transaction(), patchResult: patchResult(), supervisorReady: true },
        { dockerRun: fake.dockerRun, dockerStop },
      ),
    ).toThrow(/Could not transfer managed-startup receipt to Docker/u);
    expect(fake.calls.some((args) => args[0] === "rm" && args[1] === "-f")).toBe(true);
    expect(fake.calls.some((args) => args[0] === "volume" && args[1] === "rm")).toBe(true);
    expect(dockerStop).toHaveBeenCalledOnce();
  });
});

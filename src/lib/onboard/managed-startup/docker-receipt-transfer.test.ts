// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupDockerDaemonReceiptBestEffort,
  dockerDaemonReceiptMount,
  transferDockerReceiptToDaemon,
} from "./docker-receipt-transfer";

const IMAGE = `sha256:${"a".repeat(64)}`;
const OPTIONS = { ignoreError: true, suppressOutput: true, timeout: 30_000 };
const paths: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  paths
    .splice(0)
    .forEach((receiptPath) =>
      fs.rmSync(path.dirname(receiptPath), { force: true, recursive: true }),
    );
});

function receiptPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-startup-receipt-"));
  const receipt = path.join(directory, "managed-startup-shared-state-transaction-v1");
  fs.mkdirSync(receipt, { mode: 0o700 });
  fs.writeFileSync(path.join(receipt, "receipt.json"), "{}", { mode: 0o600 });
  paths.push(receipt);
  return receipt;
}

describe("Docker daemon receipt transfer", () => {
  it("copies through a never-started isolated seed and mounts the result readonly", () => {
    const calls: string[][] = [];
    const dockerRun = vi.fn((args: readonly string[]) => {
      calls.push([...args]);
      return { status: 0 };
    });
    const receipt = transferDockerReceiptToDaemon({
      image: IMAGE,
      receiptPath: receiptPath(),
      destinations: ["/run/nemoclaw/receipt"],
      dockerOptions: OPTIONS,
      dockerRun,
    });

    expect(calls.map((args) => args[0])).toEqual(["volume", "create", "cp", "rm"]);
    expect(calls[1]).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--read-only",
        "--user",
        "0:0",
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
      ]),
    );
    expect(calls[2]).toEqual(
      expect.arrayContaining([
        "-a",
        expect.stringMatching(/managed-startup-shared-state-transaction-v1$/u),
        expect.stringMatching(/:.*\/receipt$/u),
      ]),
    );
    expect(dockerDaemonReceiptMount(receipt, "/run/nemoclaw/receipt")).toMatch(
      /^type=volume,src=nemoclaw-managed-startup-receipt-volume-[a-f0-9]+,dst=\/run\/nemoclaw,readonly$/u,
    );

    cleanupDockerDaemonReceiptBestEffort(
      receipt,
      "nemoclaw-managed-startup-receipt",
      dockerRun,
      OPTIONS,
    );
    expect(calls.at(-1)).toEqual(["volume", "rm", receipt.volumeName]);
    expect(fs.existsSync(path.dirname(receipt.hostPath))).toBe(false);
  });

  it("rejects non-normalized destinations and mounts over the filesystem root", () => {
    const receipt = { hostPath: "/tmp/receipt", volumeName: "receipt-volume" };

    expect(() => dockerDaemonReceiptMount(receipt, "../receipt")).toThrow(
      /normalized absolute path/u,
    );
    expect(() => dockerDaemonReceiptMount(receipt, "/receipt")).toThrow(/filesystem root/u);
    expect(() => dockerDaemonReceiptMount(receipt, "/")).toThrow(/filesystem root/u);
  });

  it("retains the host receipt when daemon volume creation fails", () => {
    const calls: string[][] = [];
    const dockerRun = vi.fn((args: readonly string[]) => {
      calls.push([...args]);
      return { status: 1, stderr: "volume denied" };
    });
    const hostPath = receiptPath();

    expect(() =>
      transferDockerReceiptToDaemon({
        image: IMAGE,
        receiptPath: hostPath,
        destinations: ["/run/nemoclaw/receipt"],
        dockerOptions: OPTIONS,
        dockerRun,
      }),
    ).toThrow(/Could not create managed-startup receipt volume/u);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toEqual(["volume", "create"]);
    expect(fs.existsSync(hostPath)).toBe(true);
  });

  it("removes the volume without removing a nonexistent seed after seed creation fails", () => {
    const calls: string[][] = [];
    const dockerRun = vi.fn((args: readonly string[]) => {
      calls.push([...args]);
      return args[0] === "create" ? { status: 1, stderr: "seed denied" } : { status: 0 };
    });
    const hostPath = receiptPath();

    expect(() =>
      transferDockerReceiptToDaemon({
        image: IMAGE,
        receiptPath: hostPath,
        destinations: ["/run/nemoclaw/receipt"],
        dockerOptions: OPTIONS,
        dockerRun,
      }),
    ).toThrow(/Could not create managed-startup receipt seed/u);
    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ["volume", "create"],
      ["create", "--name"],
      ["volume", "rm"],
    ]);
    expect(calls.some((args) => args[0] === "rm" && args[1] === "-f")).toBe(false);
    expect(fs.existsSync(hostPath)).toBe(true);
  });

  it("identifies every retained recovery artifact when staging cleanup fails", () => {
    const dockerRun = vi.fn((args: readonly string[]) => {
      switch (args[0]) {
        case "cp":
          return { status: 1, stderr: "copy denied" };
        case "rm":
          throw new Error("seed cleanup threw");
        case "volume":
          switch (args[1]) {
            case "rm":
              throw new Error("volume cleanup threw");
            default:
              return { status: 0 };
          }
        default:
          return { status: 0 };
      }
    });
    const hostPath = receiptPath();

    expect(() =>
      transferDockerReceiptToDaemon({
        image: IMAGE,
        receiptPath: hostPath,
        destinations: ["/run/nemoclaw/receipt"],
        dockerOptions: OPTIONS,
        dockerRun,
      }),
    ).toThrow(
      new RegExp(
        `${hostPath}.*seed container nemoclaw-managed-startup-receipt-seed-.*daemon volume nemoclaw-managed-startup-receipt-volume-`,
        "u",
      ),
    );
    expect(dockerRun.mock.calls.some(([args]) => args[0] === "volume" && args[1] === "rm")).toBe(
      true,
    );
    expect(fs.existsSync(hostPath)).toBe(true);
  });

  it.each([
    ["copy", (args: readonly string[]) => args[0] === "cp"],
    ["seed removal", (args: readonly string[]) => args[0] === "rm" && args[1] === "-f"],
  ])(
    "removes incomplete daemon staging after %s failure and retains the host receipt",
    (_case, fail) => {
      const calls: string[][] = [];
      let failed = false;
      const dockerRun = vi.fn((args: readonly string[]) => {
        calls.push([...args]);
        const shouldFail = !failed && fail(args);
        failed ||= shouldFail;
        return shouldFail ? { status: 1, stderr: "operation denied" } : { status: 0 };
      });
      const hostPath = receiptPath();

      expect(() =>
        transferDockerReceiptToDaemon({
          image: IMAGE,
          receiptPath: hostPath,
          destinations: ["/run/nemoclaw/receipt"],
          dockerOptions: OPTIONS,
          dockerRun,
        }),
      ).toThrow(
        /Could not (?:transfer managed-startup receipt|remove managed-startup receipt seed)/u,
      );
      expect(calls.some((args) => args[0] === "rm" && args[1] === "-f")).toBe(true);
      expect(calls.some((args) => args[0] === "volume" && args[1] === "rm")).toBe(true);
      expect(fs.existsSync(hostPath)).toBe(true);
    },
  );
});

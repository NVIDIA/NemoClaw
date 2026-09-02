// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => childProcessMocks);

import {
  processIsAlive,
  readHostIdentity,
  readPidNamespaceIdentity,
  readProcessIdentity,
  readProcessStartIdentity,
} from "./identity";

function linuxProcessStat(pid: number, state: string, startTicks: string): string {
  const fieldsAfterComm = Array.from({ length: 24 }, (_, index) =>
    index === 0 ? state : index === 19 ? startTicks : "0",
  );
  return `${String(pid)} (node worker) ${fieldsAfterComm.join(" ")}`;
}

function requiredFakeRead(fakeReads: ReadonlyMap<string, string>, file: fs.PathOrFileDescriptor) {
  return (
    fakeReads.get(String(file)) ??
    (() => {
      throw new Error(`unexpected read ${String(file)}`);
    })()
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  childProcessMocks.execFileSync.mockReset();
  childProcessMocks.spawnSync.mockReset();
});

describe("process identity adapter", () => {
  it("uses stable Linux machine and PID namespace evidence", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const fakeReads = new Map([["/etc/machine-id", "test-machine-id\n"]]);
    vi.spyOn(fs, "readFileSync").mockImplementation(((file) =>
      requiredFakeRead(fakeReads, file)) as typeof fs.readFileSync);
    vi.spyOn(fs, "readlinkSync").mockReturnValue("pid:[4026531836]");

    expect(readHostIdentity()).toBe("linux:test-machine-id");
    expect(readPidNamespaceIdentity()).toBe("pid:[4026531836]");
  });

  it("reports host and namespace evidence unavailable instead of trusting a hostname", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("machine identity unavailable");
    });
    vi.spyOn(fs, "readlinkSync").mockImplementation(() => {
      throw new Error("PID namespace unavailable");
    });
    const hostname = vi.spyOn(os, "hostname").mockReturnValue("shared-hostname");

    expect(readHostIdentity()).toBeNull();
    expect(readPidNamespaceIdentity()).toBeNull();
    expect(hostname).not.toHaveBeenCalled();
  });

  it("uses a stable macOS platform UUID instead of a hostname", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    childProcessMocks.execFileSync.mockReturnValue(
      '"IOPlatformUUID" = "0E317BE6-1968-5AD9-A7B4-65B82FC8B648"\n',
    );

    expect(readHostIdentity()).toBe("darwin:0e317be6-1968-5ad9-a7b4-65b82fc8b648");
    expect(childProcessMocks.execFileSync).toHaveBeenCalledWith(
      "ioreg",
      ["-rd1", "-c", "IOPlatformExpertDevice"],
      expect.objectContaining({ timeout: 1_000, maxBuffer: 64 * 1024 }),
    );
  });

  it("combines Linux boot identity and process start ticks", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const fakeReads = new Map<string, string>([
      ["/proc/42/stat", linuxProcessStat(42, "S", "12345")],
      ["/proc/sys/kernel/random/boot_id", "test-boot-id\n"],
    ]);
    vi.spyOn(fs, "readFileSync").mockImplementation(((file) =>
      requiredFakeRead(fakeReads, file)) as typeof fs.readFileSync);

    expect(readProcessIdentity(42, true, false)).toBe("linux:test-boot-id:12345");
  });

  it("uses Linux boot time when the kernel boot ID is unavailable", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const fakeReads = new Map<string, string>([
      ["/proc/43/stat", linuxProcessStat(43, "S", "67890")],
      ["/proc/stat", "cpu 1 2 3\nbtime 456\n"],
    ]);
    vi.spyOn(fs, "readFileSync").mockImplementation(((file) =>
      requiredFakeRead(fakeReads, file)) as typeof fs.readFileSync);

    expect(readProcessIdentity(43, true, false)).toBe("linux:btime 456:67890");
  });

  it("treats a Linux zombie as departed without probing kill", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "readFileSync").mockReturnValue(linuxProcessStat(44, "Z", "111"));
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    expect(processIsAlive(44)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("uses a bounded portable identity only when the caller permits it", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    childProcessMocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: "Mon Sep  2 12:00:00 2026\n",
    });

    expect(readProcessIdentity(45, true, false)).toBeNull();
    expect(childProcessMocks.spawnSync).not.toHaveBeenCalled();
    expect(readProcessIdentity(45, true, true)).toBe("darwin:Mon Sep  2 12:00:00 2026");
    expect(childProcessMocks.spawnSync).toHaveBeenCalledWith(
      "ps",
      ["-o", "lstart=", "-p", "45"],
      expect.objectContaining({ timeout: 1_000 }),
    );
  });

  it("preserves the bounded Shields ps identity format", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    childProcessMocks.execFileSync.mockReturnValue("Mon Sep  2 12:00:00 2026\n");

    expect(readProcessStartIdentity(46, 0.9)).toBe("ps:Mon Sep  2 12:00:00 2026");
    expect(childProcessMocks.execFileSync).toHaveBeenCalledWith(
      "ps",
      ["-o", "lstart=", "-p", "46"],
      expect.objectContaining({ timeout: 1 }),
    );
  });

  it("returns unavailable for an empty or failed portable identity probe", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    childProcessMocks.execFileSync.mockReturnValueOnce("  ").mockImplementationOnce(() => {
      throw new Error("ps timed out");
    });

    expect(readProcessStartIdentity(47)).toBeNull();
    expect(readProcessStartIdentity(48)).toBeNull();
    expect(readProcessStartIdentity(0)).toBeNull();
  });
});

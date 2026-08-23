// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NORMALIZER = "/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py";
const NORMALIZER_WATCHDOG = ["/usr/bin/timeout", "--signal=TERM", "--kill-after=5s", "15s"];
const requireSource = createRequire(import.meta.url);

type MutableConfigRepairModule = typeof import("./mutable-config-repair");
type PrivilegedExecModule = typeof import("../sandbox/privileged-exec");

let normalizeMutableOpenClawConfig: MutableConfigRepairModule["normalizeMutableOpenClawConfig"];
let privilegedExec: PrivilegedExecModule;

function mockPrivilegedLease() {
  return vi
    .spyOn(privilegedExec, "withPrivilegedSandboxExecutionLease")
    .mockImplementation(<T>(_sandboxName: string, _operation: string, fn: () => T): T => fn());
}

describe("mutable OpenClaw config repair", () => {
  beforeEach(() => {
    delete require.cache[requireSource.resolve("./mutable-config-repair.js")];
    privilegedExec = requireSource("../sandbox/privileged-exec.js");
    ({ normalizeMutableOpenClawConfig } = requireSource("./mutable-config-repair.js"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[requireSource.resolve("./mutable-config-repair.js")];
  });

  it("sanitizes identity probes and watchdogs the privileged normalizer", () => {
    const lease = mockPrivilegedLease();
    const capture = vi
      .spyOn(privilegedExec, "capturePrivilegedSandboxCommand")
      .mockReturnValueOnce(Buffer.from("1000\n"))
      .mockReturnValueOnce(Buffer.from("1001\n"))
      .mockReturnValue(Buffer.alloc(0));

    normalizeMutableOpenClawConfig("alpha", "/sandbox/.openclaw");

    expect(capture.mock.calls).toEqual([
      ["alpha", ["/usr/bin/id", "-u", "sandbox"], { sanitizeEnvironment: true, timeout: 15000 }],
      ["alpha", ["/usr/bin/id", "-g", "sandbox"], { sanitizeEnvironment: true, timeout: 15000 }],
      [
        "alpha",
        [
          ...NORMALIZER_WATCHDOG,
          "/usr/bin/python3",
          "-I",
          NORMALIZER,
          "/sandbox/.openclaw",
          "1000",
          "1001",
        ],
        { sanitizeEnvironment: true, timeout: 25000 },
      ],
    ]);
    expect(lease.mock.calls.map(([sandboxName, operation]) => [sandboxName, operation])).toEqual([
      ["alpha", "mutable config identity lookup"],
      ["alpha", "mutable config identity lookup"],
      ["alpha", "mutable config permission repair"],
    ]);
  });

  it("rejects an invalid sandbox UID before the GID or normalizer runs", () => {
    mockPrivilegedLease();
    const capture = vi
      .spyOn(privilegedExec, "capturePrivilegedSandboxCommand")
      .mockReturnValue(Buffer.from("0\n"));

    expect(() => normalizeMutableOpenClawConfig("alpha", "/sandbox/.openclaw")).toThrow(
      "sandbox identity lookup returned an invalid UID",
    );
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith("alpha", ["/usr/bin/id", "-u", "sandbox"], {
      sanitizeEnvironment: true,
      timeout: 15000,
    });
  });

  it("rejects an invalid sandbox GID before the normalizer runs", () => {
    mockPrivilegedLease();
    const capture = vi
      .spyOn(privilegedExec, "capturePrivilegedSandboxCommand")
      .mockReturnValueOnce(Buffer.from("1000\n"))
      .mockReturnValueOnce(Buffer.from("not-a-gid\n"));

    expect(() => normalizeMutableOpenClawConfig("alpha", "/sandbox/.openclaw")).toThrow(
      "sandbox identity lookup returned an invalid GID",
    );
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls.flatMap(([, command]) => command)).not.toContain(NORMALIZER);
  });

  it("propagates a trusted normalizer execution failure", () => {
    mockPrivilegedLease();
    const failure = new Error("provider exec failed");
    const capture = vi
      .spyOn(privilegedExec, "capturePrivilegedSandboxCommand")
      .mockReturnValueOnce(Buffer.from("1000\n"))
      .mockReturnValueOnce(Buffer.from("1001\n"))
      .mockImplementationOnce(() => {
        throw failure;
      });

    expect(() => normalizeMutableOpenClawConfig("alpha", "/sandbox/.openclaw")).toThrow(failure);
    expect(capture).toHaveBeenLastCalledWith(
      "alpha",
      [
        ...NORMALIZER_WATCHDOG,
        "/usr/bin/python3",
        "-I",
        NORMALIZER,
        "/sandbox/.openclaw",
        "1000",
        "1001",
      ],
      { sanitizeEnvironment: true, timeout: 25000 },
    );
    expect(capture).toHaveBeenCalledTimes(3);
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NORMALIZER = "/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py";
const NORMALIZER_WATCHDOG = ["/usr/bin/timeout", "--signal=TERM", "--kill-after=5s", "15s"];
const requireSource = createRequire(import.meta.url);

type DockerExecModule = typeof import("../adapters/docker/exec");
type MutableConfigRepairModule = typeof import("./mutable-config-repair");
type PrivilegedExecModule = typeof import("../sandbox/privileged-exec");

let dockerExec: DockerExecModule;
let normalizeMutableOpenClawConfig: MutableConfigRepairModule["normalizeMutableOpenClawConfig"];
let privilegedExec: PrivilegedExecModule;

function mockPrivilegedArgv() {
  return vi
    .spyOn(privilegedExec, "privilegedSandboxExecArgv")
    .mockImplementation((_sandboxName, cmd) => ["privileged", ...cmd]);
}

describe("mutable OpenClaw config repair", () => {
  beforeEach(() => {
    delete require.cache[requireSource.resolve("./mutable-config-repair.js")];
    dockerExec = requireSource("../adapters/docker/exec.js");
    privilegedExec = requireSource("../sandbox/privileged-exec.js");
    ({ normalizeMutableOpenClawConfig } = requireSource("./mutable-config-repair.js"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[requireSource.resolve("./mutable-config-repair.js")];
  });

  it("sanitizes identity probes and watchdogs the privileged normalizer", () => {
    const privilegedArgv = mockPrivilegedArgv();
    const dockerExecFileSync = vi
      .spyOn(dockerExec, "dockerExecFileSync")
      .mockReturnValueOnce("1000\n")
      .mockReturnValueOnce("1001\n")
      .mockReturnValue("");

    normalizeMutableOpenClawConfig("alpha", "/sandbox/.openclaw");

    expect(privilegedArgv.mock.calls).toEqual([
      ["alpha", ["/usr/bin/id", "-u", "sandbox"], false, true],
      ["alpha", ["/usr/bin/id", "-g", "sandbox"], false, true],
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
        false,
        true,
      ],
    ]);
    expect(dockerExecFileSync).toHaveBeenCalledTimes(3);
    expect(dockerExecFileSync.mock.calls.map(([argv]) => argv)).toEqual([
      ["privileged", "/usr/bin/id", "-u", "sandbox"],
      ["privileged", "/usr/bin/id", "-g", "sandbox"],
      [
        "privileged",
        ...NORMALIZER_WATCHDOG,
        "/usr/bin/python3",
        "-I",
        NORMALIZER,
        "/sandbox/.openclaw",
        "1000",
        "1001",
      ],
    ]);
    expect(dockerExecFileSync.mock.calls.map(([, options]) => options)).toEqual([
      { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
      { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
      { stdio: ["ignore", "pipe", "pipe"], timeout: 25000 },
    ]);
  });

  it("rejects an invalid sandbox UID before the GID or normalizer runs", () => {
    const privilegedArgv = mockPrivilegedArgv();
    const dockerExecFileSync = vi.spyOn(dockerExec, "dockerExecFileSync").mockReturnValue("0\n");

    expect(() => normalizeMutableOpenClawConfig("alpha", "/sandbox/.openclaw")).toThrow(
      "sandbox identity lookup returned an invalid UID",
    );
    expect(privilegedArgv).toHaveBeenCalledOnce();
    expect(privilegedArgv).toHaveBeenCalledWith(
      "alpha",
      ["/usr/bin/id", "-u", "sandbox"],
      false,
      true,
    );
    expect(dockerExecFileSync).toHaveBeenCalledOnce();
  });

  it("rejects an invalid sandbox GID before the normalizer runs", () => {
    const privilegedArgv = mockPrivilegedArgv();
    const dockerExecFileSync = vi
      .spyOn(dockerExec, "dockerExecFileSync")
      .mockReturnValueOnce("1000\n")
      .mockReturnValueOnce("not-a-gid\n");

    expect(() => normalizeMutableOpenClawConfig("alpha", "/sandbox/.openclaw")).toThrow(
      "sandbox identity lookup returned an invalid GID",
    );
    expect(privilegedArgv).toHaveBeenCalledTimes(2);
    expect(privilegedArgv).not.toHaveBeenCalledWith(
      "alpha",
      expect.arrayContaining([NORMALIZER]),
      false,
      true,
    );
    expect(dockerExecFileSync).toHaveBeenCalledTimes(2);
  });

  it("propagates a trusted normalizer execution failure", () => {
    const privilegedArgv = mockPrivilegedArgv();
    const failure = new Error("docker exec failed");
    const dockerExecFileSync = vi
      .spyOn(dockerExec, "dockerExecFileSync")
      .mockReturnValueOnce("1000\n")
      .mockReturnValueOnce("1001\n")
      .mockImplementationOnce(() => {
        throw failure;
      });

    expect(() => normalizeMutableOpenClawConfig("alpha", "/sandbox/.openclaw")).toThrow(failure);
    expect(privilegedArgv).toHaveBeenLastCalledWith(
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
      false,
      true,
    );
    expect(dockerExecFileSync).toHaveBeenCalledTimes(3);
  });
});

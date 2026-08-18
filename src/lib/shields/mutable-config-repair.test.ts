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

function normalizerFailure(overrides: Record<string, unknown>): Error {
  return Object.assign(
    new Error("docker exec exposed /sandbox/.openclaw/private-value"),
    {
      signal: null,
      status: 1,
      stderr: Buffer.from("untrusted stderr /sandbox/.openclaw/private-value\n"),
    },
    overrides,
  );
}

function captureFailure(run: () => void): unknown {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  return thrown;
}

function captureFailureMessage(run: () => void): string {
  const thrown = captureFailure(run);
  return thrown instanceof Error ? thrown.message : String(thrown);
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

  it("reports a mutable configuration validation failure without Docker stderr (#9215)", () => {
    const privilegedArgv = mockPrivilegedArgv();
    const failure = normalizerFailure({
      stderr: Buffer.from(
        "NEMOCLAW_MUTABLE_CONFIG_NORMALIZER_FAILURE:mutable-config-validation\n" +
          "untrusted stderr /sandbox/.openclaw/private-value\n",
      ),
    });
    const dockerExecFileSync = vi
      .spyOn(dockerExec, "dockerExecFileSync")
      .mockReturnValueOnce("1000\n")
      .mockReturnValueOnce("1001\n")
      .mockImplementationOnce(() => {
        throw failure;
      });

    const message = captureFailureMessage(() =>
      normalizeMutableOpenClawConfig("alpha", "/sandbox/.openclaw"),
    );
    expect(message).toBe(
      "Mutable OpenClaw configuration repair failed: mutable configuration validation failed",
    );
    expect(message).not.toContain("private-value");
    expect(message).not.toContain("docker exec");
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

  it("preserves a pre-exec authority rejection (#9215)", () => {
    const authorityFailure = new Error("provider fence owns privileged execution");
    const privilegedArgv = mockPrivilegedArgv()
      .mockImplementationOnce((_sandboxName, cmd) => ["privileged", ...cmd])
      .mockImplementationOnce((_sandboxName, cmd) => ["privileged", ...cmd])
      .mockImplementationOnce(() => {
        throw authorityFailure;
      });
    const dockerExecFileSync = vi
      .spyOn(dockerExec, "dockerExecFileSync")
      .mockReturnValueOnce("1000\n")
      .mockReturnValueOnce("1001\n");

    const thrown = captureFailure(() =>
      normalizeMutableOpenClawConfig("alpha", "/sandbox/.openclaw"),
    );

    expect(thrown).toBe(authorityFailure);
    expect(privilegedArgv).toHaveBeenCalledTimes(3);
    expect(dockerExecFileSync).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "the first trusted fixed-file label",
      failure: normalizerFailure({
        stderr:
          "NEMOCLAW_MUTABLE_CONFIG_NORMALIZER_FAILURE:fixed-file-link:config-hash\n" +
          "NEMOCLAW_MUTABLE_CONFIG_NORMALIZER_FAILURE:mutable-config-validation\n" +
          "untrusted stderr /sandbox/.openclaw/private-value\n",
      }),
      expected:
        "Mutable OpenClaw configuration repair failed: configuration hash link-count validation failed",
    },
    {
      name: "an unknown helper label",
      failure: normalizerFailure({
        stderr:
          "NEMOCLAW_MUTABLE_CONFIG_NORMALIZER_FAILURE:untrusted-value\n" +
          "untrusted stderr /sandbox/.openclaw/private-value\n",
      }),
      expected:
        "Mutable OpenClaw configuration repair failed: Docker repair command exited without a trusted helper diagnostic",
    },
    {
      name: "status 1 without a helper label",
      failure: normalizerFailure({}),
      expected:
        "Mutable OpenClaw configuration repair failed: Docker repair command exited without a trusted helper diagnostic",
    },
    {
      name: "a malformed helper label",
      failure: normalizerFailure({
        stderr:
          "untrusted-NEMOCLAW_MUTABLE_CONFIG_NORMALIZER_FAILURE:tree-walk\n" +
          "untrusted stderr /sandbox/.openclaw/private-value\n",
      }),
      expected:
        "Mutable OpenClaw configuration repair failed: Docker repair command exited without a trusted helper diagnostic",
    },
    {
      name: "an unknown label before a trusted label",
      failure: normalizerFailure({
        stderr:
          "NEMOCLAW_MUTABLE_CONFIG_NORMALIZER_FAILURE:untrusted-value\n" +
          "NEMOCLAW_MUTABLE_CONFIG_NORMALIZER_FAILURE:tree-walk\n" +
          "untrusted stderr /sandbox/.openclaw/private-value\n",
      }),
      expected:
        "Mutable OpenClaw configuration repair failed: Docker repair command exited without a trusted helper diagnostic",
    },
    {
      name: "the in-sandbox watchdog",
      failure: normalizerFailure({ status: 124 }),
      expected:
        "Mutable OpenClaw configuration repair failed: 15-second helper watchdog timed out",
    },
    {
      name: "status 137",
      failure: normalizerFailure({ status: 137 }),
      expected:
        "Mutable OpenClaw configuration repair failed: in-sandbox watchdog exited with status 137",
    },
    {
      name: "the host command timeout",
      failure: normalizerFailure({ code: "ETIMEDOUT", signal: "SIGTERM", status: null }),
      expected: "Mutable OpenClaw configuration repair failed: host command timed out",
    },
    {
      name: "a host Docker signal",
      failure: normalizerFailure({ signal: "SIGKILL", status: null }),
      expected:
        "Mutable OpenClaw configuration repair failed: host Docker command was terminated by a signal",
    },
    {
      name: "an unclassified Docker repair command exit",
      failure: normalizerFailure({
        status: 125,
        stderr:
          "NEMOCLAW_MUTABLE_CONFIG_NORMALIZER_FAILURE:tree-walk\n" +
          "untrusted stderr /sandbox/.openclaw/private-value\n",
      }),
      expected: "Mutable OpenClaw configuration repair failed: Docker repair command failed",
    },
  ])("reports $name without Docker stderr (#9215)", ({ failure, expected }) => {
    mockPrivilegedArgv();
    vi.spyOn(dockerExec, "dockerExecFileSync")
      .mockReturnValueOnce("1000\n")
      .mockReturnValueOnce("1001\n")
      .mockImplementationOnce(() => {
        throw failure;
      });

    const message = captureFailureMessage(() =>
      normalizeMutableOpenClawConfig("alpha", "/sandbox/.openclaw"),
    );

    expect(message).toBe(expected);
    expect(message).not.toContain("private-value");
    expect(message).not.toContain("docker exec");
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  type PrivilegedExec,
  validateOpenClawConfigCandidate,
  writeOpenClawConfigCandidate,
} from "./openclaw-config-guard";

function result(
  overrides: Partial<ReturnType<PrivilegedExec["run"]>> = {},
): ReturnType<PrivilegedExec["run"]> {
  return {
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

describe("OpenClaw mutable config guard", () => {
  it("rejects an oversized schema candidate before privileged execution", () => {
    const run = vi.fn();

    expect(validateOpenClawConfigCandidate({ run }, "x".repeat(16 * 1024 * 1024 + 1))).toEqual([
      "OpenClaw config candidate exceeds the 16 MiB size limit; existing config was not changed",
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("accepts a schema validator success record", () => {
    const run = vi.fn(() => result({ stdout: '{"valid":true}\n' }));

    expect(validateOpenClawConfigCandidate({ run }, '{"models":{}}\n')).toEqual([]);
    expect(run).toHaveBeenCalledWith(
      expect.arrayContaining(["/usr/bin/setpriv", "--reuid=gateway", "sh", "-c"]),
      '{"models":{}}\n',
    );
  });

  it("reports sanitized schema issue paths", () => {
    const run = vi.fn(() =>
      result({
        status: 1,
        stdout: JSON.stringify({ valid: false, issues: [{ path: "models.\u0000provider" }] }),
      }),
    );

    expect(validateOpenClawConfigCandidate({ run }, "{}")).toEqual([
      "OpenClaw config schema rejected the candidate at models. provider; existing config was not changed",
    ]);
  });

  it("classifies a terminated schema validator without presenting a schema rejection", () => {
    const run = vi.fn(() => result({ status: null, signal: "SIGTERM" }));

    expect(validateOpenClawConfigCandidate({ run }, "{}")[0]).toContain(
      "timed out or was terminated",
    );
  });

  it("rejects an invalid source digest before probing the helper", () => {
    const run = vi.fn();

    expect(writeOpenClawConfigCandidate({ run }, "{}", "invalid")).toEqual({
      issues: ["OpenClaw config write requires a 64-character lowercase SHA-256"],
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("requires the installed transaction helper for a write", () => {
    const run = vi.fn(() => result({ status: 1 }));

    expect(writeOpenClawConfigCandidate({ run }, "{}", "a".repeat(64))).toEqual({
      issues: [
        "OpenClaw config guard is absent in the sandbox; rebuild before writing config transactionally",
      ],
    });
  });

  it("passes config bytes and the matching source digest to the installed helper", () => {
    const committedDigest = "b".repeat(64);
    const run = vi
      .fn<PrivilegedExec["run"]>()
      .mockReturnValueOnce(result())
      .mockReturnValueOnce(
        result({
          stdout: `${JSON.stringify({
            type: "result",
            action: "write-config",
            status: "ok",
            configDir: "/sandbox/.openclaw",
            files: ["openclaw.json", ".config-hash"],
            configSha256: committedDigest,
          })}\n`,
        }),
      );

    expect(writeOpenClawConfigCandidate({ run }, '{"models":{}}\n', "a".repeat(64))).toEqual({
      issues: [],
      configSha256: committedDigest,
    });
    expect(run).toHaveBeenNthCalledWith(1, [
      "test",
      "-r",
      "/usr/local/lib/nemoclaw/openclaw-config-guard.py",
    ]);
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining(["write-config", "--expected-config-sha256", "a".repeat(64)]),
      '{"models":{}}\n',
    );
  });

  it("fails closed on malformed output and contradictory process status", () => {
    const run = vi
      .fn<PrivilegedExec["run"]>()
      .mockReturnValueOnce(result())
      .mockReturnValueOnce(result({ status: 7, stdout: "not-json\n", stderr: "failed" }));

    const write = writeOpenClawConfigCandidate({ run }, "{}", "a".repeat(64));
    expect(write.issues.join("\n")).toContain("non-JSON output");
    expect(write.issues.join("\n")).toContain("returned no result record");
    expect(write.issues.join("\n")).toContain("execution failed");
    expect(write.issues.join("\n")).toContain("unexpected stderr");
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  type PrivilegedExec,
  validateOpenClawConfigCandidate,
  verifyOpenClawConfigPosture,
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
      expect.arrayContaining([
        "/usr/bin/setpriv",
        "--reuid=sandbox",
        "--regid=sandbox",
        "sh",
        "-c",
      ]),
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

const postureSuccess = JSON.stringify({
  type: "result",
  action: "preflight-restart",
  status: "ok",
  configDir: "/sandbox/.openclaw",
  files: ["openclaw.json", ".config-hash"],
});
function postureFailure(code: string, issuePath = "/sandbox/.openclaw") {
  return [
    { type: "issue", code, path: issuePath, detail: code },
    { type: "result", action: "preflight-restart", status: "failed" },
  ]
    .map((value) => JSON.stringify(value))
    .join("\n");
}

describe("OpenClaw config posture verification", () => {
  it("accepts the guard's final verdict without selecting modes", () => {
    const run = vi.fn(() => result({ stdout: postureSuccess }));
    expect(verifyOpenClawConfigPosture({ run })).toEqual({ issues: [] });
    expect(run).toHaveBeenCalledWith(
      expect.arrayContaining(["preflight-restart", "--config-dir", "/sandbox/.openclaw"]),
    );
  });

  it.each([
    ["invalid-restart-posture", "/sandbox/.openclaw"],
    ["config-not-mutable", "/sandbox/.openclaw/openclaw.json"],
  ])("recognizes the guard's mode-only refusal: %s", (code, issuePath) => {
    const run = vi.fn(() => result({ status: 1, stdout: postureFailure(code, issuePath) }));
    expect(verifyOpenClawConfigPosture({ run })).toMatchObject({
      repairable: true,
      issues: [expect.stringContaining(code)],
    });
  });

  it.each([
    { status: 1, stdout: postureFailure("recovery-required") },
    { status: 1, stdout: postureFailure("startup-not-ready") },
    { status: 1, stdout: postureFailure("unsupported-config-posture") },
    { status: 1, stdout: postureFailure("invalid-config-json") },
    { status: 1, stdout: `noise\n${postureFailure("config-not-mutable")}` },
    { status: 1, stdout: `${postureFailure("config-not-mutable")}\n${postureSuccess}` },
    { status: 0, stdout: postureFailure("config-not-mutable") },
    { status: 1, stdout: postureFailure("config-not-mutable"), stderr: "unexpected" },
    { status: 1, stdout: postureFailure("config-not-mutable"), error: "transport failed" },
    { status: 124, stdout: postureSuccess },
    { status: 1, stdout: postureFailure("config-not-mutable"), signal: "SIGTERM" as const },
    { status: 1, stdout: postureFailure("config-not-mutable", "/tmp/unrelated") },
  ])("does not authorize repair from an inconclusive or protected result %#", (outcome) => {
    const verified = verifyOpenClawConfigPosture({ run: () => result(outcome) });
    expect(verified.repairable).not.toBe(true);
    expect(verified.issues).not.toHaveLength(0);
  });
});

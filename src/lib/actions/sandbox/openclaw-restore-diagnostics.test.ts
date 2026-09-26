// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { finishOpenClawPostRestoreDoctor } from "./process-recovery";
import {
  buildOpenClawRestoreLogCommand,
  formatOpenClawRestoreLogs,
} from "./gateway-wedge-diagnostics";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restore-logs-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = () =>
    spawnSync("sh", ["-c", buildOpenClawRestoreLogCommand().replace("'/tmp'", `'${root}'`)], {
      encoding: "utf8",
      timeout: 5_000,
    });
  return { root, run };
}

describe("OpenClaw restore diagnostics", () => {
  it("reads bounded startup and gateway tails without configuration contents", () => {
    const { root, run } = fixture();
    fs.writeFileSync(
      path.join(root, "nemoclaw-start.log"),
      `${"x".repeat(20_000)}\nstartup failed\n`,
    );
    fs.writeFileSync(path.join(root, "gateway.log"), "gateway refused restored state\n");
    fs.writeFileSync(path.join(root, "openclaw.json"), "private configuration");
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("startup failed");
    expect(result.stdout).toContain("gateway refused restored state");
    expect(result.stdout).not.toContain("private configuration");
    expect(result.stdout).not.toContain("x".repeat(100));
    expect(result.stdout.length).toBeLessThan(33_000);
  });

  it.each([
    ["symlink", (log: string, secret: string) => fs.symlinkSync(secret, log)],
    ["hardlink", (log: string, secret: string) => fs.linkSync(secret, log)],
    ["fifo", (log: string) => expect(spawnSync("mkfifo", [log]).status).toBe(0)],
    ["directory", (log: string) => fs.mkdirSync(log)],
    ["missing", () => undefined],
  ] as const)("reports an unavailable %s without reading it or blocking", (_kind, prepare) => {
    const { root, run } = fixture();
    const log = path.join(root, "nemoclaw-start.log");
    const secret = path.join(root, "secret");
    fs.writeFileSync(secret, "not a startup log");
    prepare(log, secret);
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("[restore-log] unavailable");
    expect(result.stdout).not.toContain("not a startup log");
  });

  it.each([
    [
      "complete",
      `${["-----BEGIN", "PRIVATE KEY-----"].join(" ")}\n`,
      "-----END PRIVATE KEY-----\nafter key\n",
    ],
    ["orphan end", "", "-----END PRIVATE KEY-----\nafter key\n"],
    ["unterminated", `${["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ")}\n`, ""],
  ])("redacts a %s private key before selecting the tail", (_kind, prefix, suffix) => {
    const { root, run } = fixture();
    const body = "PRIVATE_BODY_AFTER_TRUNCATION\n".repeat(800);
    fs.writeFileSync(path.join(root, "nemoclaw-start.log"), `${prefix}${body}${suffix}`);
    const read = run();
    expect(read.status, read.stderr).toBe(0);
    const result = formatOpenClawRestoreLogs(
      { status: read.status ?? 1, stdout: read.stdout, stderr: read.stderr },
      {},
    ).join("\n");
    expect(result).not.toContain("PRIVATE_BODY_AFTER_TRUNCATION");
    expect(result).toContain("<REDACTED>");
  });

  it("redacts known multiline credentials across the tail boundary", () => {
    const { root, run } = fixture();
    const secret = `${"FIRST_SECRET_LINE".repeat(1500)}\nSECOND_SECRET_LINE`;
    fs.writeFileSync(path.join(root, "nemoclaw-start.log"), `${secret}\nafter credential\n`);
    const read = run();
    expect(read.status, read.stderr).toBe(0);
    const result = formatOpenClawRestoreLogs(
      { status: read.status ?? 1, stdout: read.stdout, stderr: read.stderr },
      { COMPATIBLE_API_KEY: secret },
    ).join("\n");
    expect(result).not.toContain("FIRST_SECRET_LINE");
    expect(result).not.toContain("SECOND_SECRET_LINE");
    expect(result).toContain("after credential");
  });

  it("reports an unavailable log when complete context exceeds the read limit", () => {
    const { root, run } = fixture();
    fs.writeFileSync(path.join(root, "nemoclaw-start.log"), "x".repeat(1048577));
    expect(run().stdout).toContain("[restore-log] unavailable");
  });

  it("redacts complete credentials before bounding lines", () => {
    const secret = 'opaque\\value"with\nnewlines';
    const result = formatOpenClawRestoreLogs(
      {
        status: 7,
        stdout: `${secret}\n${JSON.stringify(secret).slice(1, -1)}\nAuthorization: Bearer opaque-token\n${["-----BEGIN", "PRIVATE KEY-----"].join(" ")}\nprivate-body\n-----END PRIVATE KEY-----\n`,
        stderr: "https://user:password@example.test/?token=private-query\n\u001b[31mread failed",
      },
      { COMPATIBLE_API_KEY: secret },
    ).join("\n");
    expect(result).not.toContain(secret);
    expect(result).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(result).not.toContain("opaque-token");
    expect(result).not.toContain("private-body");
    expect(result).not.toContain("private-query");
    expect(result).not.toContain("password");
    expect(result).not.toContain("\u001b");
    expect(result).toContain("command exit 7");
    expect(result).toContain("read failed");
  });

  it("bounds output and reports empty or unavailable reads", () => {
    expect(formatOpenClawRestoreLogs(null)).toEqual(["[restore-log] command unavailable"]);
    expect(formatOpenClawRestoreLogs({ status: 1, stdout: "", stderr: "" })).toEqual([
      "[restore-log] command exit 1",
      "[restore-log] no output",
    ]);
    expect(formatOpenClawRestoreLogs({ status: 0, stdout: "a".repeat(65537), stderr: "" })).toEqual(
      ["[restore-log] output limit exceeded"],
    );
    const bounded = formatOpenClawRestoreLogs({
      status: 0,
      stdout: `${"a".repeat(490)}\n`.repeat(130),
      stderr: "",
    });
    expect(bounded).toHaveLength(121);
    expect(bounded.every((line) => line.length <= 480)).toBe(true);
  });

  it.each(["logs", "unavailable"])(
    "retains %s from the pre-abort probe without changing the health failure",
    async (kind) => {
      let now = 0;
      const execute = vi
        .fn()
        .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
        .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
        .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
        .mockResolvedValueOnce({ status: 1, stdout: "", stderr: "" })
        .mockResolvedValue(
          kind === "logs"
            ? {
                status: 0,
                stdout: "[restore-log] nemoclaw-start.log\nstartup refused\n",
                stderr: "",
              }
            : null,
        );
      const captureOpenshell = vi.fn();
      const runtimeSelection = { gatewayName: "recorded-gateway", workspace: "recorded-workspace" };
      const result = await finishOpenClawPostRestoreDoctor(
        { sandboxName: "alpha", runtimeSelection },
        {
          captureOpenshell: captureOpenshell as never,
          executeSandboxExecCommand: execute,
          collectFailureLogs: vi.fn(async () => []),
          now: () => now,
          sleep: vi.fn(async () => {
            now = 180_000;
          }),
        },
      );
      expect(result).toMatchObject({
        ok: false,
        stage: "restart",
        detail: expect.stringContaining(
          kind === "logs" ? "startup refused" : "[restore-log] command unavailable",
        ),
      });
      expect(execute).toHaveBeenLastCalledWith(
        "alpha",
        expect.stringContaining(buildOpenClawRestoreLogCommand()),
        15_000,
        {
          runtimeSelection,
        },
      );
      expect(captureOpenshell).not.toHaveBeenCalled();
    },
  );
});

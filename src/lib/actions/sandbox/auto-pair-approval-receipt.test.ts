// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  buildAutoPairApprovalScript,
  classifyAutoPairApprovalExecReceipt,
  parseAutoPairApprovalReceipt,
  readAutoPairApprovalPolicyModule,
  runSandboxAutoPairApprovalPass,
} from "./auto-pair-approval";

describe("auto-pair approval receipts (#4616)", () => {
  const pythonUnavailable =
    spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status !== 0;

  it.skipIf(pythonUnavailable)("omits raw output from devices-list failure classifications", () => {
    const policy = readAutoPairApprovalPolicyModule();
    expect(policy).toBeTruthy();
    const script = buildAutoPairApprovalScript(
      Buffer.from(policy as string, "utf-8").toString("base64"),
      {
        emitReceipt: true,
        budget: { listTimeoutS: 0.5 },
      },
    );
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-list-receipt-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "openclaw"),
        `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== "devices" || args[1] !== "list") process.exit(2);
const sleepMs = Number(process.env.NEMOCLAW_LIST_SLEEP_MS || "0");
if (sleepMs > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
}
process.stdout.write(process.env.NEMOCLAW_LIST_STDOUT || "");
process.stderr.write(process.env.NEMOCLAW_LIST_STDERR || "");
process.exit(Number(process.env.NEMOCLAW_LIST_EXIT_CODE || "0"));
`,
        { mode: 0o755 },
      );
      for (const [environment, receipt] of [
        [{ NEMOCLAW_LIST_SLEEP_MS: "800" }, "list-timeout"],
        [
          { NEMOCLAW_LIST_EXIT_CODE: "1", NEMOCLAW_LIST_STDERR: "raw failure" },
          "list-command-failed",
        ],
        [
          {
            NEMOCLAW_LIST_EXIT_CODE: "1",
            NEMOCLAW_LIST_STDERR: "scope upgrade pending approval raw detail",
          },
          "list-scope-upgrade-pending",
        ],
        [
          {
            NEMOCLAW_LIST_EXIT_CODE: "1",
            NEMOCLAW_LIST_STDERR: "device pairing required raw detail",
          },
          "list-device-pairing-required",
        ],
        [
          {
            NEMOCLAW_LIST_EXIT_CODE: "1",
            NEMOCLAW_LIST_STDERR: "gateway connect failed raw detail",
          },
          "list-gateway-connect-failed",
        ],
        [{ NEMOCLAW_LIST_STDOUT: "" }, "list-empty-output"],
        [{ NEMOCLAW_LIST_STDOUT: "raw invalid json" }, "list-invalid-json"],
        [{ NEMOCLAW_LIST_STDOUT: "[]\n" }, "list-invalid-output"],
        [{ NEMOCLAW_LIST_STDOUT: "{}\n" }, "list-missing-pending"],
      ] as const) {
        const result = spawnSync("sh", ["-c", script], {
          encoding: "utf-8",
          env: {
            ...process.env,
            PATH: `${tmpDir}:/usr/bin:/bin`,
            ...environment,
          },
          timeout: 10_000,
        });
        expect(parseAutoPairApprovalReceipt(result.stdout)).toBe(receipt);
        expect(`${result.stdout}${result.stderr}`).not.toContain("raw ");
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("distinguishes host execution failures without returning their details", () => {
    const timeoutError = Object.assign(new Error("private timeout detail"), {
      code: "ETIMEDOUT",
    });
    const spawnError = Object.assign(new Error("private spawn detail"), { code: "ENOENT" });

    expect(
      classifyAutoPairApprovalExecReceipt(
        { error: timeoutError, status: null, signal: "SIGTERM" },
        "private output",
      ),
    ).toBe("exec-timeout");
    expect(
      classifyAutoPairApprovalExecReceipt(
        { error: spawnError, status: null, signal: null },
        "private output",
      ),
    ).toBe("exec-spawn-failed");
    expect(
      classifyAutoPairApprovalExecReceipt({ status: null, signal: "SIGKILL" }, "private output"),
    ).toBe("exec-signal");
    expect(classifyAutoPairApprovalExecReceipt({ status: 1, signal: null }, "private output")).toBe(
      "exec-command-failed",
    );
    expect(classifyAutoPairApprovalExecReceipt({ status: 0, signal: null }, "private output")).toBe(
      "exec-invalid-receipt",
    );
    expect(
      classifyAutoPairApprovalExecReceipt(
        { status: 0, signal: null },
        "__NEMOCLAW_AUTO_PAIR_RECEIPT__=approved-one\n",
      ),
    ).toBe("approved-one");
  });

  it("streams the approval program through stdin instead of OpenShell command argv", () => {
    const run = vi.fn(
      (
        _command: string,
        _args: readonly string[],
        _options: SpawnSyncOptionsWithStringEncoding,
      ) => ({
        status: 0,
        signal: null,
        stdout: "__NEMOCLAW_AUTO_PAIR_RECEIPT__=approved-one\n",
        stderr: "",
      }),
    );

    const result = runSandboxAutoPairApprovalPass(
      "beta",
      { localDeviceOnly: true, receipt: true },
      {
        getOpenshellBinary: () => "/usr/local/bin/openshell",
        spawnSync: run as unknown as typeof spawnSync,
      },
    );

    expect(result.receipt).toBe("approved-one");
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[1]).toEqual(["sandbox", "exec", "--name", "beta", "--", "sh", "-s"]);
    expect(run.mock.calls[0]?.[1].join(" ")).not.toContain("PYAPPROVE");
    expect(run.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        input: expect.stringContaining("PYAPPROVE"),
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  });
});

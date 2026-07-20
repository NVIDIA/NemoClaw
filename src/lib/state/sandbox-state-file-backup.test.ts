// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { findMultilineExecArg } from "../actions/sandbox/exec";

const execReadOnly = vi.hoisted(() => vi.fn());
const getSandbox = vi.hoisted(() => vi.fn());
const loadAgent = vi.hoisted(() => vi.fn());

vi.mock("../adapters/openshell/sandbox-control-routing.js", () => ({
  execSandboxReadOnlyWithGrpcFallback: execReadOnly,
}));
vi.mock("./registry.js", () => ({ getSandbox }));
vi.mock("../agent/defs.js", () => ({ loadAgent }));

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-file-backup-"));
process.env.HOME = TMP_HOME;

const {
  backupSandboxState,
  buildStateFileBackupExecRequest,
  classifyStateFileBackupExecResult,
  isSandboxExecTransportFailure,
  SQLITE_BACKUP_PY,
} = await import("./sandbox");

afterAll(() => {
  ORIGINAL_HOME === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { force: true, recursive: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(path.join(TMP_HOME, ".nemoclaw"), { force: true, recursive: true });
  getSandbox.mockReturnValue({
    name: "hermes",
    agent: "hermes",
    policies: [],
    gatewayName: "nemoclaw",
  });
  loadAgent.mockReturnValue({
    configPaths: { dir: "/sandbox/.hermes" },
    expectedVersion: null,
    stateDirs: [],
    stateFiles: [{ path: "runtime/state.db", strategy: "copy" }],
  });
});

describe("state-file backup exec request", () => {
  it("streams the SQLite program through stdin and keeps every command argument single-line", () => {
    const request = buildStateFileBackupExecRequest("hermes", "/sandbox/.hermes", {
      path: "runtime/state.db",
      strategy: "sqlite_backup",
    });

    expect(request.command).toEqual([
      "sh",
      "-c",
      expect.stringContaining('python3 - "$src" "$tmp"'),
    ]);
    expect(request.command.every((argument) => !/[\r\n]/.test(argument))).toBe(true);
    expect(findMultilineExecArg(request.command)).toBe(-1);
    expect(request.command.join("\n")).not.toContain("sqlite3.connect");
    expect(request.command.join("\n")).toContain('python3 - "$src" "$tmp" || exit $?');
    expect(request.stdin).toBe(SQLITE_BACKUP_PY);
    expect(SQLITE_BACKUP_PY).toContain("sqlite3.connect");
    expect(SQLITE_BACKUP_PY).toContain("src_conn.backup(dst_conn)");
    expect(SQLITE_BACKUP_PY).toContain("PRAGMA quick_check");
    expect(request).toMatchObject({
      sandboxName: "hermes",
      timeoutMs: 120_000,
      maxOutputBytes: 256 * 1024 * 1024,
      stdoutEncoding: "buffer",
    });
  });

  it("does not attach the SQLite program to copy requests", () => {
    const request = buildStateFileBackupExecRequest("hermes", "/sandbox/.hermes", {
      path: "SOUL.md",
      strategy: "copy",
    });

    expect(request.command).toEqual(["sh", "-c", expect.stringContaining('cat -- "$src"')]);
    expect(request).not.toHaveProperty("stdin");
  });

  it("does not emit a temporary database when the streamed Python backup fails", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sqlite-backup-failure-"));
    try {
      fs.writeFileSync(path.join(tempDir, "state.db"), "source");
      const request = buildStateFileBackupExecRequest("hermes", tempDir, {
        path: "state.db",
        strategy: "sqlite_backup",
      });
      const failingProgram = [
        "import pathlib, sys",
        "pathlib.Path(sys.argv[2]).write_bytes(b'partial-backup')",
        "raise SystemExit(41)",
      ].join("\n");

      const result = spawnSync("sh", request.command.slice(1), {
        encoding: "utf8",
        input: failingProgram,
      });

      expect(result.status).toBe(41);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("accepts only an error-free binary result as a completed backup", () => {
    const bytes = Buffer.from([0, 255, 128, 10]);
    expect(
      classifyStateFileBackupExecResult({
        status: 0,
        stdout: "",
        stdoutBytes: bytes,
        stderr: "",
      }),
    ).toBe("backed_up");
    expect(
      classifyStateFileBackupExecResult({
        status: 0,
        stdout: "",
        stdoutBytes: bytes,
        stderr: "",
        error: new Error("stream failed"),
      }),
    ).toBe("failed");
    expect(
      classifyStateFileBackupExecResult({
        status: 0,
        stdout: "",
        stdoutBytes: bytes,
        stderr: "",
        signal: "SIGTERM",
      }),
    ).toBe("failed");
    expect(
      classifyStateFileBackupExecResult({
        status: 2,
        stdout: "",
        stderr: "",
        error: new Error("lookup failed"),
      }),
    ).toBe("failed");
    expect(classifyStateFileBackupExecResult({ status: 0, stdout: "", stderr: "" })).toBe("failed");
  });

  it("does not classify terminal local validation and output limits as unreachable", () => {
    const outputLimit = Object.assign(new Error("output limit"), { code: "ENOBUFS" });
    const invalidRequest = Object.assign(new Error("invalid request"), {
      code: "OPENSHELL_EXEC_INVALID_ARGUMENT",
    });

    expect(isSandboxExecTransportFailure({ status: null, error: outputLimit })).toBe(false);
    expect(isSandboxExecTransportFailure({ status: null, error: invalidRequest })).toBe(false);
    expect(isSandboxExecTransportFailure({ status: null, error: new Error("UNAVAILABLE") })).toBe(
      true,
    );
    expect(isSandboxExecTransportFailure({ status: null, signal: "SIGKILL" })).toBe(true);
  });

  it("persists binary state-file bytes with private mode and complete backup bookkeeping", async () => {
    const bytes = Buffer.from([0x53, 0x51, 0x4c, 0x00, 0xff, 0xfe, 0x80, 0x0a]);
    execReadOnly.mockResolvedValue({
      status: 0,
      stdout: "",
      stdoutBytes: bytes,
      stderr: "",
    });

    const result = await backupSandboxState("hermes", { name: "binary-state" });

    expect(result).toMatchObject({
      success: true,
      backedUpDirs: [],
      failedDirs: [],
      backedUpFiles: ["runtime/state.db"],
      failedFiles: [],
    });
    expect(result.manifest?.stateFiles).toEqual([{ path: "runtime/state.db", strategy: "copy" }]);
    const persistedPath = path.join(result.manifest!.backupPath, "runtime", "state.db");
    expect(fs.readFileSync(persistedPath)).toEqual(bytes);
    expect(fs.statSync(persistedPath).mode & 0o777).toBe(0o600);
    expect(execReadOnly).toHaveBeenCalledWith(
      "nemoclaw",
      expect.objectContaining({
        sandboxName: "hermes",
        stdoutEncoding: "buffer",
      }),
    );
  });

  it("fails closed when a successful state-file exec omits binary stdout", async () => {
    execReadOnly.mockResolvedValue({ status: 0, stdout: "", stderr: "" });

    const result = await backupSandboxState("hermes", { name: "missing-binary-state" });

    expect(result).toMatchObject({
      success: false,
      backedUpFiles: [],
      failedFiles: ["runtime/state.db"],
      unreachable: false,
    });
    expect(fs.existsSync(path.join(result.manifest!.backupPath, "runtime", "state.db"))).toBe(
      false,
    );
  });
});

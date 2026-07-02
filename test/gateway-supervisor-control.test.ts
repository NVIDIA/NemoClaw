// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..");
const SUPERVISOR_LIBRARY = join(REPO_ROOT, "scripts/lib/gateway-supervisor.sh");
const CONTROL_HELPER = join(REPO_ROOT, "scripts/gateway-control.sh");
const VALID_NONCE = "a".repeat(64);

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function runSupervisorLibrary(
  body: string,
  request?: string,
): CommandResult & { controlDirectory: string } {
  const controlDirectory = temporaryDirectory("nemoclaw-gateway-supervisor-");
  chmodSync(controlDirectory, 0o700);
  for (const pendingRequest of request === undefined ? [] : [request]) {
    writeFileSync(join(controlDirectory, "request"), pendingRequest, { mode: 0o600 });
  }

  const script = [
    "set -euo pipefail",
    `export NEMOCLAW_GATEWAY_CONTROL_DIR=${JSON.stringify(controlDirectory)}`,
    `source ${JSON.stringify(SUPERVISOR_LIBRARY)}`,
    body,
  ].join("\n");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    encoding: "utf-8",
    timeout: 5000,
  });
  return {
    controlDirectory,
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("gateway supervisor request protocol", () => {
  it.each([
    "restart",
    "probe",
  ])("accepts an exact versioned %s request and publishes a nonce-bound status", (action) => {
    const result = runSupervisorLibrary(
      [
        "GATEWAY_CONTROL_SIGNAL_PENDING=1",
        "gateway_control_take_request",
        'printf "%s %s\\n" "$GATEWAY_CONTROL_NONCE" "$GATEWAY_CONTROL_ACTION"',
      ].join("\n"),
      `v1 ${VALID_NONCE} ${action}\n`,
    );

    expect(result).toMatchObject({
      status: 0,
      stdout: `${VALID_NONCE} ${action}`,
      stderr: "",
    });
    const statusPath = join(result.controlDirectory, "status");
    expect(readFileSync(statusPath, "utf-8")).toBe(`v1 ${VALID_NONCE} accepted\n`);
    expect(statSync(statusPath).mode & 0o777).toBe(0o600);
  });

  it.each([
    ["unsupported version", `v2 ${VALID_NONCE} restart\n`],
    ["short nonce", "v1 abc restart\n"],
    ["uppercase nonce", `v1 ${"A".repeat(64)} restart\n`],
    ["unknown action", `v1 ${VALID_NONCE} replace\n`],
    ["extra field", `v1 ${VALID_NONCE} recover unexpected\n`],
  ])("rejects %s without accepting the request", (_label, request) => {
    const result = runSupervisorLibrary(
      [
        "GATEWAY_CONTROL_SIGNAL_PENDING=1",
        "if gateway_control_take_request; then exit 90; fi",
        'test ! -e "$NEMOCLAW_GATEWAY_CONTROL_STATUS"',
        'printf "rejected\\n"',
      ].join("\n"),
      request,
    );

    expect(result).toMatchObject({ status: 0, stdout: "rejected", stderr: "" });
  });

  it.each([
    ["recover", "ok", 101, 202],
    ["probe", "already-running", 101, 101],
  ])("publishes %s completion with the request nonce and removes the request", (action, detail, oldPid, newPid) => {
    const result = runSupervisorLibrary(
      [
        "GATEWAY_CONTROL_SIGNAL_PENDING=1",
        "gateway_control_take_request",
        `gateway_control_complete ${detail} ${oldPid} ${newPid}`,
        'test ! -e "$NEMOCLAW_GATEWAY_CONTROL_REQUEST"',
        'cat "$NEMOCLAW_GATEWAY_CONTROL_STATUS"',
      ].join("\n"),
      `v1 ${VALID_NONCE} ${action}\n`,
    );

    expect(result).toMatchObject({
      status: 0,
      stdout: `v1 ${VALID_NONCE} complete ${detail} ${oldPid} ${newPid}`,
      stderr: "",
    });
  });

  it("maps an unknown failure detail to the closed internal status", () => {
    const result = runSupervisorLibrary(
      [
        "GATEWAY_CONTROL_SIGNAL_PENDING=1",
        "gateway_control_take_request",
        "gateway_control_fail attacker-controlled 303",
        'cat "$NEMOCLAW_GATEWAY_CONTROL_STATUS"',
      ].join("\n"),
      `v1 ${VALID_NONCE} restart\n`,
    );

    expect(result).toMatchObject({
      status: 0,
      stdout: `v1 ${VALID_NONCE} failed internal 303 0`,
      stderr: "",
    });
  });
});

describe("gateway supervisor tracked PID handling", () => {
  it("terminates only the exact tracked child PID", () => {
    const result = runSupervisorLibrary(
      [
        "set +m",
        "sleep 30 & target_pid=$!",
        "sleep 30 & sibling_pid=$!",
        'cleanup_children() { kill "$target_pid" "$sibling_pid" 2>/dev/null || true; }',
        "trap cleanup_children EXIT",
        'target_identity="$(gateway_control_pid_start_identity "$target_pid")"',
        'test -n "$target_identity"',
        'gateway_control_stop_tracked_pid "$target_pid" "$target_identity"',
        'if kill -0 "$target_pid" 2>/dev/null; then exit 91; fi',
        'kill -0 "$sibling_pid"',
        'printf "%s\\n" "$sibling_pid"',
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    // macOS bash 3.2 reports SIGTERM job-control notifications to stderr
    // (e.g. "Terminated: 15  sleep 30") despite set +m; filter them out.
    expect(result.stderr.replace(/^(?:Terminated|Killed): \d+[^\n]*\n?/gm, "")).toBe("");
    expect(result.stdout).toMatch(/^\d+$/);
  });

  it("never sends a signal for sentinel or non-PID values", () => {
    const result = runSupervisorLibrary(
      [
        "calls=()",
        'kill() { calls+=("kill:$*"); return 1; }',
        'wait() { calls+=("wait:$*"); return 0; }',
        "gateway_control_stop_tracked_pid 0",
        "gateway_control_stop_tracked_pid 1",
        "gateway_control_stop_tracked_pid not-a-pid",
        'test "${#calls[@]}" -eq 0',
      ].join("\n"),
    );

    expect(result).toMatchObject({ status: 0, stdout: "", stderr: "" });
  });

  it("requires a captured identity for a numeric PID without signaling or waiting", () => {
    const result = runSupervisorLibrary(
      [
        "calls=()",
        'kill() { calls+=("kill:$*"); return 1; }',
        'wait() { calls+=("wait:$*"); return 0; }',
        "if gateway_control_stop_tracked_pid 4242 ''; then exit 92; fi",
        'test "${#calls[@]}" -eq 0',
      ].join("\n"),
    );

    expect(result).toMatchObject({ status: 0, stdout: "", stderr: "" });
  });

  it("does not KILL or wait for a PID whose start identity changes after TERM", () => {
    const procRoot = join(temporaryDirectory("nemoclaw-gateway-stop-proc-"), "proc");
    const result = runSupervisorLibrary(
      [
        `_NEMOCLAW_PROC_ROOT=${JSON.stringify(procRoot)}`,
        'mkdir -p "$_NEMOCLAW_PROC_ROOT/4242"',
        "write_proc_stat() {",
        '  local start="$1"',
        "  printf '4242 (tracked-child) S 1'",
        "  for _ in {1..17}; do printf ' 0'; done",
        '  printf " %s\\n" "$start"',
        "}",
        'write_proc_stat 111 >"$_NEMOCLAW_PROC_ROOT/4242/stat"',
        "calls=()",
        "kill() {",
        '  calls+=("kill:$*")',
        '  if [ "$1" = "-TERM" ]; then',
        '    write_proc_stat 222 >"$_NEMOCLAW_PROC_ROOT/4242/stat"',
        "  fi",
        "  return 0",
        "}",
        'wait() { calls+=("wait:$*"); return 0; }',
        "sleep() { :; }",
        "gateway_control_stop_tracked_pid 4242 111",
        'printf "%s\\n" "${calls[@]}"',
      ].join("\n"),
    );

    expect(result).toMatchObject({ status: 0, stdout: "kill:-TERM 4242", stderr: "" });
  });
});

describe("gateway supervisor listener ownership", () => {
  it.each([
    ["IPv4 listener fd owned by the tracked PID", "tcp", "0A", "12345", "owned"],
    ["IPv6 listener fd owned by the tracked PID", "tcp6", "0A", "12345", "owned"],
    ["listener inode absent from the tracked PID fds", "tcp", "0A", "99999", "rejected"],
    ["matching socket inode in a non-LISTEN state", "tcp", "01", "12345", "rejected"],
  ])("classifies %s", (_label, table, state, fdInode, expected) => {
    const procRoot = join(temporaryDirectory("nemoclaw-gateway-proc-"), "proc");
    const result = runSupervisorLibrary(
      [
        `PROC_ROOT=${JSON.stringify(procRoot)}`,
        'mkdir -p "$PROC_ROOT/net" "$PROC_ROOT/$$/fd"',
        ': >"$PROC_ROOT/net/tcp"',
        ': >"$PROC_ROOT/net/tcp6"',
        `printf '%s\\n' '0: 0100007F:4A38 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 4242 0 12345' >>"$PROC_ROOT/net/${table}"`,
        `ln -s 'socket:[${fdInode}]' "$PROC_ROOT/$$/fd/7"`,
        'if gateway_control_pid_owns_tcp_listener "$$" 19000 "$PROC_ROOT"; then',
        '  printf "owned\\n"',
        "else",
        '  printf "rejected\\n"',
        "fi",
      ].join("\n"),
    );

    expect(result).toMatchObject({ status: 0, stdout: expected, stderr: "" });
  });
});

describe("root-only gateway control helper", () => {
  it.each([
    "restart",
    "probe",
  ])("enters managed %s control with isolated Python before user-site startup hooks", (action) => {
    const root = temporaryDirectory("nemoclaw-managed-python-isolation-");
    const userBase = join(root, "attacker-userbase");
    const marker = join(root, "pth-loaded");
    const attackEnv: NodeJS.ProcessEnv = { ...process.env, PYTHONUSERBASE: userBase };
    delete attackEnv.PYTHONNOUSERSITE;
    const userSite = spawnSync(
      "python3",
      ["-c", "import site; print(site.getusersitepackages())"],
      { encoding: "utf-8", env: attackEnv },
    );
    expect(userSite.status, userSite.stderr).toBe(0);
    const sitePackages = userSite.stdout.trim();
    mkdirSync(sitePackages, { recursive: true });
    writeFileSync(
      join(sitePackages, "attacker.pth"),
      `import pathlib; pathlib.Path(${JSON.stringify(marker)}).write_text("loaded")\n`,
    );
    const vulnerable = spawnSync("python3", ["-c", "pass"], { env: attackEnv });
    expect(vulnerable.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const procRoot = join(root, "proc");
    mkdirSync(join(procRoot, "1"), { recursive: true });
    writeFileSync(
      join(procRoot, "1", "cmdline"),
      Buffer.from("/opt/openshell/bin/openshell-sandbox\0--managed\0"),
    );
    const managedHelper = join(root, "managed-gateway-control.py");
    writeFileSync(
      managedHelper,
      [
        "#!/usr/bin/env python3",
        "import json",
        "import sys",
        'print(json.dumps({"isolated": sys.flags.isolated, "args": sys.argv[1:]}))',
      ].join("\n"),
      { mode: 0o755 },
    );
    const isolated = spawnSync(CONTROL_HELPER, [action, VALID_NONCE], {
      encoding: "utf-8",
      env: {
        ...attackEnv,
        NEMOCLAW_TEST_GATEWAY_CONTROL_PROC_ROOT: procRoot,
        NEMOCLAW_TEST_MANAGED_GATEWAY_CONTROL_HELPER: managedHelper,
        NEMOCLAW_TEST_GATEWAY_CONTROL_CALLER_UID: "0",
      },
    });
    expect(isolated.status, isolated.stderr).toBe(0);
    expect(JSON.parse(isolated.stdout)).toEqual({
      isolated: 1,
      args: [action, VALID_NONCE],
    });
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ["bad action", ["replace", VALID_NONCE], "SUPERVISOR_INVALID_ACTION"],
    ["short nonce", ["restart", "abcd"], "SUPERVISOR_INVALID_NONCE"],
    ["uppercase nonce", ["recover", "B".repeat(64)], "SUPERVISOR_INVALID_NONCE"],
  ])("rejects %s before touching the control directory", (_label, args, marker) => {
    const result = spawnSync(CONTROL_HELPER, args, {
      encoding: "utf-8",
      timeout: 5000,
      env: {
        ...process.env,
        NEMOCLAW_GATEWAY_CONTROL_DIR: join(
          temporaryDirectory("nemoclaw-gateway-helper-invalid-"),
          "absent",
        ),
        NEMOCLAW_TEST_GATEWAY_CONTROL_CALLER_UID: "0",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(marker);
  });

  it("refuses a valid request from a non-root caller", () => {
    const fakeBin = temporaryDirectory("nemoclaw-gateway-helper-path-");
    const fakeId = join(fakeBin, "id");
    writeFileSync(fakeId, '#!/bin/sh\nprintf "1000\\n"\n', { mode: 0o755 });
    const result = spawnSync(CONTROL_HELPER, ["restart", VALID_NONCE], {
      encoding: "utf-8",
      timeout: 5000,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        NEMOCLAW_GATEWAY_CONTROL_DIR: join(fakeBin, "absent"),
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("PRIVILEGED_CONTROL_UNAVAILABLE");
  });
});
